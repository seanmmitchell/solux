import { forbidden, validationFailed } from '../lib/errors';
import type { Principal } from '../types';

/**
 * Which owner's resources a list request covers. Users see their own; admins
 * may pass ?all=true or ?ownerId=. Returns null for "all owners".
 */
export function listScope(p: Principal, q: { all?: boolean | undefined; ownerId?: string | undefined }): string | null {
	if (q.all || q.ownerId) {
		if (!p.isAdmin) throw forbidden("Only admins can list other users' resources.");
		return q.ownerId ?? null;
	}
	// The break-glass key has no resources of its own; it sees everything.
	return p.userId;
}

/** Owners and admins may access a resource; everyone else gets 404 (existence is not revealed). */
export function canAccess(p: Principal, ownerId: string): boolean {
	return p.isAdmin || p.userId === ownerId;
}

/** Owner for a newly created resource: the caller, or (admins only) an explicit ownerId. */
export async function ownerForCreate(db: D1Database, p: Principal, ownerId: string | undefined): Promise<string> {
	if (ownerId !== undefined && ownerId !== p.userId) {
		if (!p.isAdmin) throw forbidden('Only admins can create resources for other users.');
		const exists = await db.prepare('SELECT 1 FROM users WHERE id = ?').bind(ownerId).first();
		if (!exists) throw validationFailed([{ path: 'ownerId', message: 'Unknown user' }]);
		return ownerId;
	}
	if (p.userId == null) throw validationFailed([{ path: 'ownerId', message: 'Required when using the break-glass key' }]);
	return p.userId;
}
