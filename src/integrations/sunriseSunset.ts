import { z } from 'zod';

// https://sunrise-sunset.org/api
const API_URL = 'https://api.sunrise-sunset.org/json';
const TIMEOUT_MS = 10_000;

const responseSchema = z.object({
	status: z.literal('OK'),
	results: z.object({ sunrise: z.string(), sunset: z.string() }),
});

export type SunTimes = { sunriseAt: number; sunsetAt: number };

/** Fetches sunrise/sunset for an explicit calendar date (YYYY-MM-DD) at the location. */
export async function fetchSunTimes(lat: number, lon: number, date: string, timezone?: string | null): Promise<SunTimes> {
	const url = new URL(API_URL);
	url.searchParams.set('lat', String(lat));
	url.searchParams.set('lng', String(lon));
	url.searchParams.set('date', date);
	url.searchParams.set('formatted', '0');
	if (timezone) url.searchParams.set('tzid', timezone);

	const res = await fetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(TIMEOUT_MS) });
	if (!res.ok) throw new Error(`sunrise-sunset.org responded ${res.status}`);
	const parsed = responseSchema.safeParse(await res.json());
	if (!parsed.success) throw new Error('sunrise-sunset.org returned an unexpected response');
	const sunriseAt = Date.parse(parsed.data.results.sunrise);
	const sunsetAt = Date.parse(parsed.data.results.sunset);
	if (!Number.isFinite(sunriseAt) || !Number.isFinite(sunsetAt)) throw new Error('sunrise-sunset.org returned invalid times');
	return { sunriseAt, sunsetAt };
}
