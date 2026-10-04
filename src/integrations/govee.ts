// Govee developer API v1: https://developer-api.govee.com
const CONTROL_URL = 'https://developer-api.govee.com/v1/devices/control';
const TIMEOUT_MS = 10_000;

export class GoveeError extends Error {
	constructor(
		readonly status: number,
		message: string,
	) {
		super(message);
		this.name = 'GoveeError';
	}
}

/** Turns a light on or off. Throws GoveeError on a non-2xx response. Never logs the key. */
export async function setLightState(apiKey: string, device: { mac: string; model: string }, on: boolean): Promise<void> {
	const body = { device: device.mac, model: device.model, cmd: { name: 'turn', value: on ? 'on' : 'off' } };
	console.debug(`govee | Sending ${body.cmd.value} to ${device.mac} (${device.model})`);
	const res = await fetch(CONTROL_URL, {
		method: 'PUT',
		headers: { 'Content-Type': 'application/json', 'Govee-API-Key': apiKey },
		body: JSON.stringify(body),
		signal: AbortSignal.timeout(TIMEOUT_MS),
	});
	if (!res.ok) {
		const detail = (await res.text().catch(() => '')).slice(0, 200);
		throw new GoveeError(res.status, `Govee responded ${res.status}${detail ? `: ${detail}` : ''}`);
	}
}
