import { Location } from "../worker";
import util from "./util";

export default {
    async GetLocationFromID(env: Env, id:number): Promise<Location> {
        console.debug("kv | Getting location data from KV...")
        let loc1 = await env.solux.get("loc1").catch(err => {
            console.error("kv | Failed to get location data from KV.\n\tError: " + err)
            return Promise.reject("Failed")
        })

        if (loc1 === null) {
            console.error("kv | Failed to get location data key from KV.")
            return Promise.reject("Failed")
        }
        console.debug("kv | Location data pulled.")
    
        console.debug("kv | Parsing location data pulled from KV...")
        loc1 = String(loc1)
        let locations:Array<Location> = JSON.parse(loc1)
        console.debug("kv | Parsed location data pulled from KV.")

        console.debug("kv | Searching location data pulled from KV...")
        for (let i = 0; i < locations.length; i++) {
            const location = locations[i];
            if (location.id == id) {
                console.log("kv | Location Data Found!")
                return Promise.resolve(location)
            }
        }
    
        console.error("kv | Location Data Not Found!")
        return Promise.reject("Not Found")
    },

    async GetTypeCount(env: Env, type: string): Promise<number> {
        console.debug(`kv | Getting type "${type}" count from KV...`)
        let list = await env.solux.list({prefix: type}).catch(err => {
            console.error("kv | Failed to get location data from KV.\n\tError: " + err)
            return Promise.reject("Failed")
        })

        if (list === null) {
            console.error("kv | Failed to get type data key from KV.")
            return Promise.reject("Failed")
        }
        let count = list.keys.length
        console.debug(`kv | Type "${type}" count=${count} from KV.`)
        return count
    },

    async GetTypeList(env: Env, type: string): Promise<Array<any>> {
        console.debug(`kv | List Type "${type}" from KV...`)
        let list = await env.solux.list({prefix: type}).catch(err => {
            console.error(`kv | List Type "${type}" from KV. -> Failed\n\tError: ${err}`)
            return Promise.reject("Failed")
        })

        if (list === null) {
            console.error(`kv | List Type "${type}" from KV. -> Null.`)
            return Promise.reject("Failed")
        }

        console.debug(`kv | List Type "${type}" from KV -> Returned`)
        return list.keys
    },
    async GetTypeGet(env: Env, type: string, id: string): Promise<any> {
        console.debug(`kv | Get Type "${type}" ID "${id}" from KV...`)
        let resource = await env.solux.get(type + id).catch(err => {
            console.error(`kv | Get Type "${type}" ID "${id}" from KV. -> Failed\n\tError: ${err}`)
            return Promise.reject("Failed")
        })

        if (resource === null) {
            console.error(`kv | Get Type "${type}" ID "${id}" from KV. -> Null.`)
            return Promise.reject("Failed")
        }

        console.debug(`kv | Get Type "${type}" ID "${id}" from KV -> Returned`)
        return resource
    }
}