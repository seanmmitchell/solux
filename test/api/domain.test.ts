import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { body, call } from '../helpers/app';
import { auditActions, createUser, loginAs, seedDevice, seedLocation } from '../helpers/factories';
import { goveeRoute, installFakeFetch, sunApiRoute } from '../helpers/fakeFetch';

const newLocation = { name: 'Home', lat: 40.2539, lon: -75.2335, timezone: 'America/New_York' };

describe('locations', () => {
	it('creates a location and fetches its sun times in the background', async () => {
		const fake = installFakeFetch([sunApiRoute()]);
		const user = await createUser();
		const cookie = await loginAs(user);
		const res = await call('/api/v1/locations', { cookie, json: newLocation });
		expect(res.status).toBe(201);
		const { data } = await body(res);
		expect(data).toMatchObject({ ownerId: user.id, name: 'Home', lat: 40.2539, timezone: 'America/New_York' });

		const sunCall = fake.calls.find(c => c.url.hostname === 'api.sunrise-sunset.org')!;
		expect(sunCall.url.searchParams.get('tzid')).toBe('America/New_York');
		const fresh = await body(await call(`/api/v1/locations/${data.id}`, { cookie }));
		expect(fresh.data.sun).toMatchObject({ sunriseAt: '2026-10-04T11:00:00.000Z', sunsetAt: '2026-10-04T22:30:00.000Z', error: null });
		expect(await auditActions()).toContain('location.created');
	});

	it('validates input', async () => {
		const cookie = await loginAs(await createUser());
		const res = await call('/api/v1/locations', { cookie, json: { name: '', lat: 91, lon: -181, extra: true } });
		expect(res.status).toBe(400);
		const paths = (await body(res)).error.details.map((d: any) => d.path);
		expect(paths).toEqual(expect.arrayContaining(['name', 'lat', 'lon']));
	});

	it('isolates owners (404, not 403) and lets admins see everything', async () => {
		installFakeFetch([sunApiRoute()]);
		const alice = await createUser();
		const bob = await createUser();
		const boss = await createUser({ role: 'admin' });
		const aliceLoc = await seedLocation(alice.id);
		await seedLocation(bob.id);
		const bobCookie = await loginAs(bob);

		for (const [method, path, json] of [
			['GET', `/api/v1/locations/${aliceLoc.id}`, undefined],
			['PATCH', `/api/v1/locations/${aliceLoc.id}`, { name: 'Mine now' }],
			['DELETE', `/api/v1/locations/${aliceLoc.id}`, undefined],
			['POST', `/api/v1/locations/${aliceLoc.id}/refresh`, undefined],
		] as const) {
			const res = await call(path, { method, cookie: bobCookie, ...(json ? { json } : {}) });
			expect(res.status, `${method} ${path}`).toBe(404);
		}
		const bobList = await body(await call('/api/v1/locations', { cookie: bobCookie }));
		expect(bobList.data).toHaveLength(1);
		expect((await call('/api/v1/locations?all=true', { cookie: bobCookie })).status).toBe(403);
		expect((await call(`/api/v1/locations?ownerId=${alice.id}`, { cookie: bobCookie })).status).toBe(403);

		const bossCookie = await loginAs(boss);
		expect((await body(await call('/api/v1/locations', { cookie: bossCookie }))).data).toHaveLength(0);
		expect((await body(await call('/api/v1/locations?all=true', { cookie: bossCookie }))).data).toHaveLength(2);
		expect((await body(await call(`/api/v1/locations?ownerId=${alice.id}`, { cookie: bossCookie }))).data).toHaveLength(1);
		expect((await call(`/api/v1/locations/${aliceLoc.id}`, { cookie: bossCookie })).status).toBe(200);

		const created = await call('/api/v1/locations', { cookie: bossCookie, json: { ...newLocation, ownerId: alice.id } });
		expect((await body(created)).data.ownerId).toBe(alice.id);
		expect((await call('/api/v1/locations', { cookie: bobCookie, json: { ...newLocation, ownerId: alice.id } })).status).toBe(403);
	});

	it('requires ownerId when created with the break-glass key', async () => {
		installFakeFetch([sunApiRoute()]);
		const res = await call('/api/v1/locations', { breakglass: 'breakglass-test-key-0123456789abcdef', json: newLocation });
		expect(res.status).toBe(400);
		expect((await body(res)).error.details[0].path).toBe('ownerId');
	});

	it('refuses to delete a location in use', async () => {
		const user = await createUser();
		const cookie = await loginAs(user);
		const loc = await seedLocation(user.id);
		const dev = await seedDevice(user.id, loc.id);
		const res = await call(`/api/v1/locations/${loc.id}`, { method: 'DELETE', cookie });
		expect(res.status).toBe(409);
		expect((await body(res)).error.code).toBe('LOCATION_IN_USE');
		await call(`/api/v1/devices/${dev.id}`, { method: 'DELETE', cookie });
		expect((await call(`/api/v1/locations/${loc.id}`, { method: 'DELETE', cookie })).status).toBe(204);
	});

	it('refresh returns fresh times, or 502 while keeping old times on failure', async () => {
		const user = await createUser();
		const cookie = await loginAs(user);
		const loc = await seedLocation(user.id, { sunrise_at: 1, sunset_at: 2 });
		installFakeFetch([sunApiRoute(undefined, undefined, 500)]);
		const failed = await call(`/api/v1/locations/${loc.id}/refresh`, { method: 'POST', cookie });
		expect(failed.status).toBe(502);
		const kept = (await body(await call(`/api/v1/locations/${loc.id}`, { cookie }))).data.sun;
		expect(kept).toMatchObject({ sunriseAt: new Date(1).toISOString(), sunsetAt: new Date(2).toISOString() });
		expect(kept.error).toMatch(/500/);

		installFakeFetch([sunApiRoute()]);
		const ok = await call(`/api/v1/locations/${loc.id}/refresh`, { method: 'POST', cookie });
		expect(ok.status).toBe(200);
		expect((await body(ok)).data.sun.error).toBeNull();
	});
});

