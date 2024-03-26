import worker from './worker';
import scapi from './module/ssapi';

import { Router } from 'itty-router';
import kv from './module/kv';

const router = Router();

router.get('/stats', async (request, ...args) => {
	let locations = await kv.GetTypeCount(args[0], "loc")
	let devices = await kv.GetTypeCount(args[0], "dev")
	return new Response(`{'locations': ${locations}, 'devices': ${devices}}`);
});

router.get('/admin/location/get', async (request, ...args) => {
	await scapi.PullSunriseSunsetData(args[0])
	return new Response('Location Data Refreshed!');
});


router.get('/admin/device/refresh', async (request, ...args) => {
	await worker.handleOperations(args[0])
	return new Response('Device Data Refreshed!');
});


export default router;
