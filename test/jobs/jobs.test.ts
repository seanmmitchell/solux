import { createExecutionContext, createScheduledController, waitOnExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { describe, expect, it, vi } from 'vitest';
import type { DeviceRow, LocationRow } from '../../src/db/rows';
import { CRON_OPS, CRON_SUN, handleScheduled } from '../../src/jobs';
import { refreshSunTimes } from '../../src/services/locations';
import worker from '../../src/worker';
import { body, call } from '../helpers/app';
import { createUser, loginAs, seedDevice, seedLocation, sunDays } from '../helpers/factories';
import { type Route, goveeRoute, installFakeFetch, json, sunApiRoute } from '../helpers/fakeFetch';

const DAYS = ['2026-10-03', '2026-10-04', '2026-10-05'];
const SUNSET = Date.parse('2026-10-04T22:30:00Z');
const SUNRISE = Date.parse('2026-10-04T11:00:00Z');
const MIN = 60_000;

const device = (id: string) => env.DB.prepare('SELECT * FROM devices WHERE id = ?').bind(id).first<DeviceRow>();
const location = (id: string) => env.DB.prepare('SELECT * FROM locations WHERE id = ?').bind(id).first<LocationRow>();
const goveeCalls = (fake: ReturnType<typeof installFakeFetch>) => fake.calls.filter(c => c.url.hostname === 'developer-api.govee.com');
const sunCalls = (fake: ReturnType<typeof installFakeFetch>) => fake.calls.filter(c => c.url.hostname === 'api.sunrise-sunset.org');
const at = (ms: number) => {
	vi.useFakeTimers({ toFake: ['Date'] });
	vi.setSystemTime(ms);
};
const tick = () => handleScheduled(CRON_OPS, env);

describe('light operations job', () => {
	it('fires sunset + offset once, with the owner’s key, via the scheduled handler', async () => {
		const fake = installFakeFetch([goveeRoute()]);
		const alice = await createUser({ goveeKey: 'alice-key' });
		const loc = await seedLocation(alice.id, { sun_days: sunDays(DAYS) });
		const dev = await seedDevice(alice.id, loc.id, { sunset_offset_min: -15 });
		const later = await seedDevice(alice.id, loc.id, { sunset_offset_min: 30 });

		at(SUNSET - 15 * MIN + MIN);
		const ctx = createExecutionContext();
		await worker.scheduled(createScheduledController({ cron: CRON_OPS, scheduledTime: Date.now() }), env, ctx);
		await waitOnExecutionContext(ctx);

		const calls = goveeCalls(fake);
		expect(calls).toHaveLength(1);
		expect(calls[0]!.headers.get('govee-api-key')).toBe('alice-key');
		expect(JSON.parse(calls[0]!.body).cmd).toEqual({ name: 'turn', value: 'on' });
		expect(await device(dev.id)).toMatchObject({ last_action: 'on', last_action_source: 'schedule', last_error: null, last_target_at: SUNSET - 15 * MIN });
		expect((await device(later.id))?.last_action).toBeNull();

		// The next tick doesn't repeat it.
		at(SUNSET - 15 * MIN + 4 * MIN);
		await tick();
		expect(goveeCalls(fake)).toHaveLength(1);
	});

	it('fires on a late tick, but not once the grace period has passed', async () => {
		const fake = installFakeFetch([goveeRoute()]);
		const boss = await createUser({ role: 'admin' }); // falls back to the operator key
		const loc = await seedLocation(boss.id, { sun_days: sunDays(DAYS) });
		const onTime = await seedDevice(boss.id, loc.id);
		const stale = await seedDevice(boss.id, loc.id, { sunrise_offset_min: -20 });

		at(SUNRISE + 4 * MIN);
		await tick();
		const calls = goveeCalls(fake);
		expect(calls).toHaveLength(1);
		expect(JSON.parse(calls[0]!.body)).toMatchObject({ device: onTime.mac, cmd: { value: 'off' } });
		expect(calls[0]!.headers.get('govee-api-key')).toBe('operator-govee-key');
		expect((await device(stale.id))?.last_action_at).toBeNull();
	});

	it('retries a failed action on the next tick', async () => {
		let attempts = 0;
		const flaky: Route = {
			match: url => url.hostname === 'developer-api.govee.com',
			respond: () => (++attempts === 1 ? new Response('busy', { status: 503 }) : json({ code: 200 })),
		};
		const fake = installFakeFetch([flaky]);
		const user = await createUser({ goveeKey: 'k' });
		const loc = await seedLocation(user.id, { sun_days: sunDays(DAYS) });
		// A manual "on" earlier must not make the failed scheduled "on" look already done.
		const dev = await seedDevice(user.id, loc.id, { last_action: 'on', last_action_source: 'manual', last_action_at: SUNSET - 60 * MIN });

		at(SUNSET + MIN);
		await tick();
		expect(await device(dev.id)).toMatchObject({ last_target_at: null, last_action_source: 'manual' });
		expect((await device(dev.id))?.last_error).toMatch(/503/);

		at(SUNSET + 4 * MIN);
		await tick();
		expect(goveeCalls(fake)).toHaveLength(2);
		expect(await device(dev.id)).toMatchObject({ last_action: 'on', last_action_source: 'schedule', last_error: null, last_target_at: SUNSET });
	});

	it('never undoes a manual switch made after the scheduled one', async () => {
		const fake = installFakeFetch([goveeRoute()]);
		const user = await createUser({ goveeKey: 'k' });
		const cookie = await loginAs(user);
		const loc = await seedLocation(user.id, { sun_days: sunDays(DAYS) });
		const dev = await seedDevice(user.id, loc.id);

		at(SUNSET + MIN);
		await tick();
		at(SUNSET + 2 * MIN);
		expect((await call(`/api/v1/devices/${dev.id}/state`, { cookie, json: { on: false } })).status).toBe(200);
		at(SUNSET + 4 * MIN);
		await tick();

		const values = goveeCalls(fake).map(c => JSON.parse(c.body).cmd.value);
		expect(values).toEqual(['on', 'off']);
		expect(await device(dev.id)).toMatchObject({ last_action: 'off', last_action_source: 'manual' });
	});

	it('acts only on the latest of several due targets (no flapping)', async () => {
		const fake = installFakeFetch([goveeRoute()]);
		const user = await createUser({ goveeKey: 'k' });
		const loc = await seedLocation(user.id, { sun_days: sunDays(DAYS) });
		// off at 22:28 (sunrise + 688 min), on at 22:30
		await seedDevice(user.id, loc.id, { sunrise_offset_min: 688 });
		at(SUNSET + MIN);
		await tick();
		expect(goveeCalls(fake).map(c => JSON.parse(c.body).cmd.value)).toEqual(['on']);
	});

	it('skips disabled devices and owners and isolates failures', async () => {
		const fake = installFakeFetch([
			{ match: (url, init) => url.hostname === 'developer-api.govee.com' && String(init.body ?? '').includes('BB:BB'), respond: () => new Response('down', { status: 503 }) },
			goveeRoute(),
		]);
		const ok = await createUser({ goveeKey: 'k1' });
		const disabledOwner = await createUser({ goveeKey: 'k2', status: 'disabled' });
		const noKey = await createUser();
		const mk = async (ownerId: string, overrides: Partial<DeviceRow> = {}, days: string | null = sunDays(DAYS)) => {
			const loc = await seedLocation(ownerId, { sun_days: days });
			return seedDevice(ownerId, loc.id, overrides);
		};
		const failing = await mk(ok.id, { mac: 'AA:AA:AA:AA:BB:BB' });
		const healthy = await mk(ok.id, { mac: 'AA:AA:AA:AA:CC:CC' });
		const off = await mk(ok.id, { mac: 'AA:AA:AA:AA:DD:DD', enabled: 0 });
		await mk(disabledOwner.id);
		const keyless = await mk(noKey.id);
		const unknownSun = await mk(ok.id, { mac: 'AA:AA:AA:AA:EE:EE' }, null);

		at(SUNSET + MIN);
		await tick();

		expect(goveeCalls(fake)).toHaveLength(2);
		expect((await device(failing.id))?.last_error).toMatch(/503/);
		expect(await device(healthy.id)).toMatchObject({ last_action: 'on', last_error: null });
		expect((await device(off.id))?.last_action_at).toBeNull();
		expect(await device(keyless.id)).toMatchObject({ last_error: 'GOVEE_KEY_MISSING', last_target_at: null });
		expect((await device(unknownSun.id))?.last_error_at).toBeNull();
	});

	it('can be triggered by an admin through the API', async () => {
		installFakeFetch([goveeRoute()]);
		const boss = await createUser({ role: 'admin' });
		const res = await call('/api/v1/admin/jobs/light-ops', { method: 'POST', cookie: await loginAs(boss) });
		expect((await body(res)).data).toEqual({ checked: 0, actions: 0, errors: 0 });
	});
});

describe('date handling (regressions)', () => {
	it('a no-timezone location keeps tonight’s sunset across the 00:00 UTC rollover', async () => {
		// Pennsylvania in July: sunset is ~00:35 UTC on the *next* UTC day.
		const fake = installFakeFetch([
			sunApiRoute({ sunrise: d => `${d}T09:40:00+00:00`, sunset: d => new Date(Date.parse(`${d}T00:35:00Z`) + 86_400_000).toISOString() }),
			goveeRoute(),
		]);
		const user = await createUser({ goveeKey: 'k' });
		const loc = await seedLocation(user.id, { lat: 40.25, lon: -75.23, timezone: null });
		const dev = await seedDevice(user.id, loc.id);

		at(Date.parse('2026-07-15T00:00:00Z')); // the 2-hourly refresh at UTC midnight
		await handleScheduled(CRON_SUN, env);
		expect(sunCalls(fake).map(c => c.url.searchParams.get('date'))).toEqual(['2026-07-13', '2026-07-14', '2026-07-15']);

		at(Date.parse('2026-07-15T00:36:00Z'));
		await tick();
		expect(goveeCalls(fake)).toHaveLength(1);
		expect(await device(dev.id)).toMatchObject({ last_action: 'on', last_target_at: Date.parse('2026-07-15T00:35:00Z') });
	});

	it('fires offsets that cross local midnight', async () => {
		const fake = installFakeFetch([sunApiRoute(), goveeRoute()]);
		const user = await createUser({ goveeKey: 'k' });
		const loc = await seedLocation(user.id, { timezone: 'America/New_York' });
		// Sunrise 11:00Z (07:00 EDT) - 8h = 03:00Z, i.e. 23:00 local on the previous day.
		const dev = await seedDevice(user.id, loc.id, { sunrise_offset_min: -480 });

		at(Date.parse('2026-10-04T02:00:00Z')); // 22:00 local on 10-03
		await handleScheduled(CRON_SUN, env);
		at(Date.parse('2026-10-04T03:01:00Z'));
		await tick();
		expect(goveeCalls(fake)).toHaveLength(1);
		expect((await device(dev.id))?.last_target_at).toBe(Date.parse('2026-10-04T03:00:00Z'));
	});
});

describe('sun refresh job', () => {
	it('fetches only dates it does not already have', async () => {
		const fake = installFakeFetch([sunApiRoute()]);
		const user = await createUser();
		const loc = await seedLocation(user.id, { timezone: 'UTC', lon: 0 });

		at(Date.parse('2026-10-04T12:00:00Z'));
		await handleScheduled(CRON_SUN, env);
		expect(sunCalls(fake)).toHaveLength(3);
		at(Date.parse('2026-10-04T14:00:00Z'));
		await handleScheduled(CRON_SUN, env);
		expect(sunCalls(fake)).toHaveLength(3);
		at(Date.parse('2026-10-05T00:00:00Z'));
		await handleScheduled(CRON_SUN, env);
		expect(sunCalls(fake).map(c => c.url.searchParams.get('date')).slice(3)).toEqual(['2026-10-06']);

		const row = await location(loc.id);
		expect(JSON.parse(row!.sun_days!).map((d: { date: string }) => d.date)).toEqual(['2026-10-04', '2026-10-05', '2026-10-06']);
		expect(row).toMatchObject({ sunrise_at: Date.parse('2026-10-05T11:00:00Z'), sun_error: null });
	});

	it('keeps previous values on failure and records the error', async () => {
		installFakeFetch([
			{ match: url => url.hostname === 'api.sunrise-sunset.org' && url.searchParams.get('lat') === '1', respond: () => new Response('x', { status: 500 }) },
			sunApiRoute(),
		]);
		const user = await createUser();
		const good = await seedLocation(user.id, { lat: 10, lon: 0, timezone: 'UTC', sunrise_at: 5, sunset_at: 6 });
		const bad = await seedLocation(user.id, { lat: 1, sunrise_at: 5, sunset_at: 6 });
		const disabled = await createUser({ status: 'disabled' });
		await seedLocation(disabled.id, { lat: 1 });

		at(SUNRISE);
		await handleScheduled(CRON_SUN, env);
		expect(await location(good.id)).toMatchObject({ sunrise_at: SUNRISE, sunset_at: SUNSET, sun_error: null });
		expect(await location(bad.id)).toMatchObject({ sunrise_at: 5, sunset_at: 6 });
		expect((await location(bad.id))?.sun_error).toMatch(/500/);
	});

	it('does not overwrite a location that moved while a refresh was in flight', async () => {
		installFakeFetch([sunApiRoute()]);
		const user = await createUser();
		const stale = await seedLocation(user.id, { lat: 10 });
		await env.DB.prepare('UPDATE locations SET lat = 20 WHERE id = ?').bind(stale.id).run();
		const { ok } = await refreshSunTimes(env.DB, stale);
		expect(ok).toBe(false);
		expect((await location(stale.id))?.sun_days).toBeNull();
	});

	it('purges expired sessions and old audit rows during housekeeping', async () => {
		installFakeFetch([sunApiRoute()]);
		const user = await createUser();
		await loginAs(user);
		await env.DB.prepare("INSERT INTO audit_events (id, created_at, actor_via, action) VALUES ('old', 1, 'system', 'x')").run();
		at(Date.now() + 31 * 86_400_000);
		await handleScheduled(CRON_SUN, env);
		expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM sessions').first('n')).toBe(0);
		expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE id = 'old'").first('n')).toBe(0);
	});
});
