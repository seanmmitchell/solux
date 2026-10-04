import { z } from 'zod';

export const MAC_RE = /^([0-9A-F]{2}:){5}[0-9A-F]{2}((:[0-9A-F]{2}){2})?$/;
export const MODEL_RE = /^[A-Za-z0-9_-]{2,32}$/;

export function isValidTimeZone(tz: string): boolean {
	try {
		new Intl.DateTimeFormat('en', { timeZone: tz });
		return true;
	} catch {
		return false;
	}
}

export const id = z.string().min(1).max(64);
export const name = z.string().trim().min(1).max(100);
export const lat = z.number().min(-90).max(90);
export const lon = z.number().min(-180).max(180);
export const timezone = z.string().max(64).refine(isValidTimeZone, 'Unknown IANA time zone');
export const mac = z
	.string()
	.trim()
	.transform(s => s.toUpperCase())
	.pipe(z.string().regex(MAC_RE, 'Expected 6 or 8 colon-separated hex octets'));
export const model = z.string().trim().regex(MODEL_RE, 'Expected 2-32 letters, digits, "_" or "-"');
export const offsetMin = z.number().int().min(-720).max(720);
export const goveeApiKey = z.string().trim().min(8).max(128);
export const email = z.string().trim().toLowerCase().pipe(z.email()).pipe(z.string().max(254));
export const role = z.enum(['user', 'admin']);
export const userStatus = z.enum(['active', 'disabled']);
export const booleanQuery = z
	.enum(['true', 'false', '1', '0'])
	.optional()
	.transform(v => v === 'true' || v === '1');

/** Partial update bodies must change something and must not contain unknown keys. */
export function patchOf<T extends z.ZodRawShape>(shape: T) {
	return z
		.strictObject(shape)
		.partial()
		.refine(o => Object.values(o).some(v => v !== undefined), 'Provide at least one field to update');
}
