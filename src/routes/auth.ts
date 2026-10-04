import { Hono } from 'hono';
import { z } from 'zod';
import { type Config, getConfig } from '../lib/config';
import { OIDC_FLOW_TTL_MS, clearFlowCookie, clearSessionCookie, getSessionCookie, readFlowCookie, setFlowCookie, setSessionCookie } from '../lib/cookies';
import { timingSafeEqualStr } from '../lib/crypto';
import { ApiError } from '../lib/errors';
import { resolveReturnTo } from '../lib/returnTo';
import { enforceRateLimit } from '../middleware/rateLimit';
import { queryParams } from '../middleware/validate';
import { buildLogoutUrl, completeLogin, startLogin } from '../oidc/client';
import { audit, requestMeta } from '../services/audit';
import { createSession, deleteSessionByToken } from '../services/sessions';
import { LoginRejected, loginWithOidc } from '../services/users';
import type { AppContext, AppEnv } from '../types';

export const CALLBACK_PATH = '/api/v1/auth/callback';
const RETURN_TO_MAX = 1024;

const auth = new Hono<AppEnv>();

const appUrlOf = (c: AppContext, cfg: Config) => cfg.appUrl ?? new URL(c.req.url).origin;
const redirectUriOf = (c: AppContext, cfg: Config) => cfg.oidc?.redirectUri ?? `${new URL(c.req.url).origin}${CALLBACK_PATH}`;

function withAuthError(appUrl: string, code: string): string {
	const url = new URL(appUrl);
	url.searchParams.set('auth_error', code);
	return url.toString();
}

/** Browser-navigation endpoints report rate limiting as an auth_error redirect, not JSON. */
async function rateLimited(c: AppContext): Promise<boolean> {
	try {
		await enforceRateLimit(c, 'auth');
		return false;
	} catch (err) {
		if (err instanceof ApiError && err.status === 429) return true;
		throw err;
	}
}

auth.get('/login', queryParams(z.object({ returnTo: z.string().max(RETURN_TO_MAX).optional() })), async c => {
	const cfg = getConfig(c.env);
	const appUrl = appUrlOf(c, cfg);
	if (await rateLimited(c)) return c.redirect(withAuthError(appUrl, 'rate_limited'), 302);
	if (!cfg.oidc || !cfg.encKey) {
		console.error('auth | Login attempted but OIDC (OIDC_ISSUER / OIDC_CLIENT_ID) or SOLUX_ENC_KEY is not configured.');
		return c.redirect(withAuthError(appUrl, 'server_error'), 302);
	}
	let login;
	try {
		login = await startLogin(cfg.oidc, redirectUriOf(c, cfg));
	} catch (err) {
		console.error(`auth | OIDC discovery failed: ${err}`);
		return c.redirect(withAuthError(appUrl, 'idp_error'), 302);
	}
	// No server-side state: everything the callback needs travels in an encrypted, short-lived cookie.
	await setFlowCookie(c, cfg.encKey, {
		state: login.state,
		nonce: login.nonce,
		codeVerifier: login.codeVerifier,
		returnTo: resolveReturnTo(c.req.valid('query').returnTo, appUrl, cfg.corsOrigins),
		expiresAt: Date.now() + OIDC_FLOW_TTL_MS,
	});
	return c.redirect(login.url.toString(), 302);
});

auth.get('/callback', async c => {
	const cfg = getConfig(c.env);
	const db = c.env.DB;
	const appUrl = appUrlOf(c, cfg);
	const meta = requestMeta(c);

	const fail = async (code: string, opts: { detail?: string; audit?: boolean } = {}) => {
		console.warn(`auth | Login failed: ${code}${opts.detail ? ` (${opts.detail})` : ''}`);
		// Only audit once a valid flow cookie proved this browser started a login; anonymous junk writes nothing.
		if (opts.audit) await audit(db, { userId: null, via: 'system', ...meta }, { action: 'auth.login_failed', metadata: { reason: code } });
		return c.redirect(withAuthError(appUrl, code), 302);
	};

	if (await rateLimited(c)) return fail('rate_limited');
	const url = new URL(c.req.url);
	const state = url.searchParams.get('state');
	const flow = cfg.encKey ? await readFlowCookie(c, cfg.encKey) : null;
	clearFlowCookie(c);
	if (!cfg.oidc || !cfg.encKey) return fail('server_error', { detail: 'OIDC or SOLUX_ENC_KEY not configured' });
	if (!state || !flow || !(await timingSafeEqualStr(state, flow.state))) return fail('invalid_state');

	const idpError = url.searchParams.get('error');
	if (idpError) return fail(idpError === 'access_denied' ? 'access_denied' : 'idp_error', { detail: idpError, audit: true });

	let claims;
	try {
		claims = await completeLogin(cfg.oidc, redirectUriOf(c, cfg), url.search, { state, nonce: flow.nonce, codeVerifier: flow.codeVerifier });
	} catch (err) {
		return fail('idp_error', { detail: String(err), audit: true });
	}

	let user;
	try {
		({ user } = await loginWithOidc(db, cfg, claims));
	} catch (err) {
		if (err instanceof LoginRejected) return fail(err.reason, { audit: true });
		console.error(`auth | Provisioning failed: ${err}`);
		return fail('server_error', { audit: true });
	}

	// Whoever was signed in on this browser before is signed out server-side, not just overwritten.
	const previous = getSessionCookie(c);
	if (previous) await deleteSessionByToken(db, previous);

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
	return c.redirect(flow.returnTo, 302);
});

auth.post('/logout', async c => {
	await enforceRateLimit(c, 'auth');
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
