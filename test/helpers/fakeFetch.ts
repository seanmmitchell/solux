import { vi } from 'vitest';

export type Route = {
	match: (url: URL, init: RequestInit) => boolean;
	respond: (url: URL, init: RequestInit, request: Request) => Response | Promise<Response>;
};

export type FetchCall = { url: URL; method: string; headers: Headers; body: string };

/**
 * Replaces globalThis.fetch with a route table. Unmatched URLs throw, so no
 * test can reach the network by accident. Returns the recorded calls.
 */
export function installFakeFetch(routes: Route[] = []) {
	const calls: FetchCall[] = [];
	const table = [...routes];
	const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
		const request = new Request(input, init);
		const url = new URL(request.url);
		const body = request.body ? new TextDecoder().decode(await request.clone().arrayBuffer()) : '';
		calls.push({ url, method: request.method, headers: request.headers, body });
		const route = table.find(r => r.match(url, init ?? {}));
		if (!route) throw new Error(`Unexpected fetch: ${request.method} ${url}`);
		return route.respond(url, init ?? {}, request);
	});
	return {
		calls,
		spy,
		add(route: Route) {
			table.unshift(route);
		},
	};
}

export const json = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

export function sunApiRoute(sunrise = '2026-10-04T11:00:00+00:00', sunset = '2026-10-04T22:30:00+00:00', status = 200): Route {
	return {
		match: url => url.hostname === 'api.sunrise-sunset.org',
		respond: () => (status === 200 ? json({ status: 'OK', results: { sunrise, sunset } }) : new Response('boom', { status })),
	};
}

export function goveeRoute(status = 200): Route {
	return {
		match: url => url.hostname === 'developer-api.govee.com',
		respond: () => (status === 200 ? json({ code: 200, message: 'Success' }) : new Response('nope', { status })),
	};
}
