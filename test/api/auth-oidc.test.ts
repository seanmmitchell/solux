import { env } from 'cloudflare:workers';
import { describe, expect, it, vi } from 'vitest';
import type { UserRow } from '../../src/db/rows';
import { body, call, setCookies } from '../helpers/app';
import { auditActions, createUser } from '../helpers/factories';
import { CLIENT_ID, REDIRECT_URI, createMockIdp } from '../helpers/mockIdp';

const users = () => env.DB.prepare('SELECT * FROM users ORDER BY created_at').all<UserRow>().then(r => r.results);
const authError = (res: Response) => new URL(res.headers.get('location')!).searchParams.get('auth_error');

describe('OIDC login', () => {
	it('redirects to the IdP with PKCE, state and nonce', async () => {
		const idp = await createMockIdp();
		const { authorize, flowCookie } = await idp.begin();
		expect(authorize.origin + authorize.pathname).toBe('https://idp.test/authorize');
		expect(authorize.searchParams.get('client_id')).toBe(CLIENT_ID);
		expect(authorize.searchParams.get('redirect_uri')).toBe(REDIRECT_URI);
		expect(authorize.searchParams.get('code_challenge_method')).toBe('S256');
		expect(authorize.searchParams.get('scope')).toBe('openid email profile');
		expect(authorize.searchParams.get('nonce')).toBeTruthy();
		expect(flowCookie).toMatch(/^__Host-solux_oidc=/);
	});

	it('creates the user and a hardened session cookie, then redirects to returnTo', async () => {
		const idp = await createMockIdp();
		const { res, cookie, sessionSetCookie } = await idp.login('/devices?tab=2');
		expect(res.status).toBe(302);
		expect(res.headers.get('location')).toBe('https://app.test/devices?tab=2');
		expect(sessionSetCookie).toMatch(/HttpOnly/i);
		expect(sessionSetCookie).toMatch(/Secure/i);
		expect(sessionSetCookie).toMatch(/SameSite=Lax/i);
		expect(sessionSetCookie).toMatch(/Path=\//);
		expect(sessionSetCookie).not.toMatch(/Domain=/i);

		const me = await call('/api/v1/me', { cookie: cookie! });
		expect(me.status).toBe(200);
		const { data } = await body(me);
		expect(data).toMatchObject({ email: 'sam@example.com', emailVerified: true, displayName: 'Sam', role: 'user', status: 'active', hasGoveeKey: false });

		const ids = await call('/api/v1/me/identities', { cookie: cookie! });
		expect((await body(ids)).data).toEqual([expect.objectContaining({ issuer: 'https://idp.test', email: 'sam@example.com' })]);
		expect(await auditActions()).toEqual(['user.created', 'auth.login']);
		// The PKCE verifier and client secret reached the token endpoint (verified by the mock).
		expect(idp.tokenRequests).toHaveLength(1);
	});

	it('reuses the same user on subsequent logins', async () => {
		const idp = await createMockIdp();
		await idp.login();
		await idp.login();
		expect(await users()).toHaveLength(1);
		expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM sessions').first('n')).toBe(2);
	});

	it('ignores open-redirect returnTo values', async () => {
		const idp = await createMockIdp();
		for (const bad of ['//evil.test/x', 'https://evil.test/', '/\\evil.test', 'javascript:alert(1)']) {
			const { res } = await idp.login(bad);
			expect(res.headers.get('location')).toBe('https://app.test');
		}
	});

	it('rejects a state mismatch, a missing flow cookie and a replayed callback', async () => {
		const idp = await createMockIdp();
		const a = await idp.begin();
		const mismatch = await call(`/api/v1/auth/callback?code=${a.code}&state=wrong`, { cookie: a.flowCookie });
		expect(authError(mismatch)).toBe('invalid_state');

		const b = await idp.begin();
		const noCookie = await call(`/api/v1/auth/callback?code=${b.code}&state=${b.state}`);
		expect(authError(noCookie)).toBe('invalid_state');

		const c = await idp.begin();
		const first = await call(`/api/v1/auth/callback?code=${c.code}&state=${c.state}`, { cookie: c.flowCookie });
		expect(setCookies(first).get('__Host-solux_session')?.value).toBeTruthy();
		// Replaying the same callback (even with the old flow cookie) fails: the code is single-use at the IdP.
		const replay = await call(`/api/v1/auth/callback?code=${c.code}&state=${c.state}`, { cookie: c.flowCookie });
		expect(authError(replay)).toBe('idp_error');
		expect(setCookies(replay).get('__Host-solux_session')?.value ?? '').toBe('');
		expect(await auditActions()).toContain('auth.login_failed');
	});

	it('rejects an expired login flow', async () => {
		const idp = await createMockIdp();
		const a = await idp.begin();
		vi.useFakeTimers({ toFake: ['Date'] });
		vi.setSystemTime(Date.now() + 11 * 60_000);
		const res = await call(`/api/v1/auth/callback?code=${a.code}&state=${a.state}`, { cookie: a.flowCookie });
		expect(authError(res)).toBe('invalid_state');
	});

	it.each([
		['wrong audience', { tokenOverrides: { aud: 'someone-else' } }],
		['wrong nonce', { tokenOverrides: { nonce: 'not-the-nonce' } }],
		['wrong issuer', { tokenOverrides: { iss: 'https://other.test' } }],
		['bad signature', { foreignKey: true }],
	])('rejects an ID token with %s', async (_label, knobs) => {
		const idp = await createMockIdp();
		idp.set(knobs);
		const { res, cookie } = await idp.login();
		expect(authError(res)).toBe('idp_error');
		expect(cookie).toBeNull();
		expect(await users()).toHaveLength(0);
	});

	it('maps an IdP access_denied error', async () => {
		const idp = await createMockIdp();
		const a = await idp.begin();
		const res = await call(`/api/v1/auth/callback?error=access_denied&state=${a.state}`, { cookie: a.flowCookie });
		expect(authError(res)).toBe('access_denied');
	});

	describe('sign-up policy', () => {
		it('closed: rejects unknown users but admits SOLUX_ADMIN_EMAILS as admin', async () => {
			const idp = await createMockIdp();
			const closed = { SOLUX_SIGNUP_POLICY: 'closed' };
			const a = await idp.begin();
			const res = await call(`/api/v1/auth/callback?code=${a.code}&state=${a.state}`, { cookie: a.flowCookie }, closed);
			expect(authError(res)).toBe('signup_closed');

			idp.set({ claims: { sub: 'boss', email: 'Boss@Example.com', email_verified: true } });
			const b = await idp.begin();
			const ok = await call(`/api/v1/auth/callback?code=${b.code}&state=${b.state}`, { cookie: b.flowCookie }, closed);
			expect(ok.status).toBe(302);
			expect(authError(ok)).toBeNull();
			const [boss] = await users();
			expect(boss).toMatchObject({ email: 'boss@example.com', role: 'admin' });
		});

		it('does not promote unverified admin emails', async () => {
			const idp = await createMockIdp({ claims: { sub: 'x', email: 'boss@example.com', email_verified: false } });
			await idp.login();
			const [u] = await users();
			expect(u?.role).toBe('user');
		});

		it('domain: only verified emails on allowed domains', async () => {
			const domain = { SOLUX_SIGNUP_POLICY: 'domain', OIDC_ALLOWED_EMAIL_DOMAINS: 'corp.test' };
			const idp = await createMockIdp({ claims: { sub: 'a', email: 'a@other.test', email_verified: true } });
			const attempt = async () => {
				const f = await idp.begin();
				return call(`/api/v1/auth/callback?code=${f.code}&state=${f.state}`, { cookie: f.flowCookie }, domain);
			};
			expect(authError(await attempt())).toBe('email_not_allowed');
			idp.set({ claims: { sub: 'b', email: 'b@corp.test', email_verified: false } });
			expect(authError(await attempt())).toBe('email_unverified');
			idp.set({ claims: { sub: 'c', email: 'c@corp.test', email_verified: true } });
			expect(authError(await attempt())).toBeNull();
		});

		it('links an invited user by verified email and activates them', async () => {
			const invited = await createUser({ status: 'invited', email: 'new@example.com' });
			const idp = await createMockIdp({ claims: { sub: 'new', email: 'new@example.com', email_verified: true } });
			const a = await idp.begin();
			const res = await call(`/api/v1/auth/callback?code=${a.code}&state=${a.state}`, { cookie: a.flowCookie }, { SOLUX_SIGNUP_POLICY: 'closed' });
			expect(authError(res)).toBeNull();
			const all = await users();
			expect(all).toHaveLength(1);
			expect(all[0]).toMatchObject({ id: invited.id, status: 'active' });
		});

		it('first-user bootstrap makes only the first user an admin', async () => {
			const bootstrap = { SOLUX_SIGNUP_POLICY: 'closed', SOLUX_FIRST_USER_ADMIN: 'true', SOLUX_ADMIN_EMAILS: '' };
			const idp = await createMockIdp({ claims: { sub: 'first', email: 'first@example.com', email_verified: true } });
			const login = async () => {
				const f = await idp.begin();
				return call(`/api/v1/auth/callback?code=${f.code}&state=${f.state}`, { cookie: f.flowCookie }, bootstrap);
			};
			expect(authError(await login())).toBeNull();
			idp.set({ claims: { sub: 'second', email: 'second@example.com', email_verified: true } });
			expect(authError(await login())).toBe('signup_closed');
			const all = await users();
			expect(all.map(u => u.role)).toEqual(['admin']);
		});
	});

	it('rejects disabled users', async () => {
		const idp = await createMockIdp();
		await idp.login();
		await env.DB.prepare("UPDATE users SET status = 'disabled'").run();
		const { res, cookie } = await idp.login();
		expect(authError(res)).toBe('account_disabled');
		expect(cookie).toBeNull();
	});

	it('logs out: deletes the session, clears the cookie, and offers the IdP logout URL when enabled', async () => {
		const idp = await createMockIdp();
		const { cookie } = await idp.login();
		const res = await call('/api/v1/auth/logout', { method: 'POST', cookie: cookie! }, { OIDC_RP_LOGOUT: 'true' });
		expect(res.status).toBe(200);
		const { data } = await body(res);
		const endSession = new URL(data.endSessionUrl);
		expect(endSession.origin + endSession.pathname).toBe('https://idp.test/logout');
		expect(endSession.searchParams.get('post_logout_redirect_uri')).toBe('https://app.test');
		expect(setCookies(res).get('__Host-solux_session')?.raw).toMatch(/Max-Age=0/);
		expect((await call('/api/v1/me', { cookie: cookie! })).status).toBe(401);
		expect(await auditActions()).toContain('auth.logout');
	});

	it('redirects with server_error when OIDC is not configured', async () => {
		const res = await call('/api/v1/auth/login', {}, { OIDC_ISSUER: '' });
		expect(res.status).toBe(302);
		expect(authError(res)).toBe('server_error');
	});
});
