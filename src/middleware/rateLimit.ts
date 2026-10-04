import { ApiError } from '../lib/errors';
import type { AppContext } from '../types';

/**
 * Per-IP limit backed by the Workers Rate Limiting binding (AUTH_LIMITER).
 * A missing binding (e.g. some local setups) disables limiting rather than failing.
 */
export async function enforceRateLimit(c: AppContext, bucket: string): Promise<void> {
	const limiter = (c.env as Partial<Env>).AUTH_LIMITER;
	if (!limiter) return;
	const ip = c.req.header('cf-connecting-ip') ?? 'unknown';
	const { success } = await limiter.limit({ key: `${bucket}:${ip}` });
	if (!success) {
		console.warn(`rateLimit | ${bucket} limit exceeded for ${ip}`);
		throw new ApiError(429, 'RATE_LIMITED', 'Too many requests. Try again in a minute.');
	}
}
