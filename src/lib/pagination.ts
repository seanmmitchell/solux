import * as vb from 'valibot';
import { base64UrlDecode, base64UrlEncode } from './crypto';
import { ApiError } from './errors';
import { numeric } from './validation';

export const DEFAULT_LIMIT = 50;
export const MAX_LIMIT = 100;

export type Cursor = { createdAt: number; id: string };
export type Page<T> = { items: T[]; nextCursor: string | null };
export type PageQuery = { limit: number; cursor: Cursor | null };

export const pageQuerySchema = vb.object({
	limit: vb.optional(vb.pipe(numeric, vb.integer(), vb.minValue(1), vb.maxValue(MAX_LIMIT)), DEFAULT_LIMIT),
	cursor: vb.optional(vb.pipe(vb.string(), vb.maxLength(200))),
});

export function encodeCursor(c: Cursor): string {
	return base64UrlEncode(new TextEncoder().encode(`${c.createdAt}:${c.id}`));
}

export function decodeCursor(s: string | undefined): Cursor | null {
	if (!s) return null;
	try {
		const raw = new TextDecoder().decode(base64UrlDecode(s));
		const idx = raw.indexOf(':');
		const createdAt = Number(raw.slice(0, idx));
		const id = raw.slice(idx + 1);
		if (idx > 0 && Number.isInteger(createdAt) && id) return { createdAt, id };
	} catch {
		// fall through
	}
	throw new ApiError(400, 'VALIDATION_FAILED', 'Invalid cursor.', [{ path: 'cursor', message: 'Invalid cursor' }]);
}

export function toPageQuery(q: { limit: number; cursor?: string | undefined }): PageQuery {
	return { limit: q.limit, cursor: decodeCursor(q.cursor) };
}

/**
 * Appends keyset pagination (newest first) to a query. `alias` prefixes the
 * created_at/id columns. The caller's WHERE clause must already be present
 * (use "WHERE 1=1" when there are no other filters).
 */
export function paginateSql(sql: string, params: unknown[], page: PageQuery, alias = ''): { sql: string; params: unknown[] } {
	const p = alias ? `${alias}.` : '';
	const out = [...params];
	let q = sql;
	if (page.cursor) {
		q += ` AND (${p}created_at < ? OR (${p}created_at = ? AND ${p}id < ?))`;
		out.push(page.cursor.createdAt, page.cursor.createdAt, page.cursor.id);
	}
	q += ` ORDER BY ${p}created_at DESC, ${p}id DESC LIMIT ?`;
	out.push(page.limit + 1);
	return { sql: q, params: out };
}

export function toPage<T extends { id: string; created_at: number }>(rows: T[], limit: number): Page<T> {
	const items = rows.slice(0, limit);
	const last = items[items.length - 1];
	const nextCursor = rows.length > limit && last ? encodeCursor({ createdAt: last.created_at, id: last.id }) : null;
	return { items, nextCursor };
}
