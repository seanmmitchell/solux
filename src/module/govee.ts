import { Device } from "../worker";
import util from "./util";

export default {
    async SetLightState(env:Env, device:Device, state:boolean) {
        console.debug(`govee | Recieved SetLightState:\n\t${util.DevicePrint(device)}`)
        // Send command to device
        let data = {
            device: device.mac,
            model: device.model,
            cmd: {
            name: "turn",
            value: (state ? "on" : "off")
            }
        };

        console.debug(`govee | Sending Request:\n\t${JSON.stringify(data)}`)

        let response = await fetch("https://developer-api.govee.com/v1/devices/control", {
            method: "PUT",
            headers: {
                'Content-Type': 'application/json',
                'Govee-API-Key': env.GOVEE_API_KEY
            },
            body: JSON.stringify(data),
        });

        if (response.ok){
            console.log(`govee | SetLightState Successful!\n\t${device.id}`)
        } else {
            console.error(`govee | SetLightState FAILED!\n\t${device.id}\n\tResponse:\n\t\t${response.status}\n\t\t${response.statusText}`)
        }
    }
}