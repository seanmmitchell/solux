import { describe, expect, it } from 'vitest';
import { SCHEDULE_GRACE_MS, type SunDay, addDays, dueTarget, localDate, nextTargets, parseSunDays, scheduleTargets } from '../../src/lib/sun';
import { decryptSecret, encryptSecret, randomToken, sha256Hex, timingSafeEqualStr } from '../../src/lib/crypto';
import { decodeCursor, encodeCursor } from '../../src/lib/pagination';
import { resolveReturnTo } from '../../src/lib/returnTo';
import * as v from '../../src/lib/validation';

const KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));

describe('crypto', () => {
	it('round-trips secrets bound to their owner', async () => {
		const blob = await encryptSecret('hunter2', KEY, 'user-1');
		expect(blob).toMatch(/^v1\.[\w-]+\.[\w-]+$/);
		expect(await decryptSecret(blob, KEY, 'user-1')).toBe('hunter2');
		await expect(decryptSecret(blob, KEY, 'user-2')).rejects.toThrow();
		const [ver, iv, ct] = blob.split('.');
		const tampered = `${ver}.${iv}.${ct!.slice(0, -2)}${ct!.endsWith('A') ? 'B' : 'A'}${ct!.slice(-1)}`;
		await expect(decryptSecret(tampered, KEY, 'user-1')).rejects.toThrow();
		expect(await encryptSecret('hunter2', KEY, 'user-1')).not.toBe(blob);
	});

	it('compares strings in constant time and hashes deterministically', async () => {
		expect(await timingSafeEqualStr('abc', 'abc')).toBe(true);
		expect(await timingSafeEqualStr('abc', 'abcd')).toBe(false);
		expect(await sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
		expect(randomToken(32)).toMatch(/^[\w-]{43}$/);
	});
});

describe('sun schedule helpers', () => {
	const MIN = 60_000;
	const days: SunDay[] = [
		{ date: '2026-10-04', sunriseAt: Date.parse('2026-10-04T11:00:00Z'), sunsetAt: Date.parse('2026-10-04T22:00:00Z') },
		{ date: '2026-10-05', sunriseAt: Date.parse('2026-10-05T11:01:00Z'), sunsetAt: Date.parse('2026-10-05T21:58:00Z') },
	];
	const zero = { sunriseOffsetMin: 0, sunsetOffsetMin: 0 };
	const targets = scheduleTargets(days, zero);
	const sunrise = days[0]!.sunriseAt;

	it('computes local dates from the IANA zone, or from longitude', () => {
		const t = Date.parse('2026-07-15T00:30:00Z');
		expect(localDate(t, 'America/New_York', -75)).toBe('2026-07-14');
		expect(localDate(t, 'Asia/Tokyo', 139)).toBe('2026-07-15');
		expect(localDate(t, null, -75.23)).toBe('2026-07-14');
		expect(localDate(t, null, 2)).toBe('2026-07-15');
		expect(localDate(t, 'Not/AZone', -75)).toBe('2026-07-14');
		expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
		expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
	});

	it('orders targets across days and applies offsets', () => {
		expect(targets.map(t => t.action)).toEqual(['off', 'on', 'off', 'on']);
		const shifted = scheduleTargets(days, { sunriseOffsetMin: -480, sunsetOffsetMin: 30 });
		expect(shifted[0]).toEqual({ action: 'off', at: sunrise - 480 * MIN });
	});

	it('fires at or after the target, within the grace period, once', () => {
		expect(dueTarget(sunrise - 1, targets, null)).toBeNull();
		expect(dueTarget(sunrise, targets, null)).toEqual({ action: 'off', at: sunrise });
		expect(dueTarget(sunrise + SCHEDULE_GRACE_MS, targets, null)?.at).toBe(sunrise);
		expect(dueTarget(sunrise + SCHEDULE_GRACE_MS + 1, targets, null)).toBeNull();
		expect(dueTarget(sunrise + MIN, targets, sunrise)).toBeNull();
	});

	it('picks only the latest of several due targets', () => {
		const close = scheduleTargets(days, { sunriseOffsetMin: 658, sunsetOffsetMin: 0 }); // off 21:58, on 22:00
		expect(dueTarget(days[0]!.sunsetAt + MIN, close, null)?.action).toBe('on');
	});

	it('reports the next upcoming times and tolerates bad JSON', () => {
		expect(nextTargets(sunrise + MIN, targets)).toEqual({ offAt: days[1]!.sunriseAt, onAt: days[0]!.sunsetAt });
		expect(nextTargets(Date.parse('2026-10-06T00:00:00Z'), targets)).toEqual({ offAt: null, onAt: null });
		expect(parseSunDays('nope')).toEqual([]);
		expect(parseSunDays('[{"date":"x"}]')).toEqual([]);
	});
});

describe('resolveReturnTo', () => {
	const app = 'https://app.test';
	it('accepts app paths and allowlisted origins', () => {
		expect(resolveReturnTo('/devices?x=1#y', app, [])).toBe('https://app.test/devices?x=1#y');
		expect(resolveReturnTo('https://admin.test/p', app, ['https://admin.test'])).toBe('https://admin.test/p');
		expect(resolveReturnTo(undefined, app, [])).toBe(app);
	});
	it.each(['//evil.test', '/\\evil.test', 'https://evil.test', 'javascript:alert(1)', 'data:text/html,x', '/%0d%0aSet-Cookie:x', '/\u0000'])(
		'rejects %s',
		raw => {
			const out = resolveReturnTo(raw, app, []);
			expect(new URL(out).origin).toBe(app);
		},
	);
});

describe('pagination cursors', () => {
	it('round-trips and rejects garbage', () => {
		const c = { createdAt: 1727000000000, id: 'abc:def' };
		expect(decodeCursor(encodeCursor(c))).toEqual(c);
		expect(decodeCursor(undefined)).toBeNull();
		expect(() => decodeCursor('!!!')).toThrow();
	});
});

describe('validation', () => {
	it('normalises and checks MACs and models', () => {
		expect(v.mac.parse(' aa:bb:cc:dd:ee:ff ')).toBe('AA:BB:CC:DD:EE:FF');
		expect(v.mac.parse('aa:bb:cc:dd:ee:ff:00:11')).toBe('AA:BB:CC:DD:EE:FF:00:11');
		expect(v.mac.safeParse('aa:bb:cc:dd:ee').success).toBe(false);
		expect(v.mac.safeParse('aa-bb-cc-dd-ee-ff').success).toBe(false);
		expect(v.model.safeParse('H6008').success).toBe(true);
		expect(v.model.safeParse('H 6008').success).toBe(false);
	});
	it('checks IANA time zones and coordinates', () => {
		expect(v.timezone.safeParse('Europe/London').success).toBe(true);
		expect(v.timezone.safeParse('Not/AZone').success).toBe(false);
		expect(v.lat.safeParse(90).success).toBe(true);
		expect(v.lat.safeParse(90.1).success).toBe(false);
		expect(v.lon.safeParse(-180).success).toBe(true);
	});
});
