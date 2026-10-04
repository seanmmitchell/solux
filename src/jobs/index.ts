import { runHousekeeping } from './housekeeping';
import { runLightOps } from './lightOps';
import { runSunRefresh } from './sunTimes';

// Keep in sync with [triggers] in wrangler.toml.
export const CRON_SUN = '0 */2 * * *';
export const CRON_OPS = '*/3 * * * *';

export async function handleScheduled(cron: string, env: Env): Promise<void> {
	const start = Date.now();
	switch (cron) {
		case CRON_SUN: {
			console.info('worker | Cron Sunrise-Sunset sync start (every 2h).');
			const result = await runSunRefresh(env);
			await runHousekeeping(env);
			console.info(`worker | Cron Sunrise-Sunset sync complete in ${Date.now() - start}ms. ${JSON.stringify(result)}`);
			break;
		}
		case CRON_OPS: {
			console.info('worker | Cron operation sync start (every 3m).');
			const result = await runLightOps(env);
			console.info(`worker | Cron operation sync complete in ${Date.now() - start}ms. ${JSON.stringify(result)}`);
			break;
		}
		default:
			console.error(`worker | Unknown cron event: ${cron}`);
	}
}
