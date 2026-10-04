import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import type { CookieOptions } from 'hono/utils/cookie';
import type { AppContext } from '../types';
import type { Config } from './config';
import { decryptSecret, encryptSecret } from './crypto';

export const SESSION_COOKIE = 'solux_session';
export const OIDC_FLOW_COOKIE = 'solux_oidc';
export const OIDC_FLOW_TTL_MS = 10 * 60_000;

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * Cookies use the __Host- prefix (Secure, Path=/, no Domain) everywhere except
 * plain-HTTP localhost development. Any other plain-HTTP host still gets Secure
 * cookies, which browsers will refuse — forcing HTTPS rather than downgrading.
 */
function isInsecureLocal(c: AppContext): boolean {
	const url = new URL(c.req.url);
	return url.protocol === 'http:' && LOCAL_HOSTS.has(url.hostname);
}

function options(c: AppContext, sameSite: Config['sameSite'], maxAgeSec: number): CookieOptions {
	return isInsecureLocal(c)
		? { path: '/', httpOnly: true, sameSite: sameSite === 'None' ? 'Lax' : sameSite, maxAge: maxAgeSec }
		: { prefix: 'host', path: '/', secure: true, httpOnly: true, sameSite, maxAge: maxAgeSec };
}

function read(c: AppContext, name: string): string | undefined {
	return isInsecureLocal(c) ? getCookie(c, name) : getCookie(c, name, 'host');
}

function clear(c: AppContext, name: string) {
	deleteCookie(c, name, isInsecureLocal(c) ? { path: '/' } : { prefix: 'host', path: '/', secure: true });
}

export const getSessionCookie = (c: AppContext) => read(c, SESSION_COOKIE);
export const setSessionCookie = (c: AppContext, cfg: Config, token: string) =>
	setCookie(c, SESSION_COOKIE, token, options(c, cfg.sameSite, Math.floor(cfg.sessionAbsoluteTtlMs / 1000)));
export const clearSessionCookie = (c: AppContext) => clear(c, SESSION_COOKIE);

/** Transient OIDC login state. Lives only in an encrypted cookie, so starting a login writes nothing server-side. */
export type OidcFlow = { state: string; nonce: string; codeVerifier: string; returnTo: string; expiresAt: number };

const FLOW_AAD = 'solux-oidc-flow-v1';

// The IdP callback is a cross-site top-level GET, so the flow cookie must be Lax (not Strict).
export async function setFlowCookie(c: AppContext, encKey: string, flow: OidcFlow): Promise<void> {
	const value = await encryptSecret(JSON.stringify(flow), encKey, FLOW_AAD);
	setCookie(c, OIDC_FLOW_COOKIE, value, options(c, 'Lax', OIDC_FLOW_TTL_MS / 1000));
}

/** Decrypts and validates the flow cookie; null if absent, tampered, malformed or expired. */
export async function readFlowCookie(c: AppContext, encKey: string, now = Date.now()): Promise<OidcFlow | null> {
	const raw = read(c, OIDC_FLOW_COOKIE);
	if (!raw) return null;
	try {
		const flow = JSON.parse(await decryptSecret(raw, encKey, FLOW_AAD)) as Partial<OidcFlow>;
		if (
			typeof flow.state !== 'string' ||
			typeof flow.nonce !== 'string' ||
			typeof flow.codeVerifier !== 'string' ||
			typeof flow.returnTo !== 'string' ||
			typeof flow.expiresAt !== 'number' ||
			flow.expiresAt <= now
		) {
			return null;
		}
		return flow as OidcFlow;
	} catch {
		return null;
	}
}

export const clearFlowCookie = (c: AppContext) => clear(c, OIDC_FLOW_COOKIE);
