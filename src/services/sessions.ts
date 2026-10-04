import type { SessionRow, UserRow } from '../db/rows';
import type { Config } from '../lib/config';
import { randomToken, sha256Hex } from '../lib/crypto';

/** Sessions are touched (idle expiry extended) at most this often. */
export const SESSION_TOUCH_INTERVAL_MS = 15 * 60_000;

export type RequestInfo = { ip: string | null; userAgent: string | null };

export async function createSession(db: D1Database, cfg: Config, userId: string, info: RequestInfo, now = Date.now()) {
	const token = randomToken(32);
	const row: SessionRow = {
		id: crypto.randomUUID(),
		user_id: userId,
		token_hash: await sha256Hex(token),
		created_at: now,
		last_seen_at: now,
		idle_expires_at: now + cfg.sessionIdleTtlMs,
		expires_at: now + cfg.sessionAbsoluteTtlMs,
		ip: info.ip,
		user_agent: info.userAgent,
	};
	await db
		.prepare(
			`INSERT INTO sessions (id, user_id, token_hash, created_at, last_seen_at, idle_expires_at, expires_at, ip, user_agent)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		)
		.bind(row.id, row.user_id, row.token_hash, row.created_at, row.last_seen_at, row.idle_expires_at, row.expires_at, row.ip, row.user_agent)
		.run();
	return { token, session: row };
}

type SessionJoin = SessionRow & { u_role: UserRow['role']; u_status: UserRow['status'] };

/** Returns the live session for a cookie value, or null if unknown, expired or the user is not active. */
export async function resolveSession(db: D1Database, token: string, now = Date.now()) {
	const row = await db
		.prepare(
			`SELECT s.*, u.role AS u_role, u.status AS u_status
			FROM sessions s JOIN users u ON u.id = s.user_id
			WHERE s.token_hash = ?`,
		)
		.bind(await sha256Hex(token))
		.first<SessionJoin>();
	if (!row) return null;
	if (row.expires_at <= now || row.idle_expires_at <= now || row.u_status !== 'active') return null;
	const { u_role, u_status, ...session } = row;
	return { session: session as SessionRow, role: u_role };
}

/** Slides the idle expiry forward; returns null when no touch is due. */
export function touchSessionStmt(db: D1Database, cfg: Config, s: SessionRow, now = Date.now()): D1PreparedStatement | null {
	if (now - s.last_seen_at < SESSION_TOUCH_INTERVAL_MS) return null;
	return db
		.prepare('UPDATE sessions SET last_seen_at = ?, idle_expires_at = ? WHERE id = ?')
		.bind(now, Math.min(now + cfg.sessionIdleTtlMs, s.expires_at), s.id);
}

export async function listSessions(db: D1Database, userId: string, now = Date.now()) {
	const { results } = await db
		.prepare('SELECT * FROM sessions WHERE user_id = ? AND expires_at > ? AND idle_expires_at > ? ORDER BY last_seen_at DESC')
		.bind(userId, now, now)
		.all<SessionRow>();
	return results;
}

export function deleteSessionStmt(db: D1Database, userId: string, sessionId: string): D1PreparedStatement {
	return db.prepare('DELETE FROM sessions WHERE id = ? AND user_id = ?').bind(sessionId, userId);
}

export function deleteUserSessionsStmt(db: D1Database, userId: string, exceptSessionId?: string): D1PreparedStatement {
	return exceptSessionId
		? db.prepare('DELETE FROM sessions WHERE user_id = ? AND id <> ?').bind(userId, exceptSessionId)
		: db.prepare('DELETE FROM sessions WHERE user_id = ?').bind(userId);
}

export async function deleteSessionByToken(db: D1Database, token: string): Promise<SessionRow | null> {
	return db.prepare('DELETE FROM sessions WHERE token_hash = ? RETURNING *').bind(await sha256Hex(token)).first<SessionRow>();
}
