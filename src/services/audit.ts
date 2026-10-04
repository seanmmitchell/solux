import type { AuditRow } from '../db/rows';
import { type Page, type PageQuery, paginateSql, toPage } from '../lib/pagination';
import type { AppContext } from '../types';

export type AuditVia = AuditRow['actor_via'];

export type AuditActor = {
	userId: string | null;
	via: AuditVia;
	ip?: string | null;
	userAgent?: string | null;
	requestId?: string | null;
};

export type AuditEvent = {
	action: string;
	targetType?: string;
	targetId?: string | null;
	targetUserId?: string | null;
	/** Never include secrets. */
	metadata?: Record<string, unknown>;
};

export const SYSTEM_ACTOR: AuditActor = { userId: null, via: 'system' };

export function requestMeta(c: AppContext) {
	return {
		ip: c.req.header('cf-connecting-ip') ?? null,
		userAgent: c.req.header('user-agent')?.slice(0, 256) ?? null,
		requestId: c.get('requestId') ?? null,
	};
}

/** The audit actor for the current request (anonymous callers are recorded as system). */
export function actorFrom(c: AppContext): AuditActor {
	const p = c.get('principal');
	return { userId: p?.userId ?? null, via: p?.via ?? 'system', ...requestMeta(c) };
}

/** A prepared insert, so callers can commit the audit row atomically with their change via db.batch. */
export function auditStmt(db: D1Database, actor: AuditActor, event: AuditEvent, now = Date.now()): D1PreparedStatement {
	return db
		.prepare(
			`INSERT INTO audit_events (id, created_at, actor_user_id, actor_via, action, target_type, target_id, target_user_id, ip, user_agent, request_id, metadata)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		)
		.bind(
			crypto.randomUUID(),
			now,
			actor.userId,
			actor.via,
			event.action,
			event.targetType ?? null,
			event.targetId ?? null,
			event.targetUserId ?? null,
			actor.ip ?? null,
			actor.userAgent ?? null,
			actor.requestId ?? null,
			event.metadata ? JSON.stringify(event.metadata) : null,
		);
}

export async function audit(db: D1Database, actor: AuditActor, event: AuditEvent): Promise<void> {
	try {
		await auditStmt(db, actor, event).run();
	} catch (err) {
		// Auditing must never break the request it describes.
		console.error(`audit | Failed to record ${event.action}: ${err}`);
	}
}

export type AuditFilters = {
	action?: string | undefined;
	actorId?: string | undefined;
	targetUserId?: string | undefined;
	/** Events where the user is the actor OR the target. */
	involvingUserId?: string | undefined;
	since?: number | undefined;
	until?: number | undefined;
};

export async function listAudit(db: D1Database, filters: AuditFilters, page: PageQuery): Promise<Page<AuditRow>> {
	let sql = 'SELECT * FROM audit_events WHERE 1=1';
	const params: unknown[] = [];
	if (filters.action) {
		sql += ' AND action = ?';
		params.push(filters.action);
	}
	if (filters.actorId) {
		sql += ' AND actor_user_id = ?';
		params.push(filters.actorId);
	}
	if (filters.targetUserId) {
		sql += ' AND target_user_id = ?';
		params.push(filters.targetUserId);
	}
	if (filters.involvingUserId) {
		sql += ' AND (actor_user_id = ? OR target_user_id = ?)';
		params.push(filters.involvingUserId, filters.involvingUserId);
	}
	if (filters.since != null) {
		sql += ' AND created_at >= ?';
		params.push(filters.since);
	}
	if (filters.until != null) {
		sql += ' AND created_at < ?';
		params.push(filters.until);
	}
	const q = paginateSql(sql, params, page);
	const { results } = await db.prepare(q.sql).bind(...q.params).all<AuditRow>();
	return toPage(results, page.limit);
}
