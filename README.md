# Solux
This project aims to leverage sunrise-sunset API data to automatically control my outdoor Govee smart lights so that they can toggle on and off in a more efficient and reasonable manner.

Solux is a Cloudflare Worker that provides:
- a multi-user API at `/api/v1`, where users sign in with OIDC or a personal API token;
- per-user locations and devices;
- cron jobs that switch each light at sunrise/sunset plus a per-device offset.

The API is documented in [docs/API.md](docs/API.md).

## Development
```bash
npm install
cp .dev.vars.example .dev.vars   # fill in the secrets
npm run db:migrate:local
npm run dev                      # http://localhost:8787
npm run typecheck && npm test
```

## Layout
| Path | Contents |
|---|---|
| `src/app.ts` | Hono app: global middleware and route mounting |
| `src/routes/` | HTTP handlers: auth, me, admin, locations, devices, legacy |
| `src/middleware/` | Principal resolution, guards, CSRF, validation |
| `src/services/` | Business logic and SQL (D1) |
| `src/oidc/` | OpenID Connect client |
| `src/integrations/` | Govee and sunrise-sunset.org clients |
| `src/jobs/` | Cron handlers: sun refresh, light operations, housekeeping |
| `migrations/` | D1 schema migrations |
| `test/` | Vitest tests running in the Workers runtime |

## Deploying (first time on v1)
1. Create the database, then copy the printed `database_id` into `wrangler.toml`:
   ```bash
   wrangler d1 create solux
   ```
2. Register an OIDC client with your identity provider:
   - Redirect URI: `https://<api-host>/api/v1/auth/callback`
   - Post-logout redirect URI: your app URL
   - Then set `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `SOLUX_APP_URL`, `SOLUX_CORS_ORIGINS` and `SOLUX_ADMIN_EMAILS` under `[vars]`.
   - Check the `[[ratelimits]]` `namespace_id` in `wrangler.toml` is unique in your Cloudflare account.
3. Add these GitHub Actions secrets. `CF_API_TOKEN` needs Workers Scripts:Edit and D1:Edit.
   - `CF_ACCOUNT_ID`
   - `CF_API_TOKEN`
   - `WRANGLER_GOVEE_API_KEY`
   - `WRANGLER_SOLUX_ADM_API_KEY` (at least 32 characters, e.g. `openssl rand -base64 32`; shorter keys disable break-glass)
   - `WRANGLER_OIDC_CLIENT_SECRET`
   - `WRANGLER_SOLUX_ENC_KEY` (generate with `openssl rand -base64 32`; **keep a backup**, since losing it makes stored Govee keys unreadable)
4. Merge to `main`. CI runs typecheck and tests, applies D1 migrations, then deploys.
5. Sign in with an email listed in `SOLUX_ADMIN_EMAILS`.
6. Import the pre-v1 KV data. Run a dry run first, then the real import:
   ```bash
   curl -X POST -H "Authorization: Bearer <admin token>" "https://<api-host>/api/v1/admin/import/legacy-kv?dryRun=true"
   curl -X POST -H "Authorization: Bearer <admin token>" "https://<api-host>/api/v1/admin/import/legacy-kv"
   ```
   Add `timezone=<IANA zone>` (e.g. `America/New_York`) to the query string to set it on the imported locations. The import fetches their sun times straight away.
   Lights are not automated between the deploy and the import. KV is left untouched, so you can roll back.

## License
This work is licensed under the MIT License.  
Please review [LICENSE](LICENSE.md) (LICENSE.md) for specifics.
