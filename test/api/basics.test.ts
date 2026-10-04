import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { APP_ORIGIN, body, call } from '../helpers/app';
import { createUser, loginAs, seedDevice, seedLocation } from '../helpers/factories';

describe('basics', () => {
	it('serves health', async () => {
		const res = await call('/api/v1/health');
		expect(res.status).toBe(200);
		expect(await body(res)).toEqual({ data: { status: 'ok', version: '1' } });
		expect(res.headers.get('x-request-id')).toBeTruthy();
		expect(res.headers.get('cache-control')).toBe('no-store');
	});

	it('returns a JSON 404 envelope for unknown routes', async () => {
		const res = await call('/api/v1/nope');
		expect(res.status).toBe(404);
		const b = await body(res);
		expect(b.error.code).toBe('NOT_FOUND');
		expect(b.error.requestId).toBe(res.headers.get('x-request-id'));
		expect((await call('/elsewhere')).status).toBe(404);
	});

	it('rejects malformed JSON and oversized bodies', async () => {
		const user = await createUser();
		const cookie = await loginAs(user);
		const bad = await call('/api/v1/locations', { method: 'POST', cookie, headers: { 'content-type': 'application/json' }, body: '{nope' });
		expect(bad.status).toBe(400);
		expect((await body(bad)).error.code).toBe('BAD_REQUEST');

		const big = await call('/api/v1/locations', { method: 'POST', cookie, headers: { 'content-type': 'application/json' }, body: 'x'.repeat(70 * 1024) });
		expect(big.status).toBe(413);
		expect((await body(big)).error.code).toBe('PAYLOAD_TOO_LARGE');
	});

	it('answers CORS preflight only for allowed origins', async () => {
		const ok = await call('/api/v1/me', {
			method: 'OPTIONS',
			origin: null,
			headers: { origin: APP_ORIGIN, 'access-control-request-method': 'PATCH' },
		});
		expect(ok.status).toBe(204);
		expect(ok.headers.get('access-control-allow-origin')).toBe(APP_ORIGIN);
		expect(ok.headers.get('access-control-allow-credentials')).toBe('true');

		const denied = await call('/api/v1/me', {
			method: 'OPTIONS',
			origin: null,
			headers: { origin: 'https://evil.test', 'access-control-request-method': 'PATCH' },
		});
		expect(denied.headers.get('access-control-allow-origin')).toBeNull();
	});

	it('adds CORS headers to error responses for allowed origins', async () => {
		const res = await call('/api/v1/me', { headers: { origin: APP_ORIGIN } });
		expect(res.status).toBe(401);
		expect(res.headers.get('access-control-allow-origin')).toBe(APP_ORIGIN);
	});

	it('keeps legacy /api/stats and retires the legacy admin API', async () => {
		const owner = await createUser();
		const loc = await seedLocation(owner.id);
		await seedDevice(owner.id, loc.id);
		const stats = await call('/api/stats');
		expect(stats.status).toBe(200);
		expect(stats.headers.get('deprecation')).toBe('true');
		expect(await body(stats)).toEqual({ locations: 1, devices: 1 });

		const gone = await call('/api/admin/dev/lis', { breakglass: 'breakglass-test-key' });
		expect(gone.status).toBe(410);
		expect((await body(gone)).error.code).toBe('GONE');
	});

	it('enforces foreign-key cascades in D1', async () => {
		const owner = await createUser();
		const loc = await seedLocation(owner.id);
		await seedDevice(owner.id, loc.id);
		await loginAs(owner);
		await env.DB.prepare('DELETE FROM users WHERE id = ?').bind(owner.id).run();
		for (const table of ['locations', 'devices', 'sessions']) {
			expect(await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first('n')).toBe(0);
		}
	});

	it('refuses to delete a location that devices reference (FK backstop)', async () => {
		const owner = await createUser();
		const loc = await seedLocation(owner.id);
		await seedDevice(owner.id, loc.id);
		await expect(env.DB.prepare('DELETE FROM locations WHERE id = ?').bind(loc.id).run()).rejects.toThrow(/FOREIGN KEY/);
	});
});
