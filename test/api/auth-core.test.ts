import { env } from 'cloudflare:workers';
import { describe, expect, it, vi } from 'vitest';
import { body, call, setCookies } from '../helpers/app';
import { auditActions, createToken, createUser, loginAs } from '../helpers/factories';

describe('sessions', () => {
	it('authenticates with the session cookie and rejects unknown cookies', async () => {
		const user = await createUser();
		const cookie = await loginAs(user);
		expect((await call('/api/v1/me', { cookie })).status).toBe(200);
		const bogus = await call('/api/v1/me', { cookie: '__Host-solux_session=nope' });
		expect(bogus.status).toBe(401);
		expect(setCookies(bogus).get('__Host-solux_session')?.raw).toMatch(/Max-Age=0/);
	});

	it('expires sessions after the idle timeout and the absolute timeout', async () => {
		const user = await createUser();
		const cookie = await loginAs(user);
		vi.useFakeTimers({ toFake: ['Date'] });
		vi.setSystemTime(Date.now() + 169 * 3_600_000); // idle TTL is 168h
		expect((await call('/api/v1/me', { cookie })).status).toBe(401);

		vi.useRealTimers();
		const cookie2 = await loginAs(user);
		vi.useFakeTimers({ toFake: ['Date'] });
		// Stay active every 6 days so idle never lapses, until the 30-day absolute limit.
		for (let day = 6; day <= 30; day += 6) {
			vi.setSystemTime(Date.now() + 6 * 86_400_000);
			const res = await call('/api/v1/me', { cookie: cookie2 });
			expect(res.status).toBe(day < 30 ? 200 : 401);
		}
	});

	it('lists sessions, marks the current one, and revokes others', async () => {
		const user = await createUser();
		const current = await loginAs(user);
		const other = await loginAs(user);
		const list = await body(await call('/api/v1/me/sessions', { cookie: current }));
		expect(list.data).toHaveLength(2);
		expect(list.data.filter((s: any) => s.current)).toHaveLength(1);

		expect((await call('/api/v1/me/sessions', { method: 'DELETE', cookie: current })).status).toBe(204);
		expect((await call('/api/v1/me', { cookie: other })).status).toBe(401);
		expect((await call('/api/v1/me', { cookie: current })).status).toBe(200);
		expect(await auditActions()).toContain('session.revoked_all');
	});

	it('revokes a single session by id (and 404s for other users)', async () => {
		const user = await createUser();
		const cookie = await loginAs(user);
		const victim = await loginAs(user);
		const stranger = await loginAs(await createUser());
		const list = await body(await call('/api/v1/me/sessions', { cookie }));
		const victimId = list.data.find((s: any) => !s.current).id;
		expect((await call(`/api/v1/me/sessions/${victimId}`, { method: 'DELETE', cookie: stranger })).status).toBe(404);
		expect((await call(`/api/v1/me/sessions/${victimId}`, { method: 'DELETE', cookie })).status).toBe(204);
		expect((await call('/api/v1/me', { cookie: victim })).status).toBe(401);
	});

	it('stops working as soon as the user is disabled', async () => {
		const user = await createUser();
		const cookie = await loginAs(user);
		await env.DB.prepare("UPDATE users SET status = 'disabled' WHERE id = ?").bind(user.id).run();
		expect((await call('/api/v1/me', { cookie })).status).toBe(401);
	});
});

describe('CSRF', () => {
	it('rejects cookie-authenticated mutations from foreign or missing origins', async () => {
		const user = await createUser();
		const cookie = await loginAs(user);
		const patch = (origin: string | null, headers: Record<string, string> = {}) =>
			call('/api/v1/me', { method: 'PATCH', cookie, origin, headers, json: { displayName: 'X' } });

		const foreign = await patch('https://evil.test');
		expect(foreign.status).toBe(403);
		expect((await body(foreign)).error.code).toBe('CSRF_FAILED');
		expect((await patch(null)).status).toBe(403);
		expect((await patch(null, { 'sec-fetch-site': 'same-origin' })).status).toBe(200);
		expect((await patch('https://app.test')).status).toBe(200);
		expect((await patch('https://api.test')).status).toBe(200);
	});

	it('does not apply to bearer tokens', async () => {
		const user = await createUser();
		const token = await createToken(user);
		const res = await call('/api/v1/me', { method: 'PATCH', bearer: token, origin: null, json: { displayName: 'Y' } });
		expect(res.status).toBe(200);
	});
});

