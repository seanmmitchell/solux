/** One local day's sun times for a location (epoch ms, UTC). */
export type SunDay = { date: string; sunriseAt: number; sunsetAt: number };

export type LightAction = 'off' | 'on';
export type Target = { action: LightAction; at: number };

/**
 * A scheduled target fires at the first cron tick at or after it, and keeps
 * being retried (on failure) until this long after it.
 */
export const SCHEDULE_GRACE_MS = 15 * 60_000;

/**
 * The location's local calendar date. Uses the IANA zone when known; otherwise
 * approximates local solar time from longitude (15° per hour), which is what
 * matters for "which day's sunset is tonight".
 */
export function localDate(now: number, timezone: string | null, lon: number): string {
	if (timezone) {
		try {
			const parts = new Intl.DateTimeFormat('en-US', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(now));
			const get = (type: string) => parts.find(p => p.type === type)?.value;
			const y = get('year');
			const m = get('month');
			const d = get('day');
			if (y && m && d) return `${y}-${m}-${d}`;
		} catch {
			// fall through to the longitude approximation
		}
	}
	return new Date(now + (lon / 15) * 3_600_000).toISOString().slice(0, 10);
}

export function addDays(date: string, days: number): string {
	const d = new Date(`${date}T00:00:00Z`);
	d.setUTCDate(d.getUTCDate() + days);
	return d.toISOString().slice(0, 10);
}

/** Local yesterday, today and tomorrow: enough to cover offsets that cross local midnight. */
export function wantedDates(now: number, timezone: string | null, lon: number): [string, string, string] {
	const today = localDate(now, timezone, lon);
	return [addDays(today, -1), today, addDays(today, 1)];
}

export function parseSunDays(raw: string | null | undefined): SunDay[] {
	if (!raw) return [];
	try {
		const parsed: unknown = JSON.parse(raw);
		if (!Array.isArray(parsed)) return [];
		return parsed.filter(
			(d): d is SunDay =>
				typeof d === 'object' &&
				d !== null &&
				typeof (d as SunDay).date === 'string' &&
				Number.isFinite((d as SunDay).sunriseAt) &&
				Number.isFinite((d as SunDay).sunsetAt),
		);
	} catch {
		return [];
	}
}

/** Lights go off at sunrise + offset and on at sunset + offset, for every known day, in time order. */
export function scheduleTargets(days: SunDay[], offsets: { sunriseOffsetMin: number; sunsetOffsetMin: number }): Target[] {
	const targets: Target[] = [];
	for (const day of days) {
		targets.push({ action: 'off', at: day.sunriseAt + offsets.sunriseOffsetMin * 60_000 });
		targets.push({ action: 'on', at: day.sunsetAt + offsets.sunsetOffsetMin * 60_000 });
	}
	return targets.sort((a, b) => a.at - b.at);
}

/**
 * The target to act on now: the most recent one that has passed, is still
 * within the grace period, and is newer than the last one fired. Only the
 * latest matters — earlier due targets would be immediately superseded.
 */
export function dueTarget(now: number, targets: Target[], lastTargetAt: number | null): Target | null {
	let due: Target | null = null;
	for (const t of targets) {
		if (t.at > now) break;
		if (now - t.at > SCHEDULE_GRACE_MS) continue;
		if (lastTargetAt != null && t.at <= lastTargetAt) continue;
		due = t;
	}
	return due;
}

/** The next upcoming time of each action (null if not within the known days). */
export function nextTargets(now: number, targets: Target[]): { offAt: number | null; onAt: number | null } {
	const next = (action: LightAction) => targets.find(t => t.action === action && t.at > now)?.at ?? null;
	return { offAt: next('off'), onAt: next('on') };
}
