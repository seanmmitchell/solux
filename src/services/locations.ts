import type { LocationRow } from '../db/rows';
import { conflict, notFound } from '../lib/errors';
import { type Page, type PageQuery, paginateSql, toPage } from '../lib/pagination';
import { type SunDay, parseSunDays, wantedDates } from '../lib/sun';
import { fetchSunTimes } from '../integrations/sunriseSunset';
import type { Principal } from '../types';
import { type AuditActor, auditStmt } from './audit';
import { canAccess } from './access';

export async function getLocation(db: D1Database, id: string): Promise<LocationRow | null> {
	return db.prepare('SELECT * FROM locations WHERE id = ?').bind(id).first<LocationRow>();
}

/** Loads a location the principal may access, else 404. */
export async function locationFor(db: D1Database, p: Principal, id: string): Promise<LocationRow> {
	const row = await getLocation(db, id);
	if (!row || !canAccess(p, row.owner_id)) throw notFound('Location');
	return row;
}

export async function listLocations(db: D1Database, ownerId: string | null, page: PageQuery): Promise<Page<LocationRow>> {
	const q = ownerId
		? paginateSql('SELECT * FROM locations WHERE owner_id = ?', [ownerId], page)
		: paginateSql('SELECT * FROM locations WHERE 1=1', [], page);
	const { results } = await db.prepare(q.sql).bind(...q.params).all<LocationRow>();
	return toPage(results, page.limit);
}

export type LocationInput = { name: string; lat: number; lon: number; timezone?: string | null | undefined };

export async function createLocation(
	db: D1Database,
	actor: AuditActor,
	ownerId: string,
	input: LocationInput,
	limits: { maxPerUser: number },
	now = Date.now(),
): Promise<LocationRow> {
	const count = await db.prepare('SELECT COUNT(*) AS n FROM locations WHERE owner_id = ?').bind(ownerId).first<number>('n');
	if ((count ?? 0) >= limits.maxPerUser) throw conflict('LIMIT_REACHED', `An account can have at most ${limits.maxPerUser} locations.`);
	const id = crypto.randomUUID();
	await db.batch([
		db
			.prepare('INSERT INTO locations (id, owner_id, name, lat, lon, timezone, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
			.bind(id, ownerId, input.name, input.lat, input.lon, input.timezone ?? null, now, now),
		auditStmt(db, actor, { action: 'location.created', targetType: 'location', targetId: id, targetUserId: ownerId, metadata: { name: input.name } }, now),
	]);
	return (await getLocation(db, id))!;
}

export async function updateLocation(
	db: D1Database,
	actor: AuditActor,
	row: LocationRow,
	patch: Partial<LocationInput>,
	now = Date.now(),
): Promise<{ location: LocationRow; moved: boolean }> {
	const next = {
		name: patch.name ?? row.name,
		lat: patch.lat ?? row.lat,
		lon: patch.lon ?? row.lon,
		timezone: patch.timezone === undefined ? row.timezone : patch.timezone,
	};
	const moved = next.lat !== row.lat || next.lon !== row.lon || next.timezone !== row.timezone;
	const fields = Object.keys(patch).filter(k => patch[k as keyof LocationInput] !== undefined);
	await db.batch([
		// Moving a location invalidates its cached sun times.
		db
			.prepare(
				`UPDATE locations SET name = ?, lat = ?, lon = ?, timezone = ?, updated_at = ?,
					sun_days = CASE WHEN ? THEN NULL ELSE sun_days END
				WHERE id = ?`,
			)
			.bind(next.name, next.lat, next.lon, next.timezone, now, moved ? 1 : 0, row.id),
		auditStmt(db, actor, { action: 'location.updated', targetType: 'location', targetId: row.id, targetUserId: row.owner_id, metadata: { fields } }, now),
	]);
	return { location: (await getLocation(db, row.id))!, moved };
}

export async function deleteLocation(db: D1Database, actor: AuditActor, row: LocationRow, now = Date.now()): Promise<void> {
	const inUse = await db.prepare('SELECT COUNT(*) AS n FROM devices WHERE location_id = ?').bind(row.id).first<number>('n');
	if (inUse) throw conflict('LOCATION_IN_USE', `${inUse} device(s) still use this location. Move or delete them first.`);
	try {
		await db.batch([
			db.prepare('DELETE FROM locations WHERE id = ?').bind(row.id),
			auditStmt(db, actor, { action: 'location.deleted', targetType: 'location', targetId: row.id, targetUserId: row.owner_id, metadata: { name: row.name } }, now),
		]);
	} catch (err) {
		// A device was added concurrently; the foreign key refused the delete.
		if (String(err).includes('FOREIGN KEY')) throw conflict('LOCATION_IN_USE', 'Devices still use this location.');
		throw err;
	}
}

/**
 * Keeps sun times for the location's local yesterday, today and tomorrow,
 * fetching only dates not already stored (or all three with `force`). Failed
 * dates are left out and reported via sun_error; stored dates are kept. The
 * write is skipped if the location moved meanwhile.
 */
export async function refreshSunTimes(
	db: D1Database,
	row: LocationRow,
	opts: { force?: boolean; now?: number } = {},
): Promise<{ location: LocationRow; ok: boolean }> {
	const now = opts.now ?? Date.now();
	const wanted = wantedDates(now, row.timezone, row.lon);
	const stored = new Map(opts.force ? [] : parseSunDays(row.sun_days).map(d => [d.date, d] as const));
	const days: SunDay[] = [];
	let error: string | null = null;
	let fetched = 0;
	for (const date of wanted) {
		const have = stored.get(date);
		if (have) {
			days.push(have);
			continue;
		}
		try {
			days.push({ date, ...(await fetchSunTimes(row.lat, row.lon, date, row.timezone)) });
			fetched++;
		} catch (err) {
			error = String(err instanceof Error ? err.message : err).slice(0, 200);
			console.error(`locations | Sun time fetch for ${row.id} (${row.name}) on ${date} failed: ${error}`);
		}
	}
	const today = days.find(d => d.date === wanted[1]);
	const next: LocationRow = {
		...row,
		sun_days: JSON.stringify(days),
		sunrise_at: today?.sunriseAt ?? row.sunrise_at,
		sunset_at: today?.sunsetAt ?? row.sunset_at,
		sun_updated_at: fetched > 0 ? now : row.sun_updated_at,
		sun_error: error,
	};
	const res = await db
		.prepare(
			`UPDATE locations SET sun_days = ?, sunrise_at = ?, sunset_at = ?, sun_updated_at = ?, sun_error = ?
			WHERE id = ? AND lat = ? AND lon = ? AND timezone IS ?`,
		)
		.bind(next.sun_days, next.sunrise_at, next.sunset_at, next.sun_updated_at, next.sun_error, row.id, row.lat, row.lon, row.timezone)
		.run();
	if (res.meta.changes === 0) return { location: row, ok: false };
	if (fetched > 0) console.log(`locations | Sun times updated for ${row.id} (${row.name}): ${fetched} date(s)`);
	return { location: next, ok: error == null };
}
