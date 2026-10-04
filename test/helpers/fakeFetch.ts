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

/** sunrise-sunset.org stand-in: times derive from the requested `date` (default 11:00Z sunrise, 22:30Z sunset). */
export function sunApiRoute(
	opts: { sunrise?: (date: string) => string; sunset?: (date: string) => string; status?: number } = {},
): Route {
	const sunrise = opts.sunrise ?? (d => `${d}T11:00:00+00:00`);
	const sunset = opts.sunset ?? (d => `${d}T22:30:00+00:00`);
	return {
		match: url => url.hostname === 'api.sunrise-sunset.org',
		respond: url => {
			if (opts.status && opts.status !== 200) return new Response('boom', { status: opts.status });
			const date = url.searchParams.get('date') ?? '';
			return json({ status: 'OK', results: { sunrise: sunrise(date), sunset: sunset(date) } });
		},
	};
}

export function goveeRoute(status = 200): Route {
	return {
		match: url => url.hostname === 'developer-api.govee.com',
		respond: () => (status === 200 ? json({ code: 200, message: 'Success' }) : new Response('nope', { status })),
	};
}
