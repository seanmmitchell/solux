import type { MiddlewareHandler } from 'hono';
import { ApiError, forbidden, unauthenticated } from '../lib/errors';
import type { AppContext, AppEnv, Principal } from '../types';

const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** Requires any authenticated caller; GETs need the read scope, everything else write. */
export const requireAuth: MiddlewareHandler<AppEnv> = async (c, next) => {
	const p = c.get('principal');
	if (!p) throw unauthenticated();
	const needed = READ_METHODS.has(c.req.method) ? 'read' : 'write';
	if (!p.scopes.has(needed)) {
		throw new ApiError(403, 'INSUFFICIENT_SCOPE', `This API token lacks the "${needed}" scope.`);
	}
	await next();
};

/** Requires a real user (rejects the break-glass key). Use after requireAuth. */
export const requireUser: MiddlewareHandler<AppEnv> = async (c, next) => {
	if (c.get('principal')?.userId == null) {
		throw new ApiError(403, 'USER_REQUIRED', 'This endpoint requires a user account, not the break-glass key.');
	}
	await next();
};

/** Requires a browser session (rejects API tokens and break-glass). Use after requireAuth. */
export const requireSession: MiddlewareHandler<AppEnv> = async (c, next) => {
	if (c.get('principal')?.via !== 'session') {
		throw new ApiError(403, 'SESSION_REQUIRED', 'This action requires signing in with a browser session.');
	}
	await next();
};

/** Requires admin role and, for API tokens, the admin scope. Use after requireAuth. */
export const requireAdmin: MiddlewareHandler<AppEnv> = async (c, next) => {
	const p = c.get('principal');
	if (!p?.isAdmin) {
		if (p?.role === 'admin') throw new ApiError(403, 'INSUFFICIENT_SCOPE', 'This API token lacks the "admin" scope.');
		throw forbidden('Admin access required.');
	}
	await next();
};

export function principalOf(c: AppContext): Principal {
	const p = c.get('principal');
	if (!p) throw unauthenticated();
	return p;
}

/** The caller's user id; only valid behind requireUser. */
export function userIdOf(c: AppContext): string {
	const id = principalOf(c).userId;
	if (id == null) throw new ApiError(403, 'USER_REQUIRED', 'This endpoint requires a user account.');
	return id;
}
