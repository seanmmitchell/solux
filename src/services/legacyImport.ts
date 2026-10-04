import { z } from 'zod';
import * as v from '../lib/validation';
import { type AuditActor, auditStmt } from './audit';

// Pre-v1 data lives in KV as JSON arrays under keys like "loc1" and "dev1".
const legacyLocation = z.object({
	id: z.number().int(),
	name: v.name,
	lat: z.coerce.number().pipe(v.lat),
	lon: z.coerce.number().pipe(v.lon),
	sunriseTS: z.number().nullish(),
	sunsetTS: z.number().nullish(),
	lastUpdated: z.number().nullish(),
});

const legacyDevice = z.object({
	id: z.number().int(),
	name: v.name,
	mac: v.mac,
	model: v.model,
	location: z.number().int(),
	sunriseOffset: z.number().int().pipe(v.offsetMin),
	sunsetOffset: z.number().int().pipe(v.offsetMin),
});

type Invalid = { key?: string; legacyId?: number; reason: string };
type Section = { created: number; skipped: number; invalid: Invalid[] };
export type ImportReport = { dryRun: boolean; locations: Section; devices: Section };

const finite = (n: number | null | undefined) => (n != null && Number.isFinite(n) ? n : null);

async function readArrays(kv: KVNamespace, prefix: string, invalid: Invalid[]): Promise<unknown[]> {
	const keyPattern = new RegExp(`^${prefix}\\d+$`);
	const items: unknown[] = [];
	let cursor: string | undefined;
	do {
		const page = await kv.list({ prefix, ...(cursor ? { cursor } : {}) });
		for (const { name } of page.keys) {
			if (!keyPattern.test(name)) continue;
			const raw = await kv.get(name);
			try {
				const parsed: unknown = JSON.parse(raw ?? 'null');
				if (!Array.isArray(parsed)) throw new Error('not a JSON array');
				items.push(...parsed);
			} catch (err) {
				invalid.push({ key: name, reason: `unreadable: ${err instanceof Error ? err.message : err}` });
			}
		}
		cursor = page.list_complete ? undefined : page.cursor;
	} while (cursor);
	return items;
}

const describe = (e: z.ZodError) => e.issues.map(i => `${i.path.join('.') || 'value'}: ${i.message}`).join('; ');

/**
 * Copies legacy KV locations/devices into D1 under `ownerId`. Idempotent: any
 * record imported before (for any owner, even if since deleted) is skipped.
 * KV is not modified.
 */
