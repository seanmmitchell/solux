import { Hono } from 'hono';
import { z } from 'zod';
import type { IdentityRow } from '../db/rows';
import { getConfig } from '../lib/config';
import { clearSessionCookie } from '../lib/cookies';
import { forbidden, notFound } from '../lib/errors';
import { pageQuerySchema, toPageQuery } from '../lib/pagination';
import { apiTokenDto, auditDto, identityDto, sessionDto, userDto } from '../lib/serialize';
import * as v from '../lib/validation';
import { principalOf, requireAuth, requireSession, requireUser, userIdOf } from '../middleware/guards';
import { jsonBody, queryParams } from '../middleware/validate';
import { actorFrom, auditStmt, listAudit } from '../services/audit';
import { deleteSessionStmt, deleteUserSessionsStmt, listSessions } from '../services/sessions';
import { createApiToken, listApiTokens } from '../services/tokens';
import { deleteUser, requireUserRow, updateProfile } from '../services/users';
import type { AppEnv } from '../types';

const me = new Hono<AppEnv>();
me.use('*', requireAuth, requireUser);

me.get('/', async c => {
	const user = await requireUserRow(c.env.DB, userIdOf(c));
	return c.json({ data: userDto(user) });
});

me.patch(
	'/',
	jsonBody(
		v.patchOf({
			displayName: v.name.nullable(),
			timezone: v.timezone.nullable(),
			goveeApiKey: v.goveeApiKey.nullable(),
		}),
	),
	async c => {
		const db = c.env.DB;
		const user = await requireUserRow(db, userIdOf(c));
		const updated = await updateProfile(db, getConfig(c.env), actorFrom(c), user, c.req.valid('json'));
		return c.json({ data: userDto(updated) });
	},
);

me.delete('/', requireSession, jsonBody(z.object({ confirm: z.literal(true) })), async c => {
	await deleteUser(c.env.DB, actorFrom(c), userIdOf(c));
	clearSessionCookie(c);
	return c.body(null, 204);
});

me.get('/identities', async c => {
	const { results } = await c.env.DB.prepare('SELECT * FROM identities WHERE user_id = ? ORDER BY created_at')
		.bind(userIdOf(c))
		.all<IdentityRow>();
	return c.json({ data: results.map(identityDto) });
});

me.get('/sessions', async c => {
	const rows = await listSessions(c.env.DB, userIdOf(c));
	const current = principalOf(c).sessionId;
	return c.json({ data: rows.map(s => sessionDto(s, current)) });
});

me.delete('/sessions', async c => {
	const db = c.env.DB;
	const userId = userIdOf(c);
	await db.batch([
		deleteUserSessionsStmt(db, userId, principalOf(c).sessionId),
		auditStmt(db, actorFrom(c), { action: 'session.revoked_all', targetType: 'user', targetId: userId, targetUserId: userId, metadata: { exceptCurrent: true } }),
	]);
	return c.body(null, 204);
});

me.delete('/sessions/:id', async c => {
	const db = c.env.DB;
	const userId = userIdOf(c);
	const id = c.req.param('id');
	const res = await deleteSessionStmt(db, userId, id).run();
	if (!res.meta.changes) throw notFound('Session');
	await auditStmt(db, actorFrom(c), { action: 'session.revoked', targetType: 'session', targetId: id, targetUserId: userId }).run();
	return c.body(null, 204);
});

me.get('/tokens', async c => {
	const rows = await listApiTokens(c.env.DB, userIdOf(c));
	return c.json({ data: rows.map(apiTokenDto) });
});

me.post(
	'/tokens',
	requireSession,
	jsonBody(
		z.strictObject({
			name: v.name,
			scopes: z.array(z.enum(['read', 'write', 'admin'])).min(1),
			expiresInDays: z.number().int().min(1).max(365).optional(),
		}),
	),
	async c => {
		const db = c.env.DB;
		const p = principalOf(c);
		const userId = userIdOf(c);
		const body = c.req.valid('json');
		if (body.scopes.includes('admin') && p.role !== 'admin') throw forbidden('Only admins can create tokens with the admin scope.');
		const now = Date.now();
		const { token, row } = await createApiToken(db, userId, {
			name: body.name,
			scopes: body.scopes,
			expiresAt: body.expiresInDays ? now + body.expiresInDays * 86_400_000 : null,
		}, now);
		await auditStmt(db, actorFrom(c), { action: 'token.created', targetType: 'token', targetId: row.id, targetUserId: userId, metadata: { name: row.name, scopes: row.scopes } }, now).run();
		return c.json({ data: { ...apiTokenDto(row), token } }, 201);
	},
);

me.delete('/tokens/:id', async c => {
	const db = c.env.DB;
	const userId = userIdOf(c);
	const id = c.req.param('id');
	const res = await db.prepare('DELETE FROM api_tokens WHERE id = ? AND user_id = ?').bind(id, userId).run();
	if (!res.meta.changes) throw notFound('Token');
	await auditStmt(db, actorFrom(c), { action: 'token.revoked', targetType: 'token', targetId: id, targetUserId: userId }).run();
	return c.body(null, 204);
});

me.get('/audit', queryParams(pageQuerySchema), async c => {
	const page = await listAudit(c.env.DB, { involvingUserId: userIdOf(c) }, toPageQuery(c.req.valid('query')));
	return c.json({ data: page.items.map(auditDto), nextCursor: page.nextCursor });
});

export default me;
