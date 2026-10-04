import type { UserRow } from '../db/rows';
import type { Config } from '../lib/config';
import { decryptSecret, encryptSecret } from '../lib/crypto';
import { ApiError, conflict, notFound } from '../lib/errors';
import { type Page, type PageQuery, paginateSql, toPage } from '../lib/pagination';
import type { Role, UserStatus } from '../types';
import { type AuditActor, SYSTEM_ACTOR, auditStmt } from './audit';
import { deleteUserSessionsStmt } from './sessions';

export async function getUser(db: D1Database, id: string): Promise<UserRow | null> {
	return db.prepare('SELECT * FROM users WHERE id = ?').bind(id).first<UserRow>();
}

export async function requireUserRow(db: D1Database, id: string): Promise<UserRow> {
	const u = await getUser(db, id);
	if (!u) throw notFound('User');
	return u;
}

export type UserFilters = { q?: string | undefined; role?: Role | undefined; status?: UserStatus | undefined };

export async function listUsers(db: D1Database, f: UserFilters, page: PageQuery): Promise<Page<UserRow>> {
	let sql = 'SELECT * FROM users WHERE 1=1';
	const params: unknown[] = [];
	if (f.q) {
		const like = `%${f.q.toLowerCase().replace(/[\\%_]/g, m => `\\${m}`)}%`;
		sql += " AND (lower(email) LIKE ? ESCAPE '\\' OR lower(display_name) LIKE ? ESCAPE '\\')";
		params.push(like, like);
	}
	if (f.role) {
		sql += ' AND role = ?';
		params.push(f.role);
	}
	if (f.status) {
		sql += ' AND status = ?';
		params.push(f.status);
	}
	const q = paginateSql(sql, params, page);
	const { results } = await db.prepare(q.sql).bind(...q.params).all<UserRow>();
	return toPage(results, page.limit);
}

export async function inviteUser(db: D1Database, actor: AuditActor, email: string, role: Role, now = Date.now()): Promise<UserRow> {
	const existing = await db.prepare('SELECT id FROM users WHERE email = ?').bind(email).first();
	if (existing) throw conflict('CONFLICT', 'A user with that email already exists.');
	const id = crypto.randomUUID();
	const [, , res] = await db.batch([
		db
			.prepare(`INSERT INTO users (id, email, email_verified, role, status, created_at, updated_at) VALUES (?, ?, 0, ?, 'invited', ?, ?)`)
			.bind(id, email, role, now, now),
		auditStmt(db, actor, { action: 'user.created', targetType: 'user', targetId: id, targetUserId: id, metadata: { role, invited: true } }, now),
		db.prepare('SELECT * FROM users WHERE id = ?').bind(id),
	]);
	return (res?.results[0] as UserRow | undefined) ?? (await requireUserRow(db, id));
}

/** SQL guard: true when some *other* active admin exists. */
const OTHER_ACTIVE_ADMIN = "EXISTS (SELECT 1 FROM users o WHERE o.role = 'admin' AND o.status = 'active' AND o.id <> users.id)";

/**
 * Changes role and/or status atomically, refusing (409 LAST_ADMIN) if the change
 * would leave no active admin. Disabling also revokes all of the user's sessions.
 */
export async function adminUpdateUser(
	db: D1Database,
	actor: AuditActor,
	id: string,
	patch: { role?: Role | undefined; status?: 'active' | 'disabled' | undefined; displayName?: string | null | undefined },
	now = Date.now(),
): Promise<UserRow> {
	const before = await requireUserRow(db, id);
	const role = patch.role ?? before.role;
	let status: UserStatus = patch.status ?? before.status;
	// An invited user stays invited until first login unless explicitly disabled.
	if (before.status === 'invited' && patch.status === 'active') status = 'invited';
	const displayName = patch.displayName === undefined ? before.display_name : patch.displayName;

	const stays = role === 'admin' && status === 'active';
	const res = await db
		.prepare(
			`UPDATE users SET role = ?, status = ?, display_name = ?, updated_at = ?
			WHERE id = ? AND (? OR NOT (role = 'admin' AND status = 'active') OR ${OTHER_ACTIVE_ADMIN})`,
		)
		.bind(role, status, displayName, now, id, stays ? 1 : 0)
		.run();
	if (res.meta.changes === 0) throw lastAdmin();

	const follow: D1PreparedStatement[] = [];
	if (role !== before.role) {
		follow.push(auditStmt(db, actor, { action: 'user.role_changed', targetType: 'user', targetId: id, targetUserId: id, metadata: { from: before.role, to: role } }, now));
	}
	if (status !== before.status) {
		follow.push(auditStmt(db, actor, { action: 'user.status_changed', targetType: 'user', targetId: id, targetUserId: id, metadata: { from: before.status, to: status } }, now));
		if (status === 'disabled') follow.push(deleteUserSessionsStmt(db, id));
	}
	if (displayName !== before.display_name) {
		follow.push(auditStmt(db, actor, { action: 'user.updated', targetType: 'user', targetId: id, targetUserId: id, metadata: { fields: ['displayName'] } }, now));
	}
	if (follow.length) await db.batch(follow);
	return requireUserRow(db, id);
}