export async function importLegacyKv(
	env: Env,
	actor: AuditActor,
	ownerId: string,
	opts: { dryRun: boolean; timezone?: string | null | undefined },
	now = Date.now(),
): Promise<ImportReport> {
	const db = env.DB;
	const report: ImportReport = {
		dryRun: opts.dryRun,
		locations: { created: 0, skipped: 0, invalid: [] },
		devices: { created: 0, skipped: 0, invalid: [] },
	};
	const stmts: D1PreparedStatement[] = [];
	// Indexes (into stmts) of the row inserts, to count what was really written.
	const inserted: Array<{ kind: 'locations' | 'devices'; index: number }> = [];
	const ledgerStmt = (kind: 'location' | 'device', legacyId: number) =>
		db.prepare('INSERT INTO legacy_imports (kind, legacy_id, imported_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING').bind(kind, legacyId, now);

	// The ledger remembers every record ever imported, even if the user later deleted it.
	const { results: ledger } = await db.prepare('SELECT kind, legacy_id FROM legacy_imports').all<{ kind: string; legacy_id: number }>();
	const importedLocations = new Set(ledger.filter(l => l.kind === 'location').map(l => l.legacy_id));
	const importedDevices = new Set(ledger.filter(l => l.kind === 'device').map(l => l.legacy_id));

	// legacy location id -> { new id, owner } for locations that still exist
	const locationMap = new Map<number, { id: string; ownerId: string }>();
	const { results: existingLocations } = await db
		.prepare('SELECT id, owner_id, legacy_id FROM locations WHERE legacy_id IS NOT NULL')
		.all<{ id: string; owner_id: string; legacy_id: number }>();
	for (const l of existingLocations) locationMap.set(l.legacy_id, { id: l.id, ownerId: l.owner_id });

	for (const raw of await readArrays(env.solux, 'loc', report.locations.invalid)) {
		const parsed = legacyLocation.safeParse(raw);
		if (!parsed.success) {
			report.locations.invalid.push({ legacyId: (raw as { id?: number })?.id, reason: describe(parsed.error) });
			continue;
		}
		const loc = parsed.data;
		if (importedLocations.has(loc.id)) {
			report.locations.skipped++;
			continue;
		}
		importedLocations.add(loc.id);
		const id = crypto.randomUUID();
		locationMap.set(loc.id, { id, ownerId });
		inserted.push({ kind: 'locations', index: stmts.length });
		stmts.push(
			db
				.prepare(
					`INSERT INTO locations (id, owner_id, name, lat, lon, timezone, sunrise_at, sunset_at, sun_updated_at, legacy_id, created_at, updated_at)
					VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				)
				.bind(id, ownerId, loc.name, loc.lat, loc.lon, opts.timezone ?? null, finite(loc.sunriseTS), finite(loc.sunsetTS), finite(loc.lastUpdated), loc.id, now, now),
			ledgerStmt('location', loc.id),
		);
		report.locations.created++;
	}

	const { results: ownerDevices } = await db.prepare('SELECT mac FROM devices WHERE owner_id = ?').bind(ownerId).all<{ mac: string }>();
	const ownerMacs = new Set(ownerDevices.map(d => d.mac));

	for (const raw of await readArrays(env.solux, 'dev', report.devices.invalid)) {
		const parsed = legacyDevice.safeParse(raw);
		if (!parsed.success) {
			report.devices.invalid.push({ legacyId: (raw as { id?: number })?.id, reason: describe(parsed.error) });
			continue;
		}
		const dev = parsed.data;
		if (importedDevices.has(dev.id)) {
			report.devices.skipped++;
			continue;
		}
		const location = locationMap.get(dev.location);
		if (!location) {
			report.devices.invalid.push({ legacyId: dev.id, reason: `unknown location ${dev.location}` });
			continue;
		}
		if (location.ownerId !== ownerId) {
			report.devices.invalid.push({ legacyId: dev.id, reason: `location ${dev.location} was imported for a different owner` });
			continue;
		}
		if (ownerMacs.has(dev.mac)) {
			report.devices.invalid.push({ legacyId: dev.id, reason: `duplicate MAC ${dev.mac}` });
			continue;
		}
		ownerMacs.add(dev.mac);
		importedDevices.add(dev.id);
		inserted.push({ kind: 'devices', index: stmts.length });
		stmts.push(
			db
				.prepare(
					`INSERT INTO devices (id, owner_id, location_id, name, mac, model, sunrise_offset_min, sunset_offset_min, enabled, legacy_id, created_at, updated_at)
					VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
				)
				.bind(crypto.randomUUID(), ownerId, location.id, dev.name, dev.mac, dev.model, dev.sunriseOffset, dev.sunsetOffset, dev.id, now, now),
			ledgerStmt('device', dev.id),
		);
		report.devices.created++;
	}

	if (!opts.dryRun && stmts.length > 0) {
		// One atomic batch: a concurrent import makes it fail as a whole (unique legacy_id) rather than half-apply.
		const results = await db.batch(stmts);
		report.locations.created = 0;
		report.devices.created = 0;
		for (const { kind, index } of inserted) report[kind].created += results[index]?.meta.changes ?? 0;
		await auditStmt(db, actor, {
			action: 'legacy.imported',
			targetType: 'user',
			targetId: ownerId,
			targetUserId: ownerId,
			metadata: { locations: report.locations.created, devices: report.devices.created },
		}, now).run();
	}
	console.info(`legacyImport | ${opts.dryRun ? 'Dry run' : 'Import'} for ${ownerId}: ${JSON.stringify({ l: report.locations.created, d: report.devices.created })}`);
	return report;
}
