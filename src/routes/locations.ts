import { Hono } from 'hono';
import { z } from 'zod';
import { getConfig } from '../lib/config';
import { defer } from '../lib/defer';
import { upstreamError } from '../lib/errors';
import { pageQuerySchema, toPageQuery } from '../lib/pagination';
import { locationDto } from '../lib/serialize';
import * as v from '../lib/validation';
import { principalOf, requireAuth } from '../middleware/guards';
import { jsonBody, queryParams } from '../middleware/validate';
import { listScope, ownerForCreate } from '../services/access';
import { actorFrom, auditStmt } from '../services/audit';
import { createLocation, deleteLocation, listLocations, locationFor, refreshSunTimes, updateLocation } from '../services/locations';
import type { AppEnv } from '../types';

const locations = new Hono<AppEnv>();
locations.use('*', requireAuth);

locations.get('/', queryParams(pageQuerySchema.extend({ all: v.booleanQuery, ownerId: v.id.optional() })), async c => {
	const q = c.req.valid('query');
	const page = await listLocations(c.env.DB, listScope(principalOf(c), q), toPageQuery(q));
	return c.json({ data: page.items.map(locationDto), nextCursor: page.nextCursor });
});

locations.post(
	'/',
	jsonBody(z.strictObject({ name: v.name, lat: v.lat, lon: v.lon, timezone: v.timezone.nullish(), ownerId: v.id.optional() })),
	async c => {
		const db = c.env.DB;
		const body = c.req.valid('json');
		const ownerId = await ownerForCreate(db, principalOf(c), body.ownerId);
		const row = await createLocation(db, actorFrom(c), ownerId, body, { maxPerUser: getConfig(c.env).maxLocationsPerUser });
		defer(c, refreshSunTimes(db, row), 'initial sun refresh');
		return c.json({ data: locationDto(row) }, 201);
	},
);

locations.get('/:id', async c => {
	const row = await locationFor(c.env.DB, principalOf(c), c.req.param('id'));
	return c.json({ data: locationDto(row) });
});

locations.patch('/:id', jsonBody(v.patchOf({ name: v.name, lat: v.lat, lon: v.lon, timezone: v.timezone.nullable() })), async c => {
	const db = c.env.DB;
	const row = await locationFor(db, principalOf(c), c.req.param('id'));
	const { location, moved } = await updateLocation(db, actorFrom(c), row, c.req.valid('json'));
	if (moved) defer(c, refreshSunTimes(db, location), 'sun refresh after move');
	return c.json({ data: locationDto(location) });
});

locations.delete('/:id', async c => {
	const db = c.env.DB;
	const row = await locationFor(db, principalOf(c), c.req.param('id'));
	await deleteLocation(db, actorFrom(c), row);
	return c.body(null, 204);
});

locations.post('/:id/refresh', async c => {
	const db = c.env.DB;
	const row = await locationFor(db, principalOf(c), c.req.param('id'));
	const { location, ok } = await refreshSunTimes(db, row, { force: true });
	if (!ok) throw upstreamError(`Could not refresh sun times: ${location.sun_error}`);
	await auditStmt(db, actorFrom(c), { action: 'location.refreshed', targetType: 'location', targetId: row.id, targetUserId: row.owner_id }).run();
	return c.json({ data: locationDto(location) });
});

export default locations;
