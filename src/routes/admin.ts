import { Hono } from 'hono';
import * as vb from 'valibot';
import { defer } from '../lib/defer';
import { validationFailed } from '../lib/errors';
import { pageQuerySchema, toPageQuery } from '../lib/pagination';
import { auditDto, userDto } from '../lib/serialize';
import * as v from '../lib/validation';
import { principalOf, requireAdmin, requireAuth } from '../middleware/guards';
import { jsonBody, queryParams } from '../middleware/validate';
import { runLightOps } from '../jobs/lightOps';
import { runSunRefresh } from '../jobs/sunTimes';
import { actorFrom, auditStmt, listAudit } from '../services/audit';
import { importLegacyKv } from '../services/legacyImport';
import { deleteUserSessionsStmt } from '../services/sessions';
import { deleteUserTokensStmt } from '../services/tokens';
import { adminUpdateUser, deleteUser, inviteUser, listUsers, requireUserRow } from '../services/users';
import type { AppEnv } from '../types';

const admin = new Hono<AppEnv>();
admin.use('*', requireAuth, requireAdmin);

admin.get(
	'/users',
	queryParams(
		vb.object({
			...pageQuerySchema.entries,
			q: vb.optional(vb.pipe(vb.string(), vb.trim(), vb.minLength(1), vb.maxLength(100))),
			role: vb.optional(v.role),
			status: vb.optional(vb.picklist(['active', 'disabled', 'invited'])),
		}),
	),
	async c => {
		const q = c.req.valid('query');
		const page = await listUsers(c.env.DB, q, toPageQuery(q));
		return c.json({ data: page.items.map(userDto), nextCursor: page.nextCursor });
	},
);

admin.post('/users', jsonBody(vb.strictObject({ email: v.email, role: vb.optional(v.role, 'user') })), async c => {
	const body = c.req.valid('json');
	const user = await inviteUser(c.env.DB, actorFrom(c), body.email, body.role);
	return c.json({ data: userDto(user) }, 201);
});

admin.get('/users/:id', async c => {
	const user = await requireUserRow(c.env.DB, c.req.param('id'));
	return c.json({ data: userDto(user) });
});

admin.patch('/users/:id', jsonBody(v.patchOf({ role: v.role, status: v.userStatus, displayName: vb.nullable(v.name) })), async c => {
	const user = await adminUpdateUser(c.env.DB, actorFrom(c), c.req.param('id'), c.req.valid('json'));
	return c.json({ data: userDto(user) });
});

admin.delete('/users/:id', async c => {
	await deleteUser(c.env.DB, actorFrom(c), c.req.param('id'));
	return c.body(null, 204);
});

admin.post('/users/:id/sessions/revoke', jsonBody(vb.strictObject({ includeTokens: vb.optional(vb.boolean(), false) })), async c => {
	const db = c.env.DB;
	const user = await requireUserRow(db, c.req.param('id'));
	const { includeTokens } = c.req.valid('json');
	const results = await db.batch([
		deleteUserSessionsStmt(db, user.id),
		...(includeTokens ? [deleteUserTokensStmt(db, user.id)] : []),
		auditStmt(db, actorFrom(c), { action: 'session.revoked_all', targetType: 'user', targetId: user.id, targetUserId: user.id, metadata: { includeTokens } }),
	]);
	return c.json({
		data: {
			sessionsRevoked: results[0]?.meta.changes ?? 0,
			tokensRevoked: includeTokens ? (results[1]?.meta.changes ?? 0) : 0,
		},
	});
});

const isoTime = vb.pipe(vb.string(), vb.isoTimestamp(), vb.transform(s => Date.parse(s)), vb.number());

admin.get(
	'/audit',
	queryParams(
		vb.object({
			...pageQuerySchema.entries,
			action: vb.optional(vb.pipe(vb.string(), vb.maxLength(64))),
			actorId: vb.optional(v.id),
			targetUserId: vb.optional(v.id),
			since: vb.optional(isoTime),
			until: vb.optional(isoTime),
		}),
	),
	async c => {
		const q = c.req.valid('query');
		const page = await listAudit(c.env.DB, q, toPageQuery(q));
		return c.json({ data: page.items.map(row => auditDto(row)), nextCursor: page.nextCursor });
	},
);

admin.post('/import/legacy-kv', queryParams(vb.object({ dryRun: v.booleanQuery, ownerId: vb.optional(v.id), timezone: vb.optional(v.timezone) })), async c => {
	const q = c.req.valid('query');
	const ownerId = q.ownerId ?? principalOf(c).userId;
	if (!ownerId) throw validationFailed([{ path: 'ownerId', message: 'Required when using the break-glass key' }]);
	await requireUserRow(c.env.DB, ownerId);
	const report = await importLegacyKv(c.env, actorFrom(c), ownerId, { dryRun: q.dryRun, timezone: q.timezone });
	// Imported locations have no cached sun days yet; fill them now rather than at the next 2-hourly cron.
	if (!q.dryRun && report.locations.created > 0) defer(c, runSunRefresh(c.env), 'post-import sun refresh');
	return c.json({ data: report });
});

admin.post('/jobs/sun-refresh', async c => c.json({ data: await runSunRefresh(c.env) }));
admin.post('/jobs/light-ops', async c => c.json({ data: await runLightOps(c.env) }));

export default admin;
