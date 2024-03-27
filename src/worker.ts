import apiRouter from './router';
import ssapi from './module/ssapi';
import govee from './module/govee';
import kv from "./module/kv";
import util from "./module/util";

export default {
	// API for Sunrise Sunset Data:
	// https://sunrise-sunset.org/api
	// https://api.sunrise-sunset.org/json?lat=40.253899929029224&lng=-75.23355024450176&formatted=0
	async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
		switch (event.cron) {
			case "0 */2 * * *":
				console.info('worker | Cron Sunset-Sunrise API Sync Start. (every 2h)')

				const ssapiStartTime = Date.now();
				
				await ssapi.PullSunriseSunsetData(env); 
				
				const ssapiEndTime = Date.now();
				const ssapiExecutionTime = ssapiEndTime - ssapiStartTime;
				
				console.info(`worker | Cron Sunset-Sunrise Complete in ${ssapiExecutionTime}ms.`);				
				break
			case "*/3 * * * *":
				console.info(`worker | Cron Opperation Sync Start (every 3m).`)

				const opsStartTime = Date.now();
				
				await handleOperations(env)
				
				const opsEndTime = Date.now();
				const opsEndTimeExecutionTime = opsEndTime - opsStartTime;

				console.info(`worker | Cron Opperation Sync Complete in ${opsEndTimeExecutionTime}ms.`)
				await handleOperations(env)
				break
			default:
				console.error(`worker | Unknown Cron Event: ${event.cron}`)
		}
	},

	// Handle Incoming Requests
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		const url = new URL(request.url);

		if (url.pathname.startsWith('/api/')) {
			return apiRouter.handle(request, env);
		} else {
			return new Response('Not Found.', { status: 404 })
		}
	},

	handleOperations
};

declare global {
	const GOVEE_API_KEY: string
	const SOLUX_ADM_API_KEY: string
}

export type Device = {
	id: number;
	name: string;
	mac: string;
	model: string;
	location: number;
	sunriseOffset: number;
	sunsetOffset: number;
}

export type Location = {
	id: number;
	name: string;
	lat: string;
	lon: string;
	sunriseTS: number;
	sunsetTS: number;
	lastUpdated: number;
}
  

async function handleOperations(env: Env) {
	console.log("worker | Getting device list from KV...")
	let dev1 = await env.solux.get("dev1").catch(err => {
		console.error("worker | Failed to get device data from KV. Err: " + err)
		return
	})
	if (dev1 === null) {
		console.error("worker | Failed to get device data from KV.")
		return
	}

	console.log("worker | Parsing device data pulled from KV...")
	dev1 = String(dev1)
	let devices:Array<Device> = JSON.parse(dev1)

	console.log("worker | Itterating over the list of devices...")
	for (let i = 0; i < devices.length; i++) {
		const device = devices[i];
		console.log(`worker | Getting Device Location :\n\t${util.DevicePrint(device)}`)

		const deviceLocation = await kv.GetLocationFromID(env, device.location)

		console.log(`worker | Got Device Location:\n\tDevice ID: ${device.id}\n\t${util.LocationPrint(deviceLocation)}\n\tSunrise Offset: ${device.sunriseOffset}\n\tSunset Offset: ${device.sunriseOffset}`)
		
		const now = new Date()
		
		// Convert sunrise and sunset ts to date objects
		const sunrise = new Date(deviceLocation.sunriseTS);
		const sunset = new Date(deviceLocation.sunsetTS);

		// Calculate the offset times for sunrise and sunset
		const sunriseOffset = new Date(sunrise.getTime() + (device.sunriseOffset * 60 * 1000));
		const sunsetOffset = new Date(sunset.getTime() + (device.sunsetOffset * 60 * 1000));

		/*var now = new Date(sunsetOffset)
		now = new Date(now.setMinutes(now.getMinutes()-1))
		console.debug("Now: " + now.toUTCString())

		console.debug("SR: " + sunriseOffset.toUTCString())
		console.debug("SS: " + sunsetOffset.toUTCString())*/

		// Are we within 2m of sunrise offset?
		if (Math.abs(sunriseOffset.getTime() - now.getTime()) <= 2*60*1000) {
			console.log(`worker | Device ${device.id} is within 2m of day.`);

			await govee.SetLightState(env, device, false)
		}

		// Are we within 2m of sunset offset?
		if (Math.abs(sunsetOffset.getTime() - now.getTime()) <= 2*60*1000) {
			console.log(`worker | Device ${device.id} is within 2m of night.`);

			await govee.SetLightState(env, device, true)
		}
	}
}