import type { DeviceWithSunRow, UserRow } from '../db/rows';
import { getConfig } from '../lib/config';
import { type Target, dueTarget, parseSunDays, scheduleTargets } from '../lib/sun';
import { setLightState } from '../integrations/govee';
import { recordFailureStmt, recordSuccessStmt } from '../services/devices';
import { resolveGoveeKey } from '../services/users';

/** Govee calls in flight at once (each has a 10 s timeout). */
const CONCURRENCY = 4;

type OpsRow = DeviceWithSunRow & { owner_role: UserRow['role']; owner_govee_key_enc: string | null };

export type LightOpsResult = { checked: number; actions: number; errors: number };

/**
 * Fires each device's due sunrise/sunset target once. A target is claimed in
 * D1 before calling Govee (so overlapping ticks can't double-fire it) and the
 * claim is released on failure, so the next tick retries until the grace
 * period ends. Manual switches never touch the claim, so they aren't undone.
 */
export async function runLightOps(env: Env, now = Date.now()): Promise<LightOpsResult> {
	const cfg = getConfig(env);
	const db = env.DB;
	const { results: rows } = await db
		.prepare(
			`SELECT d.*, l.sun_days, u.role AS owner_role, u.govee_key_enc AS owner_govee_key_enc
			FROM devices d
			JOIN locations l ON l.id = d.location_id
			JOIN users u ON u.id = d.owner_id
			WHERE d.enabled = 1 AND u.status = 'active'`,
		)
		.all<OpsRow>();

	const work: Array<{ row: OpsRow; target: Target }> = [];
	for (const row of rows) {
		const targets = scheduleTargets(parseSunDays(row.sun_days), { sunriseOffsetMin: row.sunrise_offset_min, sunsetOffsetMin: row.sunset_offset_min });
		const target = dueTarget(now, targets, row.last_target_at);
		if (target) work.push({ row, target });
	}

	const keys = new Map<string, Promise<string | null>>();
	const keyFor = (row: OpsRow) => {
		let key = keys.get(row.owner_id);
		if (!key) {
			key = resolveGoveeKey(cfg, { id: row.owner_id, role: row.owner_role, govee_key_enc: row.owner_govee_key_enc }).catch(err => {
				console.error(`lightOps | Could not decrypt Govee key for owner ${row.owner_id}: ${err}`);
				return null;
			});
			keys.set(row.owner_id, key);
		}
		return key;
	};

	let actions = 0;
	let errors = 0;
	const fire = async ({ row, target }: { row: OpsRow; target: Target }) => {
		const claim = await db
			.prepare('UPDATE devices SET last_target_at = ?1 WHERE id = ?2 AND (last_target_at IS NULL OR last_target_at < ?1)')
			.bind(target.at, row.id)
			.run();
		if (claim.meta.changes === 0) return; // another tick already has it

		const release = (error: string) =>
			db.batch([
				db.prepare('UPDATE devices SET last_target_at = ? WHERE id = ? AND last_target_at = ?').bind(row.last_target_at, row.id, target.at),
				recordFailureStmt(db, row.id, error, now),
			]);

		console.log(`lightOps | Device ${row.id} (${row.name}) -> ${target.action}`);
		const key = await keyFor(row);
		if (!key) {
			errors++;
			await release('GOVEE_KEY_MISSING');
			return;
		}
		try {
			await setLightState(key, row, target.action === 'on');
		} catch (err) {
			errors++;
			const message = String(err instanceof Error ? err.message : err);
			console.error(`lightOps | Device ${row.id} ${target.action} failed: ${message}`);
			await release(message);
			return;
		}
		actions++;
		await recordSuccessStmt(db, row.id, { state: target.action, source: 'schedule' }, now).run();
	};

	const queue = [...work];
	const worker = async () => {
		for (let item = queue.shift(); item; item = queue.shift()) {
			try {
				await fire(item);
			} catch (err) {
				errors++;
				console.error(`lightOps | Device ${item.row.id} failed unexpectedly: ${err}`);
			}
		}
	};
	await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, worker));
	return { checked: rows.length, actions, errors };
}
