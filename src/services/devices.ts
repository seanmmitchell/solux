import type { DeviceRow, DeviceWithSunRow, UserRow } from '../db/rows';
import type { Config } from '../lib/config';
import { conflict, notFound, upstreamError, validationFailed } from '../lib/errors';
import { type Page, type PageQuery, paginateSql, toPage } from '../lib/pagination';
import { GoveeError, setLightState } from '../integrations/govee';
import type { Principal } from '../types';
import { canAccess } from './access';
import { type AuditActor, auditStmt } from './audit';
import { resolveGoveeKey } from './users';

const SELECT_WITH_SUN = 'SELECT d.*, l.sunrise_at, l.sunset_at FROM devices d JOIN locations l ON l.id = d.location_id';

export async function getDevice(db: D1Database, id: string): Promise<DeviceWithSunRow | null> {
	return db.prepare(`${SELECT_WITH_SUN} WHERE d.id = ?`).bind(id).first<DeviceWithSunRow>();
}

/** Loads a device the principal may access, else 404. */
export async function deviceFor(db: D1Database, p: Principal, id: string): Promise<DeviceWithSunRow> {
	const row = await getDevice(db, id);
	if (!row || !canAccess(p, row.owner_id)) throw notFound('Device');
	return row;
}

export async function listDevices(
	db: D1Database,
	ownerId: string | null,
	filters: { locationId?: string | undefined },
	page: PageQuery,
): Promise<Page<DeviceWithSunRow>> {
	let sql = `${SELECT_WITH_SUN} WHERE 1=1`;
	const params: unknown[] = [];
	if (ownerId) {
		sql += ' AND d.owner_id = ?';
		params.push(ownerId);
	}
	if (filters.locationId) {
		sql += ' AND d.location_id = ?';
		params.push(filters.locationId);
	}
	const q = paginateSql(sql, params, page, 'd');
	const { results } = await db.prepare(q.sql).bind(...q.params).all<DeviceWithSunRow>();
	return toPage(results, page.limit);
}

export type DeviceInput = {
	name: string;
	mac: string;
	model: string;
	locationId: string;
	sunriseOffsetMin?: number | undefined;
	sunsetOffsetMin?: number | undefined;
	enabled?: boolean | undefined;
};

async function assertLocationOwnedBy(db: D1Database, locationId: string, ownerId: string): Promise<void> {
	const ok = await db.prepare('SELECT 1 FROM locations WHERE id = ? AND owner_id = ?').bind(locationId, ownerId).first();
	if (!ok) throw validationFailed([{ path: 'locationId', message: "Unknown location, or it belongs to a different owner" }]);
}

async function assertMacFree(db: D1Database, ownerId: string, mac: string, exceptId?: string): Promise<void> {
	const clash = await db.prepare('SELECT id FROM devices WHERE owner_id = ? AND mac = ?').bind(ownerId, mac).first<{ id: string }>();
	if (clash && clash.id !== exceptId) throw conflict('DEVICE_EXISTS', 'A device with this MAC is already registered.');
}

function mapUnique(err: unknown): never {
	if (String(err).includes('UNIQUE constraint failed')) throw conflict('DEVICE_EXISTS', 'A device with this MAC is already registered.');
	throw err;
}

