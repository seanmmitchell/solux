import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { cors } from 'hono/cors';
import { HTTPException } from 'hono/http-exception';
import { secureHeaders } from 'hono/secure-headers';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import * as vb from 'valibot';
import { getConfig } from './lib/config';
import { ApiError, fromD1Error, notFound } from './lib/errors';
import * as v from './lib/validation';
import { csrfGuard } from './middleware/csrf';
import { principalOf, requireAuth } from './middleware/guards';
import { resolvePrincipal } from './middleware/principal';
import { queryParams } from './middleware/validate';
import admin from './routes/admin';
import auth from './routes/auth';
import devices from './routes/devices';
import legacy from './routes/legacy';
import locations from './routes/locations';
import me from './routes/me';
import { listScope } from './services/access';
import { countStats } from './services/devices';
import type { AppContext, AppEnv } from './types';

export const API_VERSION = '1';
const MAX_BODY_BYTES = 64 * 1024;

function errorResponse(c: AppContext, err: ApiError) {
	return c.json(
		{
			error: {
				code: err.code,
				message: err.message,
				...(err.details ? { details: err.details } : {}),
				requestId: c.get('requestId') ?? null,
			},
		},
		err.status,
	);
}

function toApiError(err: unknown): ApiError {
	if (err instanceof ApiError) return err;
	if (err instanceof HTTPException) {
		const status = err.status as ContentfulStatusCode;
		const code = status === 413 ? 'PAYLOAD_TOO_LARGE' : status === 401 ? 'UNAUTHENTICATED' : status === 403 ? 'FORBIDDEN' : 'BAD_REQUEST';
		return new ApiError(status, code, err.message || 'Bad request.');
	}
	return fromD1Error(err) ?? new ApiError(500, 'INTERNAL', 'Internal server error.');
}

export function createApp() {
	const v1 = new Hono<AppEnv>();
	v1.get('/health', c => c.json({ data: { status: 'ok', version: API_VERSION } }));
	v1.route('/auth', auth);
	v1.route('/me', me);
	v1.route('/admin', admin);
	v1.route('/locations', locations);
	v1.route('/devices', devices);
	v1.get('/stats', requireAuth, queryParams(vb.object({ all: v.booleanQuery })), async c => {
		const p = principalOf(c);
		return c.json({ data: await countStats(c.env.DB, listScope(p, c.req.valid('query'))) });
	});

	const app = new Hono<AppEnv>();

	app.use('*', async (c, next) => {
		const requestId = c.req.header('cf-ray') ?? crypto.randomUUID();
		c.set('requestId', requestId);
		c.set('principal', null);
		await next();
		c.header('X-Request-Id', requestId);
	});
	app.use(
		'/api/*',
		secureHeaders({ crossOriginResourcePolicy: false, crossOriginOpenerPolicy: false }),
		async (c, next) => {
			await next();
			c.header('Cache-Control', 'no-store');
		},
		cors({
			origin: (origin, c) => (getConfig(c.env as Env).corsOrigins.includes(origin) ? origin : null),
			credentials: true,
			allowMethods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
			allowHeaders: ['Content-Type', 'Authorization'],
			exposeHeaders: ['X-Request-Id'],
			maxAge: 600,
		}),
		bodyLimit({
			maxSize: MAX_BODY_BYTES,
			onError: () => {
				throw new ApiError(413, 'PAYLOAD_TOO_LARGE', `Request body exceeds ${MAX_BODY_BYTES} bytes.`);
			},
		}),
		resolvePrincipal,
		csrfGuard,
	);

	app.route('/api/v1', v1);
	app.route('/api', legacy);

	app.notFound(c => errorResponse(c, notFound('Route')));
	app.onError((err, c) => {
		const apiErr = toApiError(err);
		if (apiErr.status >= 500) {
			console.error(`app | ${c.req.method} ${c.req.path} failed [${c.get('requestId')}]: ${err instanceof Error ? (err.stack ?? err.message) : err}`);
		}
		return errorResponse(c, apiErr);
	});
	return app;
}

export const app = createApp();
