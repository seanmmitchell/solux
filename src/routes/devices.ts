import { Hono } from 'hono';
import { z } from 'zod';
import { getConfig } from '../lib/config';
import { pageQuerySchema, toPageQuery } from '../lib/pagination';
import { deviceDto } from '../lib/serialize';
import * as v from '../lib/validation';
import { principalOf, requireAuth } from '../middleware/guards';
import { jsonBody, queryParams } from '../middleware/validate';
import { listScope, ownerForCreate } from '../services/access';
import { actorFrom } from '../services/audit';
import { createDevice, deleteDevice, deviceFor, listDevices, setDeviceState, updateDevice } from '../services/devices';
import type { AppEnv } from '../types';

const devices = new Hono<AppEnv>();
devices.use('*', requireAuth);

const deviceFields = {
	name: v.name,
	mac: v.mac,
	model: v.model,
	locationId: v.id,
	sunriseOffsetMin: v.offsetMin,
	sunsetOffsetMin: v.offsetMin,
	enabled: z.boolean(),
};

devices.get(
	'/',
	queryParams(pageQuerySchema.extend({ all: v.booleanQuery, ownerId: v.id.optional(), locationId: v.id.optional() })),
	async c => {
		const q = c.req.valid('query');
		const page = await listDevices(c.env.DB, listScope(principalOf(c), q), { locationId: q.locationId }, toPageQuery(q));
		return c.json({ data: page.items.map(row => deviceDto(row)), nextCursor: page.nextCursor });
	},
);

devices.post(
	'/',
	jsonBody(
		z.strictObject({
			...deviceFields,
			sunriseOffsetMin: deviceFields.sunriseOffsetMin.optional(),
			sunsetOffsetMin: deviceFields.sunsetOffsetMin.optional(),
			enabled: deviceFields.enabled.optional(),
			ownerId: v.id.optional(),
		}),
	),
	async c => {
		const db = c.env.DB;
		const body = c.req.valid('json');
		const ownerId = await ownerForCreate(db, principalOf(c), body.ownerId);
		const row = await createDevice(db, actorFrom(c), ownerId, body, { maxPerUser: getConfig(c.env).maxDevicesPerUser });
		return c.json({ data: deviceDto(row) }, 201);
	},
);

devices.get('/:id', async c => {
	const row = await deviceFor(c.env.DB, principalOf(c), c.req.param('id'));
	return c.json({ data: deviceDto(row) });
});

devices.patch('/:id', jsonBody(v.patchOf(deviceFields)), async c => {
	const db = c.env.DB;
	const row = await deviceFor(db, principalOf(c), c.req.param('id'));
	const updated = await updateDevice(db, actorFrom(c), row, c.req.valid('json'));
	return c.json({ data: deviceDto(updated) });
});

devices.delete('/:id', async c => {
	const db = c.env.DB;
	const row = await deviceFor(db, principalOf(c), c.req.param('id'));
	await deleteDevice(db, actorFrom(c), row);
	return c.body(null, 204);
});

devices.post('/:id/state', jsonBody(z.strictObject({ on: z.boolean() })), async c => {
	const db = c.env.DB;
	const row = await deviceFor(db, principalOf(c), c.req.param('id'));
	const result = await setDeviceState(db, getConfig(c.env), actorFrom(c), row, c.req.valid('json').on);
	return c.json({ data: result });
});

export default devices;
