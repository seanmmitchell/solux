import type { ApiTokenRow, UserRow } from '../db/rows';
import { randomToken, sha256Hex } from '../lib/crypto';
import { conflict } from '../lib/errors';
import type { Scope } from '../types';

export const TOKEN_PREFIX = 'slx_';
export const MAX_TOKENS_PER_USER = 25;
/** last_used_at is written at most this often per token. */
const LAST_USED_INTERVAL_MS = 5 * 60_000;

export async function createApiToken(
	db: D1Database,
	userId: string,
	input: { name: string; scopes: Scope[]; expiresAt: number | null },
	now = Date.now(),
) {
	const count = await db.prepare('SELECT COUNT(*) AS n FROM api_tokens WHERE user_id = ?').bind(userId).first<number>('n');
	if ((count ?? 0) >= MAX_TOKENS_PER_USER) {
		throw conflict('TOKEN_LIMIT', `You can have at most ${MAX_TOKENS_PER_USER} API tokens.`);
	}
	const token = TOKEN_PREFIX + randomToken(32);
	const row: ApiTokenRow = {
		id: crypto.randomUUID(),
		user_id: userId,
		name: input.name,
		token_prefix: token.slice(0, 12),
		token_hash: await sha256Hex(token),
		scopes: normaliseScopes(input.scopes).join(' '),
		created_at: now,
		last_used_at: null,
		expires_at: input.expiresAt,
	};
	await db
		.prepare(
			`INSERT INTO api_tokens (id, user_id, name, token_prefix, token_hash, scopes, created_at, last_used_at, expires_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		)
		.bind(row.id, row.user_id, row.name, row.token_prefix, row.token_hash, row.scopes, row.created_at, row.last_used_at, row.expires_at)
		.run();
	return { token, row };
}

export function normaliseScopes(scopes: Iterable<Scope>): Scope[] {
	const set = new Set(scopes);
	// write implies read; admin implies read and write (admin endpoints mutate).
	if (set.has('admin')) set.add('write');
	if (set.size > 0) set.add('read');
	return (['read', 'write', 'admin'] as const).filter(s => set.has(s));
}

type TokenJoin = ApiTokenRow & { u_role: UserRow['role']; u_status: UserRow['status'] };

/** Returns the token and owner role, or null if unknown, expired or the owner is not active. */
export async function resolveApiToken(db: D1Database, token: string, now = Date.now()) {
	if (!token.startsWith(TOKEN_PREFIX)) return null;
	const row = await db
		.prepare(
			`SELECT t.*, u.role AS u_role, u.status AS u_status
			FROM api_tokens t JOIN users u ON u.id = t.user_id
			WHERE t.token_hash = ?`,
		)
		.bind(await sha256Hex(token))
		.first<TokenJoin>();
	if (!row) return null;
	if ((row.expires_at != null && row.expires_at <= now) || row.u_status !== 'active') return null;
	const { u_role, u_status, ...tokenRow } = row;
	return { token: tokenRow as ApiTokenRow, role: u_role };
}

export function touchTokenStmt(db: D1Database, t: ApiTokenRow, now = Date.now()): D1PreparedStatement | null {
	if (t.last_used_at != null && now - t.last_used_at < LAST_USED_INTERVAL_MS) return null;
	return db.prepare('UPDATE api_tokens SET last_used_at = ? WHERE id = ?').bind(now, t.id);
}

export async function listApiTokens(db: D1Database, userId: string) {
	const { results } = await db
		.prepare('SELECT * FROM api_tokens WHERE user_id = ? ORDER BY created_at DESC, id DESC')
		.bind(userId)
		.all<ApiTokenRow>();
	return results;
}

export function deleteUserTokensStmt(db: D1Database, userId: string): D1PreparedStatement {
	return db.prepare('DELETE FROM api_tokens WHERE user_id = ?').bind(userId);
}
