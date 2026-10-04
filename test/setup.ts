import { applyD1Migrations, reset } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { afterEach, beforeEach, vi } from 'vitest';
import { resetOidcCache } from '../src/oidc/client';

beforeEach(async () => {
	await reset();
	await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
	resetOidcCache();
	// No test may reach the network; tests opt in to fake routes via installFakeFetch().
	vi.spyOn(globalThis, 'fetch').mockImplementation(async input => {
		throw new Error(`Unexpected fetch: ${input instanceof Request ? input.url : String(input)}`);
	});
});

afterEach(() => {
	vi.restoreAllMocks();
	vi.useRealTimers();
});
