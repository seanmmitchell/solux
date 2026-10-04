import type { AppContext } from '../types';

/** Runs work after the response is sent (ctx.waitUntil). Failures are logged, never thrown. */
export function defer(c: AppContext, work: Promise<unknown>, label: string): void {
	const safe = work.catch(err => console.error(`defer | ${label} failed: ${err}`));
	try {
		c.executionCtx.waitUntil(safe);
	} catch {
		// No execution context (e.g. app.request without ctx): the promise still runs.
	}
}
