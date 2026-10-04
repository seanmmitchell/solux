import { describe, expect, it } from 'vitest';
import { ACTION_WINDOW_MS, decideActions } from '../../src/jobs/lightOps';
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

describe('decideActions', () => {
	const at = Date.parse('2026-10-04T11:00:00Z');
	const set = Date.parse('2026-10-04T22:00:00Z');
	const zero = { sunriseOffsetMin: 0, sunsetOffsetMin: 0 };

	it('acts within ±2 minutes inclusive', () => {
		expect(decideActions(at, at, set, zero)).toEqual(['off']);
		expect(decideActions(at + ACTION_WINDOW_MS, at, set, zero)).toEqual(['off']);
		expect(decideActions(at - ACTION_WINDOW_MS, at, set, zero)).toEqual(['off']);
		expect(decideActions(at + ACTION_WINDOW_MS + 1, at, set, zero)).toEqual([]);
		expect(decideActions(set, at, set, zero)).toEqual(['on']);
	});

	it('applies offsets and ignores unknown times', () => {
		expect(decideActions(at + 30 * 60_000, at, set, { sunriseOffsetMin: 30, sunsetOffsetMin: 0 })).toEqual(['off']);
		expect(decideActions(set - 45 * 60_000, at, set, { sunriseOffsetMin: 0, sunsetOffsetMin: -45 })).toEqual(['on']);
		expect(decideActions(at, null, null, zero)).toEqual([]);
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
