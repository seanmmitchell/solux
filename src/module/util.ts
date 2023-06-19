import { Device, Location } from "../worker"

export default {
    DevicePrint(device:Device): string {
        return `Device ID: ${device.id}\n\tMAC: ${device.mac}\n\tModel:  ${device.model}\n\tLocation: ${device.location}`
    },
    LocationPrint(location:Location): string {
        return `Location ID:  ${location.id}\n\tName: ${location.name}\n\tCords: (${location.lat}, ${location.lon})
        \tSunrise: ${new Date(location.sunriseTS).toUTCString()} (${location.sunriseTS})
        \tSunset: ${new Date(location.sunsetTS).toUTCString()} (${location.sunsetTS})`
    }
}