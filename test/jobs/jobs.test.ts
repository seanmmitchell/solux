import { createExecutionContext, createScheduledController, waitOnExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { describe, expect, it, vi } from 'vitest';
import type { DeviceRow, LocationRow } from '../../src/db/rows';
import { CRON_OPS, CRON_SUN, handleScheduled } from '../../src/jobs';
import worker from '../../src/worker';
import { body, call } from '../helpers/app';
import { createUser, loginAs, seedDevice, seedLocation } from '../helpers/factories';
import { goveeRoute, installFakeFetch, sunApiRoute } from '../helpers/fakeFetch';

const SUNSET = Date.parse('2026-10-04T22:30:00Z');
const SUNRISE = Date.parse('2026-10-04T11:00:00Z');
const device = (id: string) => env.DB.prepare('SELECT * FROM devices WHERE id = ?').bind(id).first<DeviceRow>();
const goveeCalls = (fake: ReturnType<typeof installFakeFetch>) => fake.calls.filter(c => c.url.hostname === 'developer-api.govee.com');

describe('light operations job', () => {
	it('turns lights on at sunset + offset exactly once per tick, with each owner’s key', async () => {
		const fake = installFakeFetch([goveeRoute()]);
		const alice = await createUser({ goveeKey: 'alice-key' });
		const loc = await seedLocation(alice.id, { sunrise_at: SUNRISE, sunset_at: SUNSET });
		const dev = await seedDevice(alice.id, loc.id, { sunset_offset_min: -15 });
		const late = await seedDevice(alice.id, loc.id, { sunset_offset_min: 30 });

		vi.useFakeTimers({ toFake: ['Date'] });
		vi.setSystemTime(SUNSET - 15 * 60_000 + 60_000);
		const ctx = createExecutionContext();
		await worker.scheduled(createScheduledController({ cron: CRON_OPS, scheduledTime: Date.now() }), env, ctx);
		await waitOnExecutionContext(ctx);

		const calls = goveeCalls(fake);
		expect(calls).toHaveLength(1);
		expect(calls[0]!.headers.get('govee-api-key')).toBe('alice-key');
		expect(JSON.parse(calls[0]!.body).cmd).toEqual({ name: 'turn', value: 'on' });
		expect(await device(dev.id)).toMatchObject({ last_action: 'on', last_action_source: 'schedule', last_error: null });
		expect((await device(late.id))?.last_action).toBeNull();

		// A second tick that still lands inside the window is de-duplicated.
		vi.setSystemTime(SUNSET - 15 * 60_000 - 60_000);
		await handleScheduled(CRON_OPS, env);
		expect(goveeCalls(fake)).toHaveLength(1);
	});

	it('turns lights off at sunrise, honours the window boundary', async () => {
		const fake = installFakeFetch([goveeRoute()]);
		const boss = await createUser({ role: 'admin' }); // falls back to the operator key
		const loc = await seedLocation(boss.id, { sunrise_at: SUNRISE, sunset_at: SUNSET });
		await seedDevice(boss.id, loc.id);

		vi.useFakeTimers({ toFake: ['Date'] });
		vi.setSystemTime(SUNRISE + 2 * 60_000 + 1000);
		await handleScheduled(CRON_OPS, env);
		expect(goveeCalls(fake)).toHaveLength(0);

		vi.setSystemTime(SUNRISE + 2 * 60_000);
		await handleScheduled(CRON_OPS, env);
		const calls = goveeCalls(fake);
		expect(calls).toHaveLength(1);
		expect(JSON.parse(calls[0]!.body).cmd.value).toBe('off');
		expect(calls[0]!.headers.get('govee-api-key')).toBe('operator-govee-key');
	});

	it('skips disabled devices and disabled owners, and isolates failures', async () => {
		const fake = installFakeFetch([
			{ match: (url, init) => url.hostname === 'developer-api.govee.com' && String(init.body ?? '').includes('BB:BB'), respond: () => new Response('down', { status: 503 }) },
			goveeRoute(),
		]);
		const ok = await createUser({ goveeKey: 'k1' });
		const disabledOwner = await createUser({ goveeKey: 'k2', status: 'disabled' });
		const noKey = await createUser();
		const mk = async (ownerId: string, overrides: Partial<DeviceRow> = {}, locOverrides: Partial<LocationRow> = {}) => {
			const loc = await seedLocation(ownerId, { sunrise_at: SUNRISE, sunset_at: SUNSET, ...locOverrides });
			return seedDevice(ownerId, loc.id, overrides);
		};
		const failing = await mk(ok.id, { mac: 'AA:AA:AA:AA:BB:BB' });
		const healthy = await mk(ok.id, { mac: 'AA:AA:AA:AA:CC:CC' });
		const off = await mk(ok.id, { mac: 'AA:AA:AA:AA:DD:DD', enabled: 0 });
		await mk(disabledOwner.id);
		const keyless = await mk(noKey.id);
		const unknownSun = await mk(ok.id, { mac: 'AA:AA:AA:AA:EE:EE' }, { sunrise_at: null, sunset_at: null });

		vi.useFakeTimers({ toFake: ['Date'] });
		vi.setSystemTime(SUNSET);
		await handleScheduled(CRON_OPS, env);

		expect(goveeCalls(fake)).toHaveLength(2);
		expect((await device(failing.id))?.last_error).toMatch(/503/);
		expect(await device(healthy.id)).toMatchObject({ last_action: 'on', last_error: null });
		expect((await device(off.id))?.last_action_at).toBeNull();
		expect((await device(keyless.id))?.last_error).toBe('GOVEE_KEY_MISSING');
		expect((await device(unknownSun.id))?.last_action_at).toBeNull();
	});

	it('can be triggered by an admin through the API', async () => {
		installFakeFetch([goveeRoute()]);
		const boss = await createUser({ role: 'admin' });
		const res = await call('/api/v1/admin/jobs/light-ops', { method: 'POST', cookie: await loginAs(boss) });
		expect((await body(res)).data).toEqual({ checked: 0, actions: 0, errors: 0 });
	});
});

describe('sun refresh job', () => {
	it('updates times on success and keeps old values on failure', async () => {
		installFakeFetch([
			{ match: url => url.hostname === 'api.sunrise-sunset.org' && url.searchParams.get('lat') === '1', respond: () => new Response('x', { status: 500 }) },
			sunApiRoute(),
		]);
		const user = await createUser();
		const good = await seedLocation(user.id, { lat: 10, sunrise_at: 5, sunset_at: 6 });
		const bad = await seedLocation(user.id, { lat: 1, sunrise_at: 5, sunset_at: 6 });
		const disabled = await createUser({ status: 'disabled' });
		await seedLocation(disabled.id, { lat: 1 });

		await handleScheduled(CRON_SUN, env);
		const row = (id: string) => env.DB.prepare('SELECT * FROM locations WHERE id = ?').bind(id).first<LocationRow>();
		expect(await row(good.id)).toMatchObject({ sunrise_at: SUNRISE, sunset_at: SUNSET, sun_error: null });
		expect(await row(bad.id)).toMatchObject({ sunrise_at: 5, sunset_at: 6 });
		expect((await row(bad.id))?.sun_error).toMatch(/500/);
	});

	it('purges expired sessions and old audit rows during housekeeping', async () => {
		installFakeFetch([sunApiRoute()]);
		const user = await createUser();
		await loginAs(user);
		await env.DB.prepare("INSERT INTO audit_events (id, created_at, actor_via, action) VALUES ('old', 1, 'system', 'x')").run();
		vi.useFakeTimers({ toFake: ['Date'] });
		vi.setSystemTime(Date.now() + 31 * 86_400_000);
		await handleScheduled(CRON_SUN, env);
		expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM sessions').first('n')).toBe(0);
		expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE id = 'old'").first('n')).toBe(0);
	});
});
