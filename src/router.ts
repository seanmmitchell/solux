import worker from './worker';
import scapi from './module/ssapi';

import { IRequest, Router } from 'itty-router';
import kv from './module/kv';

const router = Router();

router.get('/api/stats', async (request, ...args) => {
	var locations = -1; var devices = -1;
	let tmpLocations = await kv.GetTypeCount(args[0], "loc").catch(error => {
		console.error("Err1: " + error)
	})
	if ((typeof(tmpLocations) == 'number') && tmpLocations > locations) {
		locations = tmpLocations
	}
	let tmpDevices = await kv.GetTypeCount(args[0], "dev").catch(error => {
		console.error("Err2: " + error)
	})
	if ((typeof(tmpDevices) == 'number') && tmpDevices > devices) {
		devices = tmpDevices
	}
	return new Response(
		JSON.stringify(
			{'locations': locations, 'devices': devices}
		), 
		{
			status: 200
		}
	);
});

const adminAuthMW = (request: IRequest, ...args) => {
	// Get Headers
	let requestHeaders = Object.fromEntries(request.headers);
	let apiToken = requestHeaders["x-api-token"]
	let cfip = requestHeaders["cf-connecting-ip"]
	let cfray = requestHeaders["cf-ray"]

	// Get Environment
	let env:Env = args[0]
	if (apiToken == undefined || env.SOLUX_ADM_API_KEY == undefined || apiToken !== env.SOLUX_ADM_API_KEY) {
		console.warn(`router | Admin API Auth Failed. IP: ${cfip} | RAY: ${cfray}`)
		return new Response(
			'Authorization Failed.', 
			{
				status: 403
			}
		)
	} else {
		console.debug(`router | Admin API Auth Success. IP: ${cfip} | RAY: ${cfray}`)
	}
}

const validateType = (request: IRequest) => {
	const type = request.params.type;

	const validTypes = ["dev", "loc"]

	if (!validTypes.includes(type)) {
		return new Response(
			JSON.stringify(
				{'success': false, 'error': 'invalid type'}
			), 
			{
				status: 400
			}
		)
	}
}

router.get('/api/admin/:type/lis', adminAuthMW, validateType, async (request, ...args) => {
	const type = request.params.type;

	let x = await kv.GetTypeList(args[0], type)
	return new Response(
		JSON.stringify(
			{'list': x}
		), 
		{
			status: 200
		}
	);
});
router.get('/api/admin/:type/get/:id', adminAuthMW, validateType, async (request, ...args) => {
	const type = request.params.type;
	const id = request.params.id;

	let x = await kv.GetTypeGet(args[0], type, id)
	return new Response(
		JSON.stringify(
			{'resource': x}
		), 
		{
			status: 200
		}
	);
});
/*router.post('/api/admin/device/set', async (request, ...args) => {
	await scapi.PullSunriseSunsetData(args[0])
	return new Response('Device Set');
});
router.post('/api/admin/device/del', async (request, ...args) => {
	await scapi.PullSunriseSunsetData(args[0])
	return new Response('Device Del');
});*/

router.get('/api/admin/legacy/location-refresh', adminAuthMW, async (request, ...args) => {
	await scapi.PullSunriseSunsetData(args[0])
	return new Response('Location Data Refreshed!');
});
router.get('/api/admin/legacy/device-refresh', adminAuthMW, async (request, ...args) => {
	await worker.handleOperations(args[0])
	return new Response('Device Data Refreshed!');
});

// Needed because our inital catch-all is for anything detected as a non-API request outside of itty-router.
router.all('*', async (request) => {
	return new Response('Not Found.', { status: 404 })
});

export default router;
