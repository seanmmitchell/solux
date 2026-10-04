import * as vb from 'valibot';

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

export const id = vb.pipe(vb.string(), vb.minLength(1), vb.maxLength(64));
export const name = vb.pipe(vb.string(), vb.trim(), vb.minLength(1), vb.maxLength(100));
export const lat = vb.pipe(vb.number(), vb.minValue(-90), vb.maxValue(90));
export const lon = vb.pipe(vb.number(), vb.minValue(-180), vb.maxValue(180));
export const timezone = vb.pipe(vb.string(), vb.maxLength(64), vb.check(isValidTimeZone, 'Unknown IANA time zone'));
export const mac = vb.pipe(vb.string(), vb.trim(), vb.toUpperCase(), vb.regex(MAC_RE, 'Expected 6 or 8 colon-separated hex octets'));
export const model = vb.pipe(vb.string(), vb.trim(), vb.regex(MODEL_RE, 'Expected 2-32 letters, digits, "_" or "-"'));
export const offsetMin = vb.pipe(vb.number(), vb.integer(), vb.minValue(-720), vb.maxValue(720));
export const goveeApiKey = vb.pipe(vb.string(), vb.trim(), vb.minLength(8), vb.maxLength(128));
export const email = vb.pipe(vb.string(), vb.trim(), vb.toLowerCase(), vb.email(), vb.maxLength(254));
export const role = vb.picklist(['user', 'admin']);
export const userStatus = vb.picklist(['active', 'disabled']);
/** Absent means false; the default runs through the pipe, so the key is always a boolean. */
export const booleanQuery = vb.optional(
	vb.pipe(
		vb.picklist(['true', 'false', '1', '0']),
		vb.transform(v => v === 'true' || v === '1'),
	),
	'false',
);
/** A number, or a numeric string (query params, legacy KV JSON). */
export const numeric = vb.pipe(vb.union([vb.number(), vb.string()]), vb.transform(Number), vb.number());

/** Partial update bodies must change something and must not contain unknown keys. */
export function patchOf<T extends vb.ObjectEntries>(entries: T) {
	return vb.pipe(
		vb.partial(vb.strictObject(entries)),
		vb.check(o => Object.values(o).some(v => v !== undefined), 'Provide at least one field to update'),
	);
}
