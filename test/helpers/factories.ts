import { env } from 'cloudflare:workers';
import type { DeviceRow, LocationRow, UserRow } from '../../src/db/rows';
import { getConfig } from '../../src/lib/config';
import { encryptSecret } from '../../src/lib/crypto';
import { createSession } from '../../src/services/sessions';
import { createApiToken } from '../../src/services/tokens';
import type { Role, Scope, UserStatus } from '../../src/types';

let seq = 0;

export async function createUser(opts: { role?: Role; status?: UserStatus; email?: string; goveeKey?: string } = {}): Promise<UserRow> {
	seq++;
	const id = crypto.randomUUID();
	const now = Date.now() + seq; // distinct created_at for stable ordering
	const govee = opts.goveeKey ? await encryptSecret(opts.goveeKey, getConfig(env).encKey!, id) : null;
	await env.DB.prepare(
		`INSERT INTO users (id, email, email_verified, display_name, role, status, govee_key_enc, created_at, updated_at)
		VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?)`,
	)
		.bind(id, opts.email ?? `user${seq}@example.com`, `User ${seq}`, opts.role ?? 'user', opts.status ?? 'active', govee, now, now)
		.run();
	return (await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(id).first<UserRow>())!;
}

/** Returns a Cookie header value for a fresh session. */
export async function loginAs(user: { id: string }): Promise<string> {
	const { token } = await createSession(env.DB, getConfig(env), user.id, { ip: null, userAgent: 'vitest' });
	return `__Host-solux_session=${token}`;
}

export async function createToken(user: { id: string }, scopes: Scope[] = ['read', 'write'], expiresAt: number | null = null): Promise<string> {
	const { token } = await createApiToken(env.DB, user.id, { name: 'test', scopes, expiresAt });
	return token;
}

export async function seedLocation(ownerId: string, overrides: Partial<LocationRow> = {}): Promise<LocationRow> {
	seq++;
	const now = Date.now() + seq;
	const row: LocationRow = {
		id: crypto.randomUUID(),
		owner_id: ownerId,
		name: `Location ${seq}`,
		lat: 40.25,
		lon: -75.23,
		timezone: null,
		sunrise_at: null,
		sunset_at: null,
		sun_updated_at: null,
		sun_error: null,
		legacy_id: null,
		created_at: now,
		updated_at: now,
		...overrides,
	};
	await env.DB.prepare(
		`INSERT INTO locations (id, owner_id, name, lat, lon, timezone, sunrise_at, sunset_at, sun_updated_at, sun_error, legacy_id, created_at, updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	)
		.bind(row.id, row.owner_id, row.name, row.lat, row.lon, row.timezone, row.sunrise_at, row.sunset_at, row.sun_updated_at, row.sun_error, row.legacy_id, row.created_at, row.updated_at)
		.run();
	return row;
}

export async function seedDevice(ownerId: string, locationId: string, overrides: Partial<DeviceRow> = {}): Promise<DeviceRow> {
	seq++;
	const now = Date.now() + seq;
	const hex = seq.toString(16).padStart(2, '0').toUpperCase().slice(-2);
	const row: DeviceRow = {
		id: crypto.randomUUID(),
		owner_id: ownerId,
		location_id: locationId,
		name: `Device ${seq}`,
		mac: `AA:BB:CC:DD:EE:${hex}`,
		model: 'H6008',
		sunrise_offset_min: 0,
		sunset_offset_min: 0,
		enabled: 1,
		last_action: null,
		last_action_at: null,
		last_action_source: null,
		last_error: null,
		legacy_id: null,
		created_at: now,
		updated_at: now,
		...overrides,
	};
	await env.DB.prepare(
		`INSERT INTO devices (id, owner_id, location_id, name, mac, model, sunrise_offset_min, sunset_offset_min, enabled,
			last_action, last_action_at, last_action_source, last_error, legacy_id, created_at, updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	)
		.bind(
			row.id, row.owner_id, row.location_id, row.name, row.mac, row.model, row.sunrise_offset_min, row.sunset_offset_min, row.enabled,
			row.last_action, row.last_action_at, row.last_action_source, row.last_error, row.legacy_id, row.created_at, row.updated_at,
		)
		.run();
	return row;
}

export async function auditActions(): Promise<string[]> {
	const { results } = await env.DB.prepare('SELECT action FROM audit_events ORDER BY created_at, rowid').all<{ action: string }>();
	return results.map(r => r.action);
}
