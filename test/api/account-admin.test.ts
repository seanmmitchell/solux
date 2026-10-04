import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import type { UserRow } from '../../src/db/rows';
import { body, call } from '../helpers/app';
import { auditActions, createToken, createUser, loginAs, seedDevice, seedLocation } from '../helpers/factories';
import { createMockIdp } from '../helpers/mockIdp';

const userRow = (id: string) => env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(id).first<UserRow>();

describe('/me', () => {
	it('updates profile fields and validates them strictly', async () => {
		const user = await createUser();
		const cookie = await loginAs(user);
		const ok = await call('/api/v1/me', { method: 'PATCH', cookie, json: { displayName: '  Sam  ', timezone: 'America/New_York' } });
		expect(ok.status).toBe(200);
		expect((await body(ok)).data).toMatchObject({ displayName: 'Sam', timezone: 'America/New_York' });

		const bad = await call('/api/v1/me', { method: 'PATCH', cookie, json: { timezone: 'Mars/Olympus' } });
		expect(bad.status).toBe(400);
		const err = (await body(bad)).error;
		expect(err.code).toBe('VALIDATION_FAILED');
		expect(err.details[0].path).toBe('timezone');

		expect((await call('/api/v1/me', { method: 'PATCH', cookie, json: {} })).status).toBe(400);
		expect((await call('/api/v1/me', { method: 'PATCH', cookie, json: { role: 'admin' } })).status).toBe(400);
	});

	it('stores the Govee key encrypted and never returns it', async () => {
		const user = await createUser();
		const cookie = await loginAs(user);
		const set = await call('/api/v1/me', { method: 'PATCH', cookie, json: { goveeApiKey: 'govee-secret-123' } });
		const data = (await body(set)).data;
		expect(data.hasGoveeKey).toBe(true);
		expect(JSON.stringify(data)).not.toContain('govee-secret-123');
		const stored = (await userRow(user.id))!.govee_key_enc!;
		expect(stored).toMatch(/^v1\./);
		expect(stored).not.toContain('govee-secret-123');

		const cleared = await call('/api/v1/me', { method: 'PATCH', cookie, json: { goveeApiKey: null } });
		expect((await body(cleared)).data.hasGoveeKey).toBe(false);
		expect(await auditActions()).toEqual(expect.arrayContaining(['user.govee_key_set', 'user.govee_key_cleared']));
		const audit = await env.DB.prepare('SELECT metadata FROM audit_events').all<{ metadata: string | null }>();
		expect(JSON.stringify(audit.results)).not.toContain('govee-secret-123');
	});

	it('deletes the account with confirmation, cascading to owned data', async () => {
		const user = await createUser();
		await createUser({ role: 'admin' });
		const cookie = await loginAs(user);
		const loc = await seedLocation(user.id);
		await seedDevice(user.id, loc.id);
		await createToken(user);

		expect((await call('/api/v1/me', { method: 'DELETE', cookie, json: {} })).status).toBe(400);
		const res = await call('/api/v1/me', { method: 'DELETE', cookie, json: { confirm: true } });
		expect(res.status).toBe(204);
		expect(await userRow(user.id)).toBeNull();
		for (const t of ['locations', 'devices', 'api_tokens', 'sessions']) {
			expect(await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${t} WHERE ${t === 'locations' || t === 'devices' ? 'owner_id' : 'user_id'} = ?`).bind(user.id).first('n')).toBe(0);
		}
		expect(await auditActions()).toContain('user.deleted');
	});

	it('refuses to delete the last admin', async () => {
		const boss = await createUser({ role: 'admin' });
		const res = await call('/api/v1/me', { method: 'DELETE', cookie: await loginAs(boss), json: { confirm: true } });
		expect(res.status).toBe(409);
		expect((await body(res)).error.code).toBe('LAST_ADMIN');
	});

	it('shows the user their own audit trail only', async () => {
		const a = await createUser();
		const b = await createUser();
		await call('/api/v1/me', { method: 'PATCH', cookie: await loginAs(a), json: { displayName: 'A' } });
		await call('/api/v1/me', { method: 'PATCH', cookie: await loginAs(b), json: { displayName: 'B' } });
		const res = await body(await call('/api/v1/me/audit', { cookie: await loginAs(a) }));
		expect(res.data).toHaveLength(1);
		expect(res.data[0]).toMatchObject({ action: 'user.updated', actor: { userId: a.id, via: 'session' } });
	});
});

describe('/admin/users', () => {
	it('is admin only', async () => {
		const user = await createUser();
		const res = await call('/api/v1/admin/users', { cookie: await loginAs(user) });
		expect(res.status).toBe(403);
		expect((await body(res)).error.code).toBe('FORBIDDEN');
		expect((await call('/api/v1/admin/users')).status).toBe(401);
	});

	it('lists with search, filters and cursor pagination', async () => {
		const boss = await createUser({ role: 'admin', email: 'boss@corp.test' });
		for (let i = 0; i < 5; i++) await createUser({ email: `member${i}@corp.test` });
		await createUser({ email: 'outsider@else.test', status: 'disabled' });
		const cookie = await loginAs(boss);

		const page1 = await body(await call('/api/v1/admin/users?limit=4', { cookie }));
		expect(page1.data).toHaveLength(4);
		expect(page1.nextCursor).toBeTruthy();
		const page2 = await body(await call(`/api/v1/admin/users?limit=4&cursor=${page1.nextCursor}`, { cookie }));
		expect(page2.data).toHaveLength(3);
		expect(page2.nextCursor).toBeNull();
		const ids = new Set([...page1.data, ...page2.data].map((u: any) => u.id));
		expect(ids.size).toBe(7);

		const search = await body(await call('/api/v1/admin/users?q=MEMBER', { cookie }));
		expect(search.data).toHaveLength(5);
		const wildcard = await body(await call('/api/v1/admin/users?q=%25', { cookie }));
		expect(wildcard.data).toHaveLength(0);
		const disabled = await body(await call('/api/v1/admin/users?status=disabled', { cookie }));
		expect(disabled.data.map((u: any) => u.email)).toEqual(['outsider@else.test']);

		expect((await call('/api/v1/admin/users?cursor=garbage', { cookie })).status).toBe(400);
	});

	it('invites users and rejects duplicates', async () => {
		const cookie = await loginAs(await createUser({ role: 'admin' }));
		const res = await call('/api/v1/admin/users', { cookie, json: { email: 'New@Example.com', role: 'admin' } });
		expect(res.status).toBe(201);
		expect((await body(res)).data).toMatchObject({ email: 'new@example.com', role: 'admin', status: 'invited' });
		expect((await call('/api/v1/admin/users', { cookie, json: { email: 'new@example.com' } })).status).toBe(409);
		expect((await call('/api/v1/admin/users', { cookie, json: { email: 'not-an-email' } })).status).toBe(400);
	});

	it('changes roles and status, revoking sessions on disable', async () => {
		const boss = await createUser({ role: 'admin' });
		const cookie = await loginAs(boss);
		const user = await createUser();
		const userCookie = await loginAs(user);

		const promote = await call(`/api/v1/admin/users/${user.id}`, { method: 'PATCH', cookie, json: { role: 'admin' } });
		expect((await body(promote)).data.role).toBe('admin');
		const disable = await call(`/api/v1/admin/users/${user.id}`, { method: 'PATCH', cookie, json: { status: 'disabled' } });
		expect((await body(disable)).data.status).toBe('disabled');
		expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?').bind(user.id).first('n')).toBe(0);
		expect((await call('/api/v1/me', { cookie: userCookie })).status).toBe(401);
		expect(await auditActions()).toEqual(expect.arrayContaining(['user.role_changed', 'user.status_changed']));
	});

	it('protects the last active admin from demotion, disabling and deletion', async () => {
		const boss = await createUser({ role: 'admin' });
		const cookie = await loginAs(boss);
		for (const json of [{ role: 'user' }, { status: 'disabled' }]) {
			const res = await call(`/api/v1/admin/users/${boss.id}`, { method: 'PATCH', cookie, json });
			expect(res.status).toBe(409);
			expect((await body(res)).error.code).toBe('LAST_ADMIN');
		}
		expect((await call(`/api/v1/admin/users/${boss.id}`, { method: 'DELETE', cookie })).status).toBe(409);

		// A disabled admin doesn't count.
		await createUser({ role: 'admin', status: 'disabled' });
		expect((await call(`/api/v1/admin/users/${boss.id}`, { method: 'PATCH', cookie, json: { role: 'user' } })).status).toBe(409);

		const second = await createUser({ role: 'admin' });
		expect((await call(`/api/v1/admin/users/${second.id}`, { method: 'DELETE', cookie })).status).toBe(204);
		expect((await call(`/api/v1/admin/users/${boss.id}`, { method: 'PATCH', cookie, json: { role: 'user' } })).status).toBe(409);
	});

	it('revokes a user’s sessions and optionally tokens', async () => {
		const cookie = await loginAs(await createUser({ role: 'admin' }));
		const user = await createUser();
		await loginAs(user);
		const token = await createToken(user);
		const res = await call(`/api/v1/admin/users/${user.id}/sessions/revoke`, { cookie, json: { includeTokens: true } });
		expect((await body(res)).data).toEqual({ sessionsRevoked: 1, tokensRevoked: 1 });
		expect((await call('/api/v1/me', { bearer: token })).status).toBe(401);
	});

	it('returns 404 for unknown users', async () => {
		const cookie = await loginAs(await createUser({ role: 'admin' }));
		expect((await call('/api/v1/admin/users/nope', { cookie })).status).toBe(404);
		expect((await call('/api/v1/admin/users/nope', { method: 'PATCH', cookie, json: { role: 'user' } })).status).toBe(404);
	});
});

describe('/admin/audit', () => {
	it('filters by action and actor, and rejects non-admins', async () => {
		const boss = await createUser({ role: 'admin' });
		const cookie = await loginAs(boss);
		const user = await createUser();
		await call(`/api/v1/admin/users/${user.id}`, { method: 'PATCH', cookie, json: { role: 'admin' } });
		await call('/api/v1/me', { method: 'PATCH', cookie: await loginAs(user), json: { displayName: 'U' } });

		const roleChanges = await body(await call('/api/v1/admin/audit?action=user.role_changed', { cookie }));
		expect(roleChanges.data).toHaveLength(1);
		expect(roleChanges.data[0]).toMatchObject({
			actor: { userId: boss.id, via: 'session' },
			target: { type: 'user', id: user.id, userId: user.id },
			metadata: { from: 'user', to: 'admin' },
		});
		const byActor = await body(await call(`/api/v1/admin/audit?actorId=${user.id}`, { cookie }));
		expect(byActor.data.map((e: any) => e.action)).toEqual(['user.updated']);
		const future = await body(await call(`/api/v1/admin/audit?since=${encodeURIComponent(new Date(Date.now() + 60_000).toISOString())}`, { cookie }));
		expect(future.data).toHaveLength(0);

		const other = await createUser();
		expect((await call('/api/v1/admin/audit', { cookie: await loginAs(other) })).status).toBe(403);
	});
});

describe('review fixes: accounts', () => {
	it('/me/audit hides who (and from where) an admin acted on the viewer', async () => {
		const boss = await createUser({ role: 'admin' });
		const user = await createUser();
		await call(`/api/v1/admin/users/${user.id}`, { method: 'PATCH', cookie: await loginAs(boss), ip: '192.0.2.10', json: { displayName: 'Renamed' } });
		const userCookie = await loginAs(user);
		await call('/api/v1/me', { method: 'PATCH', cookie: userCookie, ip: '192.0.2.20', json: { timezone: 'UTC' } });

		const { data } = await body(await call('/api/v1/me/audit', { cookie: userCookie }));
		const byAdmin = data.find((e: any) => e.metadata?.fields?.includes('displayName'));
		const byMe = data.find((e: any) => e.metadata?.fields?.includes('timezone'));
		expect(byAdmin).toMatchObject({ actor: { userId: null, via: 'session' }, ip: null, requestId: null });
		expect(byMe).toMatchObject({ actor: { userId: user.id }, ip: '192.0.2.20' });

		// Admins still see everything.
		const all = await body(await call('/api/v1/admin/audit?action=user.updated', { cookie: await loginAs(boss) }));
		expect(all.data.find((e: any) => e.actor.userId === boss.id)?.ip).toBe('192.0.2.10');
	});

	it('never stores unverified emails, so they cannot squat an invite', async () => {
		const idp = await createMockIdp({ claims: { sub: 'squatter', email: 'ceo@corp.test', email_verified: false } });
		await idp.login();
		const squatter = await env.DB.prepare('SELECT * FROM users').first<UserRow>();
		expect(squatter).toMatchObject({ email: null, email_verified: 0 });
		const identity = await env.DB.prepare('SELECT email FROM identities').first<{ email: string }>();
		expect(identity?.email).toBe('ceo@corp.test');

		const cookie = await loginAs(await createUser({ role: 'admin' }));
		expect((await call('/api/v1/admin/users', { cookie, json: { email: 'ceo@corp.test' } })).status).toBe(201);
	});

	it('enforces one pending invite per email at the database level', async () => {
		const insert = (id: string) =>
			env.DB.prepare("INSERT INTO users (id, email, status, created_at, updated_at) VALUES (?, 'dup@example.com', 'invited', 1, 1)").bind(id).run();
		await insert('a');
		await expect(insert('b')).rejects.toThrow(/UNIQUE/);
	});

	it('disabling a user revokes their API tokens for good', async () => {
		const cookie = await loginAs(await createUser({ role: 'admin' }));
		const user = await createUser();
		const token = await createToken(user);
		await call(`/api/v1/admin/users/${user.id}`, { method: 'PATCH', cookie, json: { status: 'disabled' } });
		await call(`/api/v1/admin/users/${user.id}`, { method: 'PATCH', cookie, json: { status: 'active' } });
		expect((await call('/api/v1/me', { bearer: token })).status).toBe(401);
		expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM api_tokens WHERE user_id = ?').bind(user.id).first('n')).toBe(0);
	});

	it('an ["admin"] token implies write and can change users', async () => {
		const boss = await createUser({ role: 'admin' });
		const res = await call('/api/v1/me/tokens', { cookie: await loginAs(boss), json: { name: 'ops', scopes: ['admin'] } });
		const { data } = await body(res);
		expect(data.scopes).toEqual(['read', 'write', 'admin']);
		const user = await createUser();
		const patch = await call(`/api/v1/admin/users/${user.id}`, { method: 'PATCH', bearer: data.token, json: { displayName: 'Z' } });
		expect(patch.status).toBe(200);
	});

	it('records whether a session was kept when revoking all sessions', async () => {
		const user = await createUser();
		await call('/api/v1/me/sessions', { method: 'DELETE', bearer: await createToken(user) });
		const row = await env.DB.prepare("SELECT metadata FROM audit_events WHERE action = 'session.revoked_all'").first<{ metadata: string }>();
		expect(JSON.parse(row!.metadata)).toEqual({ exceptCurrent: false });
	});

	it('first-user bootstrap needs a completely empty users table', async () => {
		await createUser({ status: 'invited', email: 'pending@example.com' });
		const idp = await createMockIdp({ claims: { sub: 'x', email: 'x@example.com', email_verified: true } });
		const f = await idp.begin();
		const res = await call(`/api/v1/auth/callback?code=${f.code}&state=${f.state}`, { cookie: f.flowCookie }, {
			SOLUX_SIGNUP_POLICY: 'closed',
			SOLUX_FIRST_USER_ADMIN: 'true',
			SOLUX_ADMIN_EMAILS: '',
		});
		expect(new URL(res.headers.get('location')!).searchParams.get('auth_error')).toBe('signup_closed');
	});
});