describe('API tokens', () => {
	it('mints a token once (session only) and authenticates with it', async () => {
		const user = await createUser();
		const cookie = await loginAs(user);
		const res = await call('/api/v1/me/tokens', { cookie, json: { name: 'ha', scopes: ['write'], expiresInDays: 30 } });
		expect(res.status).toBe(201);
		const { data } = await body(res);
		expect(data.token).toMatch(/^slx_/);
		expect(data.prefix).toBe(data.token.slice(0, 12));
		expect(data.scopes).toEqual(['read', 'write']);

		const me = await call('/api/v1/me', { bearer: data.token });
		expect(me.status).toBe(200);
		const listed = await body(await call('/api/v1/me/tokens', { cookie }));
		expect(listed.data[0]).not.toHaveProperty('token');
		expect(listed.data[0].lastUsedAt).not.toBeNull();

		// Tokens cannot mint tokens or delete the account.
		const minted = await call('/api/v1/me/tokens', { bearer: data.token, json: { name: 'x', scopes: ['read'] } });
		expect(minted.status).toBe(403);
		expect((await body(minted)).error.code).toBe('SESSION_REQUIRED');
		expect(await auditActions()).toContain('token.created');
	});

	it('enforces scopes', async () => {
		const user = await createUser();
		const readOnly = await createToken(user, ['read']);
		expect((await call('/api/v1/me', { bearer: readOnly })).status).toBe(200);
		const write = await call('/api/v1/me', { method: 'PATCH', bearer: readOnly, json: { displayName: 'Z' } });
		expect(write.status).toBe(403);
		expect((await body(write)).error.code).toBe('INSUFFICIENT_SCOPE');
	});

	it('only lets admins mint admin-scoped tokens, and the scope lapses on demotion', async () => {
		const user = await createUser();
		const denied = await call('/api/v1/me/tokens', { cookie: await loginAs(user), json: { name: 'x', scopes: ['admin'] } });
		expect(denied.status).toBe(403);

		const boss = await createUser({ role: 'admin' });
		const res = await call('/api/v1/me/tokens', { cookie: await loginAs(boss), json: { name: 'ops', scopes: ['admin'] } });
		const { token } = (await body(res)).data;
		expect((await call('/api/v1/admin/users', { bearer: token })).status).toBe(200);
		const userToken = await createToken(boss, ['read', 'write']);
		const noScope = await call('/api/v1/admin/users', { bearer: userToken });
		expect((await body(noScope)).error.code).toBe('INSUFFICIENT_SCOPE');

		await createUser({ role: 'admin' }); // keep another admin around
		await env.DB.prepare("UPDATE users SET role = 'user' WHERE id = ?").bind(boss.id).run();
		expect((await call('/api/v1/admin/users', { bearer: token })).status).toBe(403);
	});

	it('rejects expired, revoked, malformed and disabled-owner tokens with 401', async () => {
		const user = await createUser();
		const cookie = await loginAs(user);
		const expired = await createToken(user, ['read'], Date.now() - 1);
		expect((await call('/api/v1/me', { bearer: expired })).status).toBe(401);
		expect((await call('/api/v1/me', { bearer: 'slx_nope' })).status).toBe(401);
		expect((await call('/api/v1/me', { headers: { authorization: 'Basic abc' } })).status).toBe(401);

		const token = await createToken(user);
		const list = await body(await call('/api/v1/me/tokens', { cookie }));
		const id = list.data.find((t: any) => t.expiresAt === null).id;
		expect((await call(`/api/v1/me/tokens/${id}`, { method: 'DELETE', cookie })).status).toBe(204);
		expect((await call('/api/v1/me', { bearer: token })).status).toBe(401);

		const another = await createToken(user);
		await env.DB.prepare("UPDATE users SET status = 'disabled' WHERE id = ?").bind(user.id).run();
		expect((await call('/api/v1/me', { bearer: another })).status).toBe(401);
	});

	it('does not fall back to the cookie when a bad bearer token is sent', async () => {
		const user = await createUser();
		const res = await call('/api/v1/me', { cookie: await loginAs(user), bearer: 'slx_bad' });
		expect(res.status).toBe(401);
	});

	it('caps tokens per user', async () => {
		const user = await createUser();
		const cookie = await loginAs(user);
		for (let i = 0; i < 25; i++) await createToken(user, ['read']);
		const res = await call('/api/v1/me/tokens', { cookie, json: { name: 'one-too-many', scopes: ['read'] } });
		expect(res.status).toBe(409);
		expect((await body(res)).error.code).toBe('TOKEN_LIMIT');
	});
});

describe('break-glass key', () => {
	it('grants admin access, is audited on mutation, and has no user', async () => {
		const res = await call('/api/v1/admin/users', { breakglass: 'breakglass-test-key' });
		expect(res.status).toBe(200);

		const me = await call('/api/v1/me', { breakglass: 'breakglass-test-key' });
		expect(me.status).toBe(403);
		expect((await body(me)).error.code).toBe('USER_REQUIRED');

		const invite = await call('/api/v1/admin/users', { breakglass: 'breakglass-test-key', json: { email: 'x@example.com' } });
		expect(invite.status).toBe(201);
		expect(await auditActions()).toEqual(expect.arrayContaining(['breakglass.used', 'user.created']));
	});

	it('rejects a wrong key, and every key when none is configured', async () => {
		expect((await call('/api/v1/admin/users', { breakglass: 'wrong' })).status).toBe(401);
		expect((await call('/api/v1/admin/users', { breakglass: '' }, { SOLUX_ADM_API_KEY: '' })).status).toBe(401);
	});
});
