import type { DeviceWithSunRow, UserRow } from '../db/rows';
import { getConfig } from '../lib/config';
import { setLightState } from '../integrations/govee';
import { recordActionStmt } from '../services/devices';
import { resolveGoveeKey } from '../services/users';

/** A device acts when "now" is within this many ms of its offset sunrise/sunset. */
export const ACTION_WINDOW_MS = 2 * 60_000;
/** Don't repeat the same scheduled action within this period (two 3-minute ticks can land in one window). */
export const DEDUPE_MS = 10 * 60_000;

export type LightAction = 'off' | 'on';

/** Lights go off at sunrise + offset and on at sunset + offset. */
export function decideActions(
	now: number,
	sunriseAt: number | null,
	sunsetAt: number | null,
	offsets: { sunriseOffsetMin: number; sunsetOffsetMin: number },
): LightAction[] {
	const actions: LightAction[] = [];
	if (sunriseAt != null && Math.abs(sunriseAt + offsets.sunriseOffsetMin * 60_000 - now) <= ACTION_WINDOW_MS) actions.push('off');
	if (sunsetAt != null && Math.abs(sunsetAt + offsets.sunsetOffsetMin * 60_000 - now) <= ACTION_WINDOW_MS) actions.push('on');
	return actions;
}

type OpsRow = DeviceWithSunRow & { owner_role: UserRow['role']; owner_govee_key_enc: string | null };

export type LightOpsResult = { checked: number; actions: number; errors: number };

/** Applies scheduled on/off actions for every enabled device of every active user. */
export async function runLightOps(env: Env, now = Date.now()): Promise<LightOpsResult> {
	const cfg = getConfig(env);
	const db = env.DB;
	const { results: rows } = await db
		.prepare(
			`SELECT d.*, l.sunrise_at, l.sunset_at, u.role AS owner_role, u.govee_key_enc AS owner_govee_key_enc
			FROM devices d
			JOIN locations l ON l.id = d.location_id
			JOIN users u ON u.id = d.owner_id
			WHERE d.enabled = 1 AND u.status = 'active'`,
		)
		.all<OpsRow>();

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

	const writes: D1PreparedStatement[] = [];
	let actions = 0;
	let errors = 0;
	for (const row of rows) {
		for (const action of decideActions(now, row.sunrise_at, row.sunset_at, { sunriseOffsetMin: row.sunrise_offset_min, sunsetOffsetMin: row.sunset_offset_min })) {
			if (row.last_action === action && row.last_action_source === 'schedule' && row.last_action_at != null && now - row.last_action_at < DEDUPE_MS) {
				continue;
			}
			console.log(`lightOps | Device ${row.id} (${row.name}) -> ${action}`);
			const key = await keyFor(row);
			if (!key) {
				errors++;
				writes.push(recordActionStmt(db, row.id, { state: action, source: 'schedule', error: 'GOVEE_KEY_MISSING' }, now));
				continue;
			}
			try {
				await setLightState(key, row, action === 'on');
				actions++;
				writes.push(recordActionStmt(db, row.id, { state: action, source: 'schedule', error: null }, now));
			} catch (err) {
				errors++;
				const message = String(err instanceof Error ? err.message : err).slice(0, 200);
				console.error(`lightOps | Device ${row.id} ${action} failed: ${message}`);
				writes.push(recordActionStmt(db, row.id, { state: action, source: 'schedule', error: message }, now));
			}
		}
	}
	if (writes.length) await db.batch(writes);
	return { checked: rows.length, actions, errors };
}