/** Deletes a user (cascading to everything they own), refusing to remove the last active admin. */
export async function deleteUser(db: D1Database, actor: AuditActor, id: string, now = Date.now()): Promise<void> {
	const before = await requireUserRow(db, id);
	const res = await db
		.prepare(`DELETE FROM users WHERE id = ? AND (NOT (role = 'admin' AND status = 'active') OR ${OTHER_ACTIVE_ADMIN})`)
		.bind(id)
		.run();
	if (res.meta.changes === 0) throw lastAdmin();
	await auditStmt(db, actor, { action: 'user.deleted', targetType: 'user', targetId: id, targetUserId: id, metadata: { role: before.role } }, now).run();
}

const lastAdmin = () => conflict('LAST_ADMIN', 'This change would leave no active admin.');

export async function updateProfile(
	db: D1Database,
	cfg: Config,
	actor: AuditActor,
	user: UserRow,
	patch: { displayName?: string | null | undefined; timezone?: string | null | undefined; goveeApiKey?: string | null | undefined },
	now = Date.now(),
): Promise<UserRow> {
	const stmts: D1PreparedStatement[] = [];
	const fields: string[] = [];
	const sets: string[] = [];
	const params: unknown[] = [];
	if (patch.displayName !== undefined) {
		sets.push('display_name = ?');
		params.push(patch.displayName);
		fields.push('displayName');
	}
	if (patch.timezone !== undefined) {
		sets.push('timezone = ?');
		params.push(patch.timezone);
		fields.push('timezone');
	}
	if (patch.goveeApiKey !== undefined) {
		if (patch.goveeApiKey === null) {
			sets.push('govee_key_enc = NULL');
			stmts.push(auditStmt(db, actor, { action: 'user.govee_key_cleared', targetType: 'user', targetId: user.id, targetUserId: user.id }, now));
		} else {
			if (!cfg.encKey) throw new ApiError(500, 'CONFIG_ERROR', 'Server encryption key is not configured.');
			sets.push('govee_key_enc = ?');
			params.push(await encryptSecret(patch.goveeApiKey, cfg.encKey, user.id));
			stmts.push(auditStmt(db, actor, { action: 'user.govee_key_set', targetType: 'user', targetId: user.id, targetUserId: user.id }, now));
		}
	}
	if (fields.length) {
		stmts.push(auditStmt(db, actor, { action: 'user.updated', targetType: 'user', targetId: user.id, targetUserId: user.id, metadata: { fields } }, now));
	}
	sets.push('updated_at = ?');
	params.push(now, user.id);
	await db.batch([db.prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`).bind(...params), ...stmts]);
	return requireUserRow(db, user.id);
}

/** Decrypts the user's Govee key; null if none is set. */
export async function getGoveeKey(cfg: Config, user: Pick<UserRow, 'id' | 'govee_key_enc'>): Promise<string | null> {
	if (!user.govee_key_enc) return null;
	if (!cfg.encKey) throw new ApiError(500, 'CONFIG_ERROR', 'Server encryption key is not configured.');
	return decryptSecret(user.govee_key_enc, cfg.encKey, user.id);
}

/** The Govee key used for a user's devices: their own, else (admins only, if policy allows) the operator key. */
export async function resolveGoveeKey(cfg: Config, user: Pick<UserRow, 'id' | 'role' | 'govee_key_enc'>): Promise<string | null> {
	const own = await getGoveeKey(cfg, user);
	if (own) return own;
	return cfg.goveeFallbackPolicy === 'admins' && user.role === 'admin' ? cfg.goveeApiKey : null;
}

// ---------------------------------------------------------------------------
// OIDC provisioning

export type OidcClaims = {
	issuer: string;
	subject: string;
	email: string | null;
	emailVerified: boolean;
	name: string | null;
};

export type LoginFailure = 'signup_closed' | 'email_not_allowed' | 'email_unverified' | 'account_disabled';

export class LoginRejected extends Error {
	constructor(readonly reason: LoginFailure) {
		super(reason);
	}
}

/**
 * Finds or creates the user for an OIDC identity. Never links an existing
 * account by email except an invited (identity-less) user with a verified email.
 */
export async function loginWithOidc(db: D1Database, cfg: Config, claims: OidcClaims, now = Date.now()): Promise<{ user: UserRow; created: boolean }> {
	const email = claims.email?.toLowerCase() ?? null;
	const verifiedEmail = claims.emailVerified ? email : null;
	const isConfiguredAdmin = verifiedEmail != null && cfg.adminEmails.includes(verifiedEmail);

	const identity = await db
		.prepare('SELECT user_id FROM identities WHERE issuer = ? AND subject = ?')
		.bind(claims.issuer, claims.subject)
		.first<{ user_id: string }>();

	let userId: string;
	let created = false;
	const stmts: D1PreparedStatement[] = [];

	if (identity) {
		userId = identity.user_id;
		const user = await requireUserRow(db, userId);
		if (user.status === 'disabled') throw new LoginRejected('account_disabled');
		stmts.push(
			db.prepare('UPDATE identities SET email = ?, last_login_at = ? WHERE issuer = ? AND subject = ?').bind(email, now, claims.issuer, claims.subject),
		);
	} else {
		const invited = verifiedEmail
			? await db
					.prepare(
						`SELECT u.id FROM users u WHERE u.email = ? AND u.status = 'invited'
						AND NOT EXISTS (SELECT 1 FROM identities i WHERE i.user_id = u.id)`,
					)
					.bind(verifiedEmail)
					.first<{ id: string }>()
			: null;

		if (invited) {
			userId = invited.id;
		} else {
			await checkSignupPolicy(db, cfg, email, claims.emailVerified, isConfiguredAdmin);
			userId = crypto.randomUUID();
			created = true;
			const role = cfg.firstUserAdmin
				? "CASE WHEN EXISTS (SELECT 1 FROM users WHERE role = 'admin' AND status = 'active') THEN 'user' ELSE 'admin' END"
				: "'user'";
			stmts.push(
				db
					.prepare(
						`INSERT INTO users (id, email, email_verified, display_name, role, status, created_at, updated_at)
						VALUES (?, ?, ?, ?, ${role}, 'active', ?, ?)`,
					)
					.bind(userId, email, claims.emailVerified ? 1 : 0, claims.name, now, now),
			);
		}
		stmts.push(
			db
				.prepare('INSERT INTO identities (id, user_id, issuer, subject, email, created_at, last_login_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
				.bind(crypto.randomUUID(), userId, claims.issuer, claims.subject, email, now, now),
		);
	}

	// Refresh profile claims; activate invited users; record the login.
	stmts.push(
		db
			.prepare(
				`UPDATE users SET
					email = COALESCE(?, email),
					email_verified = ?,
					display_name = COALESCE(display_name, ?),
					status = CASE WHEN status = 'invited' THEN 'active' ELSE status END,
					last_login_at = ?, updated_at = ?
				WHERE id = ?`,
			)
			.bind(email, claims.emailVerified ? 1 : 0, claims.name, now, now, userId),
	);
	await db.batch(stmts);

	let user = await requireUserRow(db, userId);
	if (created) {
		await auditStmt(db, SYSTEM_ACTOR, { action: 'user.created', targetType: 'user', targetId: userId, targetUserId: userId, metadata: { role: user.role, via: 'oidc' } }, now).run();
	}
	// Config wins: listed, verified emails are (re)promoted on every login.
	if (isConfiguredAdmin && user.role !== 'admin') {
		await db.batch([
			db.prepare("UPDATE users SET role = 'admin', updated_at = ? WHERE id = ?").bind(now, userId),
			auditStmt(db, SYSTEM_ACTOR, { action: 'user.role_changed', targetType: 'user', targetId: userId, targetUserId: userId, metadata: { from: user.role, to: 'admin', reason: 'SOLUX_ADMIN_EMAILS' } }, now),
		]);
		user = await requireUserRow(db, userId);
	}
	return { user, created };
}

async function checkSignupPolicy(db: D1Database, cfg: Config, email: string | null, emailVerified: boolean, isConfiguredAdmin: boolean): Promise<void> {
	if (isConfiguredAdmin) return;
	if (cfg.signupPolicy === 'open') return;
	// First-user bootstrap: allow sign-up while no active admin exists (the role itself is decided atomically on insert).
	if (cfg.firstUserAdmin && !(await db.prepare("SELECT 1 FROM users WHERE role = 'admin' AND status = 'active' LIMIT 1").first())) return;
	if (cfg.signupPolicy === 'domain') {
		if (!email) throw new LoginRejected('email_not_allowed');
		if (!emailVerified) throw new LoginRejected('email_unverified');
		const domain = email.split('@')[1] ?? '';
		if (cfg.allowedEmailDomains.includes(domain)) return;
		throw new LoginRejected('email_not_allowed');
	}
	throw new LoginRejected('signup_closed');
}
