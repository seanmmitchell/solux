import { fileURLToPath } from 'node:url';
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

export default defineConfig(async () => {
	const migrations = await readD1Migrations(fileURLToPath(new URL('./migrations', import.meta.url)));
	return {
		plugins: [
			cloudflareTest({
				wrangler: { configPath: './wrangler.toml' },
				miniflare: {
					// Cron triggers are exercised directly in tests.
					triggers: undefined,
					bindings: {
						TEST_MIGRATIONS: migrations,
						SOLUX_APP_URL: 'https://app.test',
						SOLUX_CORS_ORIGINS: 'https://app.test',
						OIDC_ISSUER: 'https://idp.test',
						OIDC_CLIENT_ID: 'solux-test',
						OIDC_CLIENT_SECRET: 'test-client-secret',
						OIDC_REDIRECT_URI: 'https://api.test/api/v1/auth/callback',
						SOLUX_SIGNUP_POLICY: 'open',
						SOLUX_ADMIN_EMAILS: 'boss@example.com',
						GOVEE_API_KEY: 'operator-govee-key',
						SOLUX_ADM_API_KEY: 'breakglass-test-key',
						// 32 zero bytes, base64
						SOLUX_ENC_KEY: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
					},
				},
			}),
		],
		test: {
			setupFiles: ['./test/setup.ts'],
		},
	};
});
