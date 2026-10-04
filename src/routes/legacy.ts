import { Hono } from 'hono';
import { ApiError } from '../lib/errors';
import { countStats } from '../services/devices';
import type { AppEnv } from '../types';

/** Pre-v1 endpoints. /api/stats keeps its shape; the old admin API is gone. */
const legacy = new Hono<AppEnv>();

legacy.get('/stats', async c => {
	const stats = await countStats(c.env.DB, null);
	c.header('Deprecation', 'true');
	c.header('Link', '</api/v1/stats>; rel="successor-version"');
	return c.json({ locations: stats.locations, devices: stats.devices });
});

legacy.all('/admin/*', () => {
	throw new ApiError(410, 'GONE', 'The legacy admin API was removed. Use /api/v1/admin/* (see docs/API.md).');
});

export default legacy;
