import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import type { UserRow } from '../../src/db/rows';
import { body, call, setCookies } from '../helpers/app';
import { auditActions, createUser, loginAs } from '../helpers/factories';
import { REDIRECT_URI, createMockIdp } from '../helpers/mockIdp';

const BREAKGLASS = 'breakglass-test-key-0123456789abcdef';
const authError = (res: Response) => new URL(res.headers.get('location')!).searchParams.get('auth_error');

async function rowCounts() {
	const out: Record<string, unknown> = {};
	for (const t of ['users', 'identities', 'sessions', 'api_tokens', 'audit_events']) {
		out[t] = await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${t}`).first('n');
	}
	return out;
}

describe('unauthenticated callers write nothing', () => {
	it('login and junk callbacks leave D1 untouched', async () => {
		const idp = await createMockIdp();
		const before = await rowCounts();
		await idp.begin('/somewhere');
		await call('/api/v1/auth/callback');
		await call('/api/v1/auth/callback?state=x&code=y');
		await call('/api/v1/auth/callback?state=x&code=y', { cookie: '__Host-solux_oidc=v1.garbage.garbage' });
		expect(await rowCounts()).toEqual(before);
	});

	it('rejects a tampered flow cookie', async () => {
		const idp = await createMockIdp();
		const b = await idp.begin();
		const value = b.flowCookie.split('=')[1]!;
		const tampered = `__Host-solux_oidc=${value.slice(0, -2)}${value.endsWith('A') ? 'B' : 'A'}${value.slice(-1)}`;
		const res = await call(`/api/v1/auth/callback?code=${b.code}&state=${b.state}`, { cookie: tampered });
		expect(authError(res)).toBe('invalid_state');
	});
});

describe('rate limiting', () => {
	it('limits /auth/* per IP and reports it as an auth_error redirect', async () => {
		await createMockIdp();
		const ip = '203.0.113.7';
		let last: Response | undefined;
		for (let i = 0; i < 21; i++) last = await call('/api/v1/auth/login', { ip });
		expect(authError(last!)).toBe('rate_limited');
		// Other clients are unaffected.
		const other = await call('/api/v1/auth/login', { ip: '203.0.113.8' });
		expect(new URL(other.headers.get('location')!).origin).toBe('https://idp.test');
	});

	it('limits break-glass attempts per IP, including correct ones', async () => {
		const ip = '203.0.113.9';
		for (let i = 0; i < 20; i++) await call('/api/v1/admin/users', { ip, breakglass: 'wrong' });
		const res = await call('/api/v1/admin/users', { ip, breakglass: BREAKGLASS });
		expect(res.status).toBe(429);
		expect((await body(res)).error.code).toBe('RATE_LIMITED');
	});
});

describe('session and cookie hardening', () => {
	it('signs out the previous session on this browser when someone logs in', async () => {
		const previous = await loginAs(await createUser());
		const idp = await createMockIdp();
		const b = await idp.begin();
		const res = await call(`/api/v1/auth/callback?code=${b.code}&state=${b.state}`, { cookie: `${b.flowCookie}; ${previous}` });
		expect(res.status).toBe(302);
		expect(authError(res)).toBeNull();
		expect((await call('/api/v1/me', { cookie: previous })).status).toBe(401);
	});

	it('only plain-HTTP localhost gets non-__Host- cookies', async () => {
		await createMockIdp();
		const remote = await call('/api/v1/auth/login', { base: 'http://api.test' }, { OIDC_REDIRECT_URI: 'http://api.test/api/v1/auth/callback' });
		const remoteFlow = setCookies(remote).get('__Host-solux_oidc');
		expect(remoteFlow?.raw).toMatch(/Secure/);

		const local = await call('/api/v1/auth/login', { base: 'http://localhost:8787' }, { OIDC_REDIRECT_URI: 'http://localhost:8787/api/v1/auth/callback' });
		expect(setCookies(local).get('solux_oidc')?.raw).not.toMatch(/Secure/);
	});

	it('keeps OIDC_REDIRECT_URI byte-for-byte', async () => {
		const idp = await createMockIdp();
		const res = await call('/api/v1/auth/login', {}, { OIDC_REDIRECT_URI: `${REDIRECT_URI}/` });
		expect(new URL(res.headers.get('location')!).searchParams.get('redirect_uri')).toBe(`${REDIRECT_URI}/`);
		expect(idp).toBeTruthy();
	});

	it('accepts email_verified sent as the string "true"', async () => {
		const idp = await createMockIdp({ claims: { sub: 'boss', email: 'boss@example.com', email_verified: 'true' as unknown as boolean } });
		await idp.login();
		const user = await env.DB.prepare('SELECT * FROM users').first<UserRow>();
		expect(user).toMatchObject({ role: 'admin', email_verified: 1 });
	});

	it('rejects session lifetimes beyond the 400-day cookie limit', async () => {
		const me = await call('/api/v1/me', { cookie: '__Host-solux_session=x' }, { SESSION_ABSOLUTE_TTL_HOURS: '10000' });
		expect(me.status).toBe(500);
		expect((await body(me)).error.code).toBe('CONFIG_ERROR');
	});
});

describe('break-glass', () => {
	it('refuses keys shorter than 32 characters, even when they match', async () => {
		const short = 'short-key';
		const res = await call('/api/v1/admin/users', { breakglass: short }, { SOLUX_ADM_API_KEY: short });
		expect(res.status).toBe(401);
	});

	it('audits reads as well as writes', async () => {
		expect((await call('/api/v1/admin/users', { breakglass: BREAKGLASS })).status).toBe(200);
		expect(await auditActions()).toEqual(['breakglass.used']);
		const row = await env.DB.prepare('SELECT metadata FROM audit_events').first<{ metadata: string }>();
		expect(JSON.parse(row!.metadata)).toEqual({ method: 'GET', path: '/api/v1/admin/users' });
	});
});
