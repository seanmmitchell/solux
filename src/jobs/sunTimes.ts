import type { LocationRow } from '../db/rows';
import { refreshSunTimes } from '../services/locations';

const CONCURRENCY = 5;

/** Refreshes sun times for every location whose owner isn't disabled. */
export async function runSunRefresh(env: Env, now = Date.now()): Promise<{ refreshed: number; failed: number }> {
	const { results } = await env.DB.prepare(
		`SELECT l.* FROM locations l JOIN users u ON u.id = l.owner_id WHERE u.status <> 'disabled'`,
	).all<LocationRow>();

	let refreshed = 0;
	let failed = 0;
	const queue = [...results];
	const worker = async () => {
		for (let row = queue.shift(); row; row = queue.shift()) {
			const { ok } = await refreshSunTimes(env.DB, row, now);
			if (ok) refreshed++;
			else failed++;
		}
	};
	await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, worker));
	return { refreshed, failed };
}
