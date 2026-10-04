import { Hono } from 'hono';
import { z } from 'zod';
import type { OidcFlowRow } from '../db/rows';
import { type Config, getConfig } from '../lib/config';
import { OIDC_FLOW_TTL_MS, clearFlowCookie, clearSessionCookie, getFlowCookie, getSessionCookie, setFlowCookie, setSessionCookie } from '../lib/cookies';
import { sha256Hex, timingSafeEqualStr } from '../lib/crypto';
import { resolveReturnTo } from '../lib/returnTo';
import { queryParams } from '../middleware/validate';
import { buildLogoutUrl, completeLogin, startLogin } from '../oidc/client';
import { audit, requestMeta } from '../services/audit';
import { createSession, deleteSessionByToken } from '../services/sessions';
import { LoginRejected, loginWithOidc } from '../services/users';
import type { AppContext, AppEnv } from '../types';

export const CALLBACK_PATH = '/api/v1/auth/callback';

const auth = new Hono<AppEnv>();

const appUrlOf = (c: AppContext, cfg: Config) => cfg.appUrl ?? new URL(c.req.url).origin;
const redirectUriOf = (c: AppContext, cfg: Config) => cfg.oidc?.redirectUri ?? `${new URL(c.req.url).origin}${CALLBACK_PATH}`;

function withAuthError(appUrl: string, code: string): string {
	const url = new URL(appUrl);
	url.searchParams.set('auth_error', code);
	return url.toString();
}

auth.get('/login', queryParams(z.object({ returnTo: z.string().max(2048).optional() })), async c => {
	const cfg = getConfig(c.env);
	const appUrl = appUrlOf(c, cfg);
	if (!cfg.oidc) {
		console.error('auth | Login attempted but OIDC is not configured (OIDC_ISSUER / OIDC_CLIENT_ID).');
		return c.redirect(withAuthError(appUrl, 'server_error'), 302);
	}
	let login;
	try {
		login = await startLogin(cfg.oidc, redirectUriOf(c, cfg));
	} catch (err) {
		console.error(`auth | OIDC discovery failed: ${err}`);
		return c.redirect(withAuthError(appUrl, 'idp_error'), 302);
	}
	const now = Date.now();
	const returnTo = resolveReturnTo(c.req.valid('query').returnTo, appUrl, cfg.corsOrigins);
	await c.env.DB.prepare(
		'INSERT INTO oidc_flows (state_hash, code_verifier, nonce, return_to, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)',
	)
		.bind(await sha256Hex(login.state), login.codeVerifier, login.nonce, returnTo, now, now + OIDC_FLOW_TTL_MS)
		.run();
	setFlowCookie(c, login.state);
	return c.redirect(login.url.toString(), 302);
});

auth.get('/callback', async c => {
	const cfg = getConfig(c.env);
	const db = c.env.DB;
	const appUrl = appUrlOf(c, cfg);
	const meta = requestMeta(c);

	const fail = async (code: string, detail?: string) => {
		console.warn(`auth | Login failed: ${code}${detail ? ` (${detail})` : ''}`);
		await audit(db, { userId: null, via: 'system', ...meta }, { action: 'auth.login_failed', metadata: { reason: code } });
		return c.redirect(withAuthError(appUrl, code), 302);
	};

	const url = new URL(c.req.url);
	const state = url.searchParams.get('state');
	const cookieState = getFlowCookie(c);
	clearFlowCookie(c);
	if (!cfg.oidc) return fail('server_error', 'OIDC not configured');
	if (!state || !cookieState || !(await timingSafeEqualStr(state, cookieState))) return fail('invalid_state');

	// Single use: the flow row is consumed whether or not the rest succeeds.
	const flow = await db.prepare('DELETE FROM oidc_flows WHERE state_hash = ? RETURNING *').bind(await sha256Hex(state)).first<OidcFlowRow>();
	if (!flow || flow.expires_at <= Date.now()) return fail('invalid_state');

	const idpError = url.searchParams.get('error');
	if (idpError) return fail(idpError === 'access_denied' ? 'access_denied' : 'idp_error', idpError);

	let claims;
	try {
		claims = await completeLogin(cfg.oidc, redirectUriOf(c, cfg), url.search, { state, nonce: flow.nonce, codeVerifier: flow.code_verifier });
	} catch (err) {
		return fail('idp_error', String(err));
	}

	let user;
	try {
		({ user } = await loginWithOidc(db, cfg, claims));
	} catch (err) {
		if (err instanceof LoginRejected) return fail(err.reason);
		console.error(`auth | Provisioning failed: ${err}`);
		return fail('server_error');
	}

	const { token, session } = await createSession(db, cfg, user.id, meta);
	setSessionCookie(c, cfg, token);
	await audit(db, { userId: user.id, via: 'session', ...meta }, {
		action: 'auth.login',
		targetType: 'session',
		targetId: session.id,
		targetUserId: user.id,
		metadata: { issuer: claims.issuer },
	});
	console.info(`auth | Login success for user ${user.id}`);
	return c.redirect(flow.return_to ?? appUrl, 302);
});

auth.post('/logout', async c => {
	const cfg = getConfig(c.env);
	const db = c.env.DB;
	const cookie = getSessionCookie(c);
	if (cookie) {
		const session = await deleteSessionByToken(db, cookie);
		if (session) {
			await audit(db, { userId: session.user_id, via: 'session', ...requestMeta(c) }, {
				action: 'auth.logout',
				targetType: 'session',
				targetId: session.id,
				targetUserId: session.user_id,
			});
		}
	}
	clearSessionCookie(c);

	let endSessionUrl: string | null = null;
	if (cfg.oidc?.rpLogout) {
		try {
			endSessionUrl = await buildLogoutUrl(cfg.oidc, appUrlOf(c, cfg));
		} catch (err) {
			console.warn(`auth | Could not build IdP logout URL: ${err}`);
		}
	}
	return c.json({ data: { endSessionUrl } });
});

export default auth;