export async function createDevice(db: D1Database, actor: AuditActor, ownerId: string, input: DeviceInput, now = Date.now()): Promise<DeviceWithSunRow> {
	await assertLocationOwnedBy(db, input.locationId, ownerId);
	await assertMacFree(db, ownerId, input.mac);
	const id = crypto.randomUUID();
	await db
		.batch([
			db
				.prepare(
					`INSERT INTO devices (id, owner_id, location_id, name, mac, model, sunrise_offset_min, sunset_offset_min, enabled, created_at, updated_at)
					VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				)
				.bind(
					id,
					ownerId,
					input.locationId,
					input.name,
					input.mac,
					input.model,
					input.sunriseOffsetMin ?? 0,
					input.sunsetOffsetMin ?? 0,
					input.enabled === false ? 0 : 1,
					now,
					now,
				),
			auditStmt(db, actor, { action: 'device.created', targetType: 'device', targetId: id, targetUserId: ownerId, metadata: { name: input.name, mac: input.mac } }, now),
		])
		.catch(mapUnique);
	return (await getDevice(db, id))!;
}

export async function updateDevice(
	db: D1Database,
	actor: AuditActor,
	row: DeviceRow,
	patch: Partial<DeviceInput>,
	now = Date.now(),
): Promise<DeviceWithSunRow> {
	if (patch.locationId !== undefined && patch.locationId !== row.location_id) await assertLocationOwnedBy(db, patch.locationId, row.owner_id);
	if (patch.mac !== undefined && patch.mac !== row.mac) await assertMacFree(db, row.owner_id, patch.mac, row.id);
	const next = {
		name: patch.name ?? row.name,
		mac: patch.mac ?? row.mac,
		model: patch.model ?? row.model,
		location_id: patch.locationId ?? row.location_id,
		sunrise_offset_min: patch.sunriseOffsetMin ?? row.sunrise_offset_min,
		sunset_offset_min: patch.sunsetOffsetMin ?? row.sunset_offset_min,
		enabled: patch.enabled === undefined ? row.enabled : patch.enabled ? 1 : 0,
	};
	const fields = Object.keys(patch).filter(k => patch[k as keyof DeviceInput] !== undefined);
	await db
		.batch([
			db
				.prepare(
					`UPDATE devices SET name = ?, mac = ?, model = ?, location_id = ?, sunrise_offset_min = ?, sunset_offset_min = ?, enabled = ?, updated_at = ?
					WHERE id = ?`,
				)
				.bind(next.name, next.mac, next.model, next.location_id, next.sunrise_offset_min, next.sunset_offset_min, next.enabled, now, row.id),
			auditStmt(db, actor, { action: 'device.updated', targetType: 'device', targetId: row.id, targetUserId: row.owner_id, metadata: { fields } }, now),
		])
		.catch(mapUnique);
	return (await getDevice(db, row.id))!;
}

export async function deleteDevice(db: D1Database, actor: AuditActor, row: DeviceRow, now = Date.now()): Promise<void> {
	await db.batch([
		db.prepare('DELETE FROM devices WHERE id = ?').bind(row.id),
		auditStmt(db, actor, { action: 'device.deleted', targetType: 'device', targetId: row.id, targetUserId: row.owner_id, metadata: { name: row.name, mac: row.mac } }, now),
	]);
}

export function recordActionStmt(
	db: D1Database,
	deviceId: string,
	result: { state: 'on' | 'off'; source: 'schedule' | 'manual'; error: string | null },
	now = Date.now(),
): D1PreparedStatement {
	return result.error
		? db.prepare('UPDATE devices SET last_error = ?, last_action_at = ?, last_action_source = ? WHERE id = ?').bind(result.error, now, result.source, deviceId)
		: db
				.prepare('UPDATE devices SET last_action = ?, last_action_at = ?, last_action_source = ?, last_error = NULL WHERE id = ?')
				.bind(result.state, now, result.source, deviceId);
}

/** Manually switches a device using its owner's Govee key. */
export async function setDeviceState(db: D1Database, cfg: Config, actor: AuditActor, row: DeviceRow, on: boolean, now = Date.now()) {
	const owner = await db.prepare('SELECT * FROM users WHERE id = ?').bind(row.owner_id).first<UserRow>();
	const key = owner ? await resolveGoveeKey(cfg, owner) : null;
	if (!key) throw conflict('GOVEE_KEY_MISSING', "No Govee API key is available for this device's owner. Set one with PATCH /me.");
	const state = on ? 'on' : 'off';
	try {
		await setLightState(key, row, on);
	} catch (err) {
		const message = err instanceof GoveeError ? err.message : `Govee request failed: ${err}`;
		await recordActionStmt(db, row.id, { state, source: 'manual', error: message.slice(0, 200) }, now).run();
		throw upstreamError(message.slice(0, 200));
	}
	await db.batch([
		recordActionStmt(db, row.id, { state, source: 'manual', error: null }, now),
		auditStmt(db, actor, { action: 'device.state_set', targetType: 'device', targetId: row.id, targetUserId: row.owner_id, metadata: { on } }, now),
	]);
	return { deviceId: row.id, on, at: new Date(now).toISOString() };
}

export async function countStats(db: D1Database, ownerId: string | null) {
	const where = ownerId ? 'WHERE owner_id = ?' : '';
	const bind = ownerId ? [ownerId] : [];
	const [loc, dev] = await db.batch<{ n: number; enabled: number }>([
		db.prepare(`SELECT COUNT(*) AS n, 0 AS enabled FROM locations ${where}`).bind(...bind),
		db.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(enabled), 0) AS enabled FROM devices ${where}`).bind(...bind),
	]);
	return {
		locations: loc?.results[0]?.n ?? 0,
		devices: dev?.results[0]?.n ?? 0,
		enabledDevices: dev?.results[0]?.enabled ?? 0,
	};
}