describe('devices', () => {
	it('creates devices with normalised MACs and computed schedules', async () => {
		const user = await createUser();
		const cookie = await loginAs(user);
		const sunrise = Date.parse('2026-10-04T11:00:00Z');
		const sunset = Date.parse('2026-10-04T22:30:00Z');
		const loc = await seedLocation(user.id, { sunrise_at: sunrise, sunset_at: sunset });
		const res = await call('/api/v1/devices', {
			cookie,
			json: { name: 'Porch', mac: 'ab:cd:ef:01:23:45:67:89', model: 'H6008', locationId: loc.id, sunsetOffsetMin: -15 },
		});
		expect(res.status).toBe(201);
		const { data } = await body(res);
		expect(data).toMatchObject({
			mac: 'AB:CD:EF:01:23:45:67:89',
			sunriseOffsetMin: 0,
			sunsetOffsetMin: -15,
			enabled: true,
			lastAction: null,
			schedule: { offAt: '2026-10-04T11:00:00.000Z', onAt: '2026-10-04T22:15:00.000Z' },
		});

		const dup = await call('/api/v1/devices', { cookie, json: { name: 'Again', mac: 'AB:CD:EF:01:23:45:67:89', model: 'H6008', locationId: loc.id } });
		expect(dup.status).toBe(409);
		expect((await body(dup)).error.code).toBe('DEVICE_EXISTS');
	});

	it('validates fields and location ownership', async () => {
		const user = await createUser();
		const other = await createUser();
		const cookie = await loginAs(user);
		const foreignLoc = await seedLocation(other.id);
		const bad = await call('/api/v1/devices', { cookie, json: { name: 'x', mac: 'nope', model: '!', locationId: foreignLoc.id, sunriseOffsetMin: 9999 } });
		expect(bad.status).toBe(400);
		expect((await body(bad)).error.details.map((d: any) => d.path)).toEqual(expect.arrayContaining(['mac', 'model', 'sunriseOffsetMin']));

		const foreign = await call('/api/v1/devices', { cookie, json: { name: 'x', mac: 'AA:BB:CC:DD:EE:FF', model: 'H6008', locationId: foreignLoc.id } });
		expect(foreign.status).toBe(400);
		expect((await body(foreign)).error.details[0].path).toBe('locationId');

		const own = await seedLocation(user.id);
		const dev = await seedDevice(user.id, own.id);
		const move = await call(`/api/v1/devices/${dev.id}`, { method: 'PATCH', cookie, json: { locationId: foreignLoc.id } });
		expect(move.status).toBe(400);
		const patch = await call(`/api/v1/devices/${dev.id}`, { method: 'PATCH', cookie, json: { enabled: false, sunriseOffsetMin: 30 } });
		expect((await body(patch)).data).toMatchObject({ enabled: false, sunriseOffsetMin: 30 });
		expect((await call(`/api/v1/devices/${dev.id}`, { method: 'PATCH', cookie, json: { ownerId: other.id } })).status).toBe(400);
	});

	it('isolates owners and filters by location', async () => {
		const alice = await createUser();
		const bob = await createUser();
		const l1 = await seedLocation(alice.id);
		const l2 = await seedLocation(alice.id);
		const d1 = await seedDevice(alice.id, l1.id);
		await seedDevice(alice.id, l2.id);
		const aliceCookie = await loginAs(alice);
		expect((await body(await call('/api/v1/devices', { cookie: aliceCookie }))).data).toHaveLength(2);
		expect((await body(await call(`/api/v1/devices?locationId=${l1.id}`, { cookie: aliceCookie }))).data).toHaveLength(1);
		const bobCookie = await loginAs(bob);
		expect((await body(await call('/api/v1/devices', { cookie: bobCookie }))).data).toHaveLength(0);
		expect((await call(`/api/v1/devices/${d1.id}`, { cookie: bobCookie })).status).toBe(404);
		expect((await call(`/api/v1/devices/${d1.id}/state`, { cookie: bobCookie, json: { on: true } })).status).toBe(404);
	});

	it('switches a light with the owner’s Govee key', async () => {
		const fake = installFakeFetch([goveeRoute()]);
		const user = await createUser({ goveeKey: 'user-govee-key' });
		const cookie = await loginAs(user);
		const loc = await seedLocation(user.id);
		const dev = await seedDevice(user.id, loc.id);
		const res = await call(`/api/v1/devices/${dev.id}/state`, { cookie, json: { on: true } });
		expect(res.status).toBe(200);
		expect((await body(res)).data).toMatchObject({ deviceId: dev.id, on: true });

		const govee = fake.calls.find(c => c.url.hostname === 'developer-api.govee.com')!;
		expect(govee.method).toBe('PUT');
		expect(govee.headers.get('govee-api-key')).toBe('user-govee-key');
		expect(JSON.parse(govee.body)).toEqual({ device: dev.mac, model: dev.model, cmd: { name: 'turn', value: 'on' } });
		const after = (await body(await call(`/api/v1/devices/${dev.id}`, { cookie }))).data;
		expect(after.lastAction).toMatchObject({ state: 'on', source: 'manual', error: null });
		expect(await auditActions()).toContain('device.state_set');
	});

	it('applies the Govee fallback policy and reports upstream failures', async () => {
		const fake = installFakeFetch([goveeRoute()]);
		const user = await createUser();
		const boss = await createUser({ role: 'admin' });
		const userLoc = await seedLocation(user.id);
		const userDev = await seedDevice(user.id, userLoc.id);
		const bossLoc = await seedLocation(boss.id);
		const bossDev = await seedDevice(boss.id, bossLoc.id);

		const missing = await call(`/api/v1/devices/${userDev.id}/state`, { cookie: await loginAs(user), json: { on: false } });
		expect(missing.status).toBe(409);
		expect((await body(missing)).error.code).toBe('GOVEE_KEY_MISSING');

		const bossCookie = await loginAs(boss);
		expect((await call(`/api/v1/devices/${bossDev.id}/state`, { cookie: bossCookie, json: { on: false } })).status).toBe(200);
		expect(fake.calls.at(-1)!.headers.get('govee-api-key')).toBe('operator-govee-key');

		const none = await call(`/api/v1/devices/${bossDev.id}/state`, { cookie: bossCookie, json: { on: false } }, { GOVEE_FALLBACK_POLICY: 'none' });
		expect(none.status).toBe(409);

		installFakeFetch([goveeRoute(500)]);
		const upstream = await call(`/api/v1/devices/${bossDev.id}/state`, { cookie: bossCookie, json: { on: true } });
		expect(upstream.status).toBe(502);
		expect((await body(upstream)).error.code).toBe('UPSTREAM_ERROR');
	});

	it('reports per-user and global stats', async () => {
		const alice = await createUser();
		const boss = await createUser({ role: 'admin' });
		const loc = await seedLocation(alice.id);
		await seedDevice(alice.id, loc.id);
		await seedDevice(alice.id, loc.id, { enabled: 0 });
		const mine = await body(await call('/api/v1/stats', { cookie: await loginAs(alice) }));
		expect(mine.data).toEqual({ locations: 1, devices: 2, enabledDevices: 1 });
		const bossCookie = await loginAs(boss);
		expect((await body(await call('/api/v1/stats', { cookie: bossCookie }))).data).toEqual({ locations: 0, devices: 0, enabledDevices: 0 });
		expect((await body(await call('/api/v1/stats?all=true', { cookie: bossCookie }))).data.devices).toBe(2);
	});
});

