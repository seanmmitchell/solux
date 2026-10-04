import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import type { CookieOptions } from 'hono/utils/cookie';
import type { AppContext } from '../types';
import type { Config } from './config';

export const SESSION_COOKIE = 'solux_session';
export const OIDC_FLOW_COOKIE = 'solux_oidc';
export const OIDC_FLOW_TTL_MS = 10 * 60_000;

/**
 * Over HTTPS cookies use the __Host- prefix (Secure, Path=/, no Domain).
 * Plain-HTTP localhost development gets an unprefixed, non-Secure cookie.
 */
function isHttps(c: AppContext): boolean {
	return new URL(c.req.url).protocol === 'https:';
}

function options(c: AppContext, sameSite: Config['sameSite'], maxAgeSec: number): CookieOptions {
	return isHttps(c)
		? { prefix: 'host', path: '/', secure: true, httpOnly: true, sameSite, maxAge: maxAgeSec }
		: { path: '/', httpOnly: true, sameSite: sameSite === 'None' ? 'Lax' : sameSite, maxAge: maxAgeSec };
}

function read(c: AppContext, name: string): string | undefined {
	return isHttps(c) ? getCookie(c, name, 'host') : getCookie(c, name);
}

function clear(c: AppContext, name: string) {
	deleteCookie(c, name, isHttps(c) ? { prefix: 'host', path: '/', secure: true } : { path: '/' });
}

export const getSessionCookie = (c: AppContext) => read(c, SESSION_COOKIE);
export const setSessionCookie = (c: AppContext, cfg: Config, token: string) =>
	setCookie(c, SESSION_COOKIE, token, options(c, cfg.sameSite, Math.floor(cfg.sessionAbsoluteTtlMs / 1000)));
export const clearSessionCookie = (c: AppContext) => clear(c, SESSION_COOKIE);

// The IdP callback is a cross-site top-level GET, so the flow cookie must be Lax (not Strict).
export const getFlowCookie = (c: AppContext) => read(c, OIDC_FLOW_COOKIE);
export const setFlowCookie = (c: AppContext, state: string) =>
	setCookie(c, OIDC_FLOW_COOKIE, state, options(c, 'Lax', OIDC_FLOW_TTL_MS / 1000));
export const clearFlowCookie = (c: AppContext) => clear(c, OIDC_FLOW_COOKIE);
