import worker from './worker';
import scapi from './module/ssapi';

import { Router } from 'itty-router';

const router = Router();

router.get('/api/module/location/refresh', async (request, ...args) => {
	await scapi.PullSunriseSunsetData(args[0])
	return new Response('Location Data Refreshed!');
});

router.get('/api/module/device/refresh', async (request, ...args) => {
	await worker.handleOperations(args[0])
	return new Response('Device Data Refreshed!');
});

export default router;