describe('legacy KV import', () => {
	async function seedKv() {
		await env.solux.put('loc1', JSON.stringify([
			{ id: 1, name: 'Home', lat: '40.25', lon: '-75.23', sunriseTS: 1000, sunsetTS: 2000, lastUpdated: 3000 },
			{ id: 2, name: 'Bad', lat: 'north', lon: '0' },
		]));
		await env.solux.put('dev1', JSON.stringify([
			{ id: 1, name: 'Porch', mac: 'aa:bb:cc:dd:ee:ff:00:11', model: 'H6008', location: 1, sunriseOffset: 0, sunsetOffset: -10 },
			{ id: 2, name: 'Garage', mac: 'AA:BB:CC:DD:EE:FF:00:22', model: 'H6008', location: 9, sunriseOffset: 0, sunsetOffset: 0 },
		]));
	}

	it('dry-runs, imports idempotently into the caller’s account and reports invalid rows', async () => {
		await seedKv();
		const boss = await createUser({ role: 'admin' });
		const cookie = await loginAs(boss);

		const dry = await body(await call('/api/v1/admin/import/legacy-kv?dryRun=true', { method: 'POST', cookie }));
		expect(dry.data).toMatchObject({ dryRun: true, locations: { created: 1, skipped: 0 }, devices: { created: 1, skipped: 0 } });
		expect(dry.data.locations.invalid).toEqual([expect.objectContaining({ legacyId: 2 })]);
		expect(dry.data.devices.invalid).toEqual([{ legacyId: 2, reason: 'unknown location 9' }]);
		expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM devices').first('n')).toBe(0);

		const real = await body(await call('/api/v1/admin/import/legacy-kv', { method: 'POST', cookie }));
		expect(real.data).toMatchObject({ dryRun: false, locations: { created: 1 }, devices: { created: 1 } });
		const devices = (await body(await call('/api/v1/devices', { cookie }))).data;
		expect(devices).toEqual([expect.objectContaining({ name: 'Porch', mac: 'AA:BB:CC:DD:EE:FF:00:11', sunsetOffsetMin: -10, ownerId: boss.id })]);
		const [loc] = (await body(await call('/api/v1/locations', { cookie }))).data;
		expect(loc).toMatchObject({ name: 'Home', lat: 40.25, lon: -75.23, sun: { sunriseAt: new Date(1000).toISOString() } });
		expect(devices[0].locationId).toBe(loc.id);

		const again = await body(await call('/api/v1/admin/import/legacy-kv', { method: 'POST', cookie }));
		expect(again.data).toMatchObject({ locations: { created: 0, skipped: 1 }, devices: { created: 0, skipped: 1 } });
		expect(await auditActions()).toContain('legacy.imported');
		expect(await env.solux.get('dev1')).not.toBeNull();
	});

	it('requires ownerId with the break-glass key, and admin rights', async () => {
		await seedKv();
		const bg = await call('/api/v1/admin/import/legacy-kv', { method: 'POST', breakglass: 'breakglass-test-key-0123456789abcdef' });
		expect(bg.status).toBe(400);
		const owner = await createUser();
		const ok = await call(`/api/v1/admin/import/legacy-kv?ownerId=${owner.id}`, { method: 'POST', breakglass: 'breakglass-test-key-0123456789abcdef' });
		expect((await body(ok)).data.devices.created).toBe(1);
		expect((await call('/api/v1/admin/import/legacy-kv', { method: 'POST', cookie: await loginAs(owner) })).status).toBe(403);
	});
});
