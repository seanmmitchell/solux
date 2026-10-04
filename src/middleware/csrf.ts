import type { MiddlewareHandler } from 'hono';
import { getConfig } from '../lib/config';
import { getSessionCookie } from '../lib/cookies';
import { ApiError } from '../lib/errors';
import type { AppEnv } from '../types';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Cookie-authenticated mutations must come from an allowed Origin (or, with no
 * Origin header, be same-origin per Sec-Fetch-Site). Bearer and break-glass
 * requests are exempt: browsers never attach those automatically.
 */
export const csrfGuard: MiddlewareHandler<AppEnv> = async (c, next) => {
	if (SAFE_METHODS.has(c.req.method)) return next();
	const via = c.get('principal')?.via;
	if (via === 'token' || via === 'breakglass') return next();
	if (via !== 'session' && getSessionCookie(c) === undefined) return next();

	const origin = c.req.header('origin');
	if (origin) {
		const allowed = getConfig(c.env).corsOrigins;
		if (origin === new URL(c.req.url).origin || allowed.includes(origin)) return next();
	} else if (c.req.header('sec-fetch-site') === 'same-origin') {
		return next();
	}
	console.warn(`csrf | Rejected ${c.req.method} ${c.req.path} from origin ${origin ?? '(none)'}`);
	throw new ApiError(403, 'CSRF_FAILED', 'Cross-site request rejected.');
};
