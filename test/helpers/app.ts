import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { app } from '../../src/app';

export const BASE = 'https://api.test';
export const APP_ORIGIN = 'https://app.test';

export type CallInit = Omit<RequestInit, 'body'> & {
	json?: unknown;
	body?: BodyInit;
	cookie?: string;
	bearer?: string;
	breakglass?: string;
	/** Origin header for mutations; defaults to the app origin, null omits it. */
	origin?: string | null;
	/** Client IP (cf-connecting-ip). Defaults to a random one so rate limits don't couple tests. */
	ip?: string;
	/** Overrides the request origin (default https://api.test). */
	base?: string;
};

const randomIp = () => `198.51.${Math.floor(Math.random() * 256)}.${Math.floor(Math.random() * 256)}`;

/** Calls the Hono app in-process with real bindings and waits for deferred work. */
export async function call(path: string, init: CallInit = {}, envOverride: Partial<Env> = {}): Promise<Response> {
	const headers = new Headers(init.headers);
	let body = init.body;
	if (init.json !== undefined) {
		headers.set('content-type', 'application/json');
		body = JSON.stringify(init.json);
	}
	if (init.cookie) headers.set('cookie', init.cookie);
	if (init.bearer) headers.set('authorization', `Bearer ${init.bearer}`);
	if (init.breakglass !== undefined) headers.set('x-api-token', init.breakglass);
	if (!headers.has('cf-connecting-ip')) headers.set('cf-connecting-ip', init.ip ?? randomIp());
	const method = init.method ?? (init.json !== undefined ? 'POST' : 'GET');
	if (init.origin !== null && !['GET', 'HEAD'].includes(method)) headers.set('origin', init.origin ?? APP_ORIGIN);

	const ctx = createExecutionContext();
	const testEnv = Object.keys(envOverride).length ? { ...env, ...envOverride } : env;
	const res = await app.request(`${init.base ?? BASE}${path}`, { ...init, method, headers, ...(body !== undefined ? { body } : {}) }, testEnv, ctx);
	await waitOnExecutionContext(ctx);
	return res;
}

export async function body<T = any>(res: Response): Promise<T> {
	return (await res.json()) as T;
}

/** Name=value pairs from Set-Cookie headers. */
export function setCookies(res: Response): Map<string, { value: string; raw: string }> {
	const out = new Map<string, { value: string; raw: string }>();
	for (const raw of res.headers.getSetCookie()) {
		const [pair = ''] = raw.split(';');
		const idx = pair.indexOf('=');
		out.set(pair.slice(0, idx), { value: pair.slice(idx + 1), raw });
	}
	return out;
}
