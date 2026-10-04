import type { MiddlewareHandler } from 'hono';
import { getConfig } from '../lib/config';
import { clearSessionCookie, getSessionCookie } from '../lib/cookies';
import { timingSafeEqualStr } from '../lib/crypto';
import { defer } from '../lib/defer';
import { unauthenticated } from '../lib/errors';
import { audit, requestMeta } from '../services/audit';
import { resolveSession, touchSessionStmt } from '../services/sessions';
import { resolveApiToken, touchTokenStmt } from '../services/tokens';
import type { AppEnv, Role, Scope } from '../types';

const ALL_SCOPES: ReadonlySet<Scope> = new Set(['read', 'write', 'admin']);
const USER_SCOPES: ReadonlySet<Scope> = new Set(['read', 'write']);
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

const roleScopes = (role: Role) => (role === 'admin' ? ALL_SCOPES : USER_SCOPES);

/**
 * Resolves the caller, in order: `Authorization: Bearer slx_…` (API token),
 * `x-api-token` (break-glass key), then the session cookie. A presented but
 * invalid bearer or break-glass credential is rejected outright (no fallback).
 */
export const resolvePrincipal: MiddlewareHandler<AppEnv> = async (c, next) => {
	c.set('principal', null);
	const db = c.env.DB;

	const authorization = c.req.header('authorization');
	if (authorization !== undefined) {
		const match = /^Bearer\s+(\S+)$/i.exec(authorization);
		const resolved = match?.[1] ? await resolveApiToken(db, match[1]) : null;
		if (!resolved) throw unauthenticated('Invalid or expired API token.');
		const { token, role } = resolved;
		const scopes = new Set(token.scopes.split(' ').filter((s): s is Scope => ALL_SCOPES.has(s as Scope)));
		// The admin scope only applies while the owner is still an admin.
		if (role !== 'admin') scopes.delete('admin');
		c.set('principal', {
			userId: token.user_id,
			role,
			via: 'token',
			scopes,
			isAdmin: role === 'admin' && scopes.has('admin'),
			tokenId: token.id,
		});
		const touch = touchTokenStmt(db, token);
		if (touch) defer(c, touch.run(), 'token touch');
		return next();
	}

	const breakglass = c.req.header('x-api-token');
	if (breakglass !== undefined) {
		const cfg = getConfig(c.env);
		const ip = c.req.header('cf-connecting-ip');
		const ray = c.req.header('cf-ray');
		if (!cfg.breakglassKey || !(await timingSafeEqualStr(breakglass, cfg.breakglassKey))) {
			console.warn(`principal | Break-glass auth failed. IP: ${ip} | RAY: ${ray}`);
			throw unauthenticated('Invalid API key.');
		}
		console.info(`principal | Break-glass auth success. IP: ${ip} | RAY: ${ray}`);
		c.set('principal', { userId: null, role: 'admin', via: 'breakglass', scopes: ALL_SCOPES, isAdmin: true });
		if (!SAFE_METHODS.has(c.req.method)) {
			defer(
				c,
				audit(db, { userId: null, via: 'breakglass', ...requestMeta(c) }, {
					action: 'breakglass.used',
					metadata: { method: c.req.method, path: c.req.path },
				}),
				'break-glass audit',
			);
		}
		return next();
	}

	const cookie = getSessionCookie(c);
	if (cookie) {
		const resolved = await resolveSession(db, cookie);
		if (!resolved) {
			clearSessionCookie(c);
		} else {
			const { session, role } = resolved;
			const scopes = roleScopes(role);
			c.set('principal', {
				userId: session.user_id,
				role,
				via: 'session',
				scopes,
				isAdmin: role === 'admin',
				sessionId: session.id,
			});
			const touch = touchSessionStmt(db, getConfig(c.env), session);
			if (touch) defer(c, touch.run(), 'session touch');
		}
	}
	return next();
};
