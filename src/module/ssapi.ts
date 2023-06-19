import { Location } from "../worker";
import util from "./util";

type SunriseSunsetAPIResponse = {
	status: string;
	results: {
		sunrise: string;
		sunset: string;
	};
}

export default {
    async PullSunriseSunsetData(env: Env) {
        console.log("scapi | Pulling Sunrise and Sunset API Data...")

        console.log("scapi | Pulling location data from KV...")
        let loc1 = await env.solux.get("loc1").catch(err => {
            console.error("Failed to get location data from KV. Err: " + err)
            return
        })
        if (loc1 === null) {
            console.error("scapi | Failed to get location data from KV.")
            return
        }

        console.log("scapi | Parsing location data pulled from KV...")
        loc1 = String(loc1)
        let locations:Array<Location> = JSON.parse(loc1)

        console.log("scapi | Itterating over the list of locations...")
        for (let i = 0; i < locations.length; i++) {
            const location = locations[i];
            console.log(`scapi | Getting Data:\n\t` + util.LocationPrint(location))

            console.debug(`scapi | Sending Request: https://api.sunrise-sunset.org/json?lat=${location.lat}&lng=${location.lon}&formatted=0`)
            const init = {
                headers: {
                "content-type": "application/json;charset=UTF-8",
                },
            };

            await fetch(`https://api.sunrise-sunset.org/json?lat=${location.lat}&lng=${location.lon}&formatted=0`, init).then(async (response: Response) => {
                if (response.status != 200) {
                    console.error(`scapi | Error Getting Data: ${location.name}`)
                } else {
                    console.error(`scapi | Successfully Got Data: ${location.name}`)
                }

                const jsonData:SunriseSunsetAPIResponse = await response.json();
                
                if (jsonData.status != "OK") {
                    console.error("scapi | Error: Error Evaluating Data")
                }

                locations[i].sunriseTS = Date.parse(jsonData.results?.sunrise)
                locations[i].sunsetTS = Date.parse(jsonData.results?.sunset)
                locations[i].lastUpdated = Date.now()
                console.log(`scapi | Set Data: ${location.name} (${location.lat}, ${location.lon})`)	
            }).catch(err => {
                console.error(`scapi | Error Sending Data Request: ${location.name}\n\tError: ${err}`)
            });
        }
        console.log("scapi | Sunrise and Sunset API Data Pulled and Stored.")

        console.log("scapi | Pushing Sunrise and Sunset API Data...")
        let locationsJSON = JSON.stringify(locations)

        await env.solux.put("loc1", locationsJSON).catch(err => {
            console.error(`scapi | Failed to push Sunrise and Sunset API Data.\n\tError: ${err}`)
            return
        })
        console.log("scapi | Sunrise and Sunset API Data Pushed.")
    }
}