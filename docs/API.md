# Solux API v1

Base path: `/api/v1`. All request and response bodies are JSON (`Content-Type: application/json`) unless noted.

- [Authentication](#authentication)
- [Conventions](#conventions)
- [Resources](#resources)
- [Endpoints](#endpoints)
- [Local development](#local-development)

---

## Authentication

Three kinds of caller are supported. The first one present on a request wins; there is no fallback between them.

| Order | Mechanism | Who | How |
|---|---|---|---|
| 1 | API token | Scripts, CLIs, integrations | `Authorization: Bearer slx_…` |
| 2 | Break-glass key | Operator emergency access | `x-api-token: <SOLUX_ADM_API_KEY>` |
| 3 | Session cookie | The web UI (browser) | Set by the OIDC login flow |

An `Authorization` header that is present but invalid returns `401` (the cookie is not consulted).

### Browser login (OIDC)

The browser **navigates** (not `fetch`) to the login endpoint. The whole flow is redirects:

```
window.location.href = "/api/v1/auth/login?returnTo=" + encodeURIComponent("/devices");
```

1. `GET /api/v1/auth/login?returnTo=…` → `302` to the identity provider.
2. The user signs in at the IdP, which redirects to `GET /api/v1/auth/callback`.
3. The callback sets the session cookie and redirects (`302`) to `returnTo`. When `returnTo` is missing or not allowed, it redirects to the app root (`SOLUX_APP_URL`).
4. When login fails, the callback redirects to `SOLUX_APP_URL` with `?auth_error=<code>` added:

| `auth_error` | Meaning |
|---|---|
| `invalid_state` | Login took too long, was replayed, or ran in a different browser. Retry. |
| `access_denied` | The user cancelled at the IdP. |
| `idp_error` | The IdP returned an error, or the token was invalid. |
| `signup_closed` | No account exists and sign-ups are closed. |
| `email_not_allowed` | The email domain isn't allowed to sign up. |
| `email_unverified` | The IdP didn't mark the email as verified, and the policy requires that. |
| `account_disabled` | An admin disabled the account. |
| `server_error` | Unexpected failure. Retry or check the logs. |

`returnTo` is accepted if it is either:
- a path on the app (`/devices?tab=1`), or
- an absolute URL whose origin is in the CORS allowlist.

**Checking whether the user is signed in:** `GET /api/v1/me`. A `401 UNAUTHENTICATED` response means they are signed out.

**Logout:** `POST /api/v1/auth/logout` deletes the session and clears the cookie. If `endSessionUrl` in the response isn't `null`, navigate the browser to it to sign out of the IdP as well.

### Cookies, CORS and CSRF

- **Cookie name.** The session cookie is `__Host-solux_session` over HTTPS and `solux_session` over plain-HTTP localhost. It is `HttpOnly` and `SameSite=Lax`, so JavaScript cannot read it. Use `GET /me`.
- **Credentials.** Every `fetch` from the UI must send the cookie with `credentials: "include"`, or `"same-origin"` when the UI is served from the same origin.
- **CSRF.** Cookie-authenticated `POST`/`PATCH`/`DELETE` requests must come from an allowed `Origin`. Browsers set this header automatically, so no CSRF token is needed. A request that fails the check gets `403 CSRF_FAILED`. Bearer-token requests are exempt.
- **CORS.** Origins listed in `SOLUX_CORS_ORIGINS`, plus the `SOLUX_APP_URL` origin, get `Access-Control-Allow-Credentials: true`.
- **⚠️ `SameSite=Lax` cookies are not sent on cross-site `fetch`.** The UI and API must share a *site*, for example:
  - `app.example.com` and `api.example.com`, or
  - one origin, by serving the UI from the same Worker or proxying `/api` to it.

  In development, proxy `/api` from the UI dev server; see [Local development](#local-development).

### API tokens and scopes

Users create personal API tokens with `POST /me/tokens`. The plaintext value (`slx_…`) is returned **once**.

| Scope | Allows |
|---|---|
| `read` | `GET` endpoints |
| `write` | `POST`/`PATCH`/`DELETE` endpoints (requires `read`) |
| `admin` | `/admin/*`, but only while the token's owner is still an admin |

A browser session has every scope its user's role allows.

Some endpoints accept **sessions only**: minting tokens and deleting the account. They return `403 SESSION_REQUIRED` to bearer and break-glass callers.

### Roles

| Role | Can |
|---|---|
| `user` | Manage their own account, locations and devices |
| `admin` | Everything `user` can do, plus see and manage everyone's resources, users and the audit log |

The break-glass key acts as an admin with no user attached. Endpoints that need a real user, such as `/me`, return `403 USER_REQUIRED` to it.

---

## Conventions

### Envelopes

```jsonc
// single resource
{ "data": { … } }

// list
{ "data": [ … ], "nextCursor": "eyJ…" | null }

// error
{ "error": { "code": "VALIDATION_FAILED", "message": "Invalid request body.", "details": [ … ], "requestId": "8b1f…" } }
```

- `DELETE` returns `204 No Content` with an empty body.
- Every response has an `X-Request-Id` header, the same value as `error.requestId`.

### Pagination

List endpoints accept `?limit=` (1–100, default 50) and `?cursor=`. To get the next page, pass back the `nextCursor` from the previous response. `nextCursor: null` means there are no more pages. Lists are sorted newest first.

### Formats

- IDs are opaque strings (UUIDs).
- Times are ISO-8601 UTC strings (`"2026-10-04T18:22:05.123Z"`) or `null`.
- Field names are camelCase.

### Validation errors

```json
{
  "error": {
    "code": "VALIDATION_FAILED",
    "message": "Invalid request body.",
    "details": [ { "path": "lat", "message": "Number must be less than or equal to 90" } ],
    "requestId": "…"
  }
}
```

`PATCH` bodies are partial, but they must contain at least one field and **no unknown fields**.

### Error codes

| HTTP | `code` | When |
|---|---|---|
| 400 | `VALIDATION_FAILED` | The body, query or params fail validation (see `details`) |
| 400 | `BAD_REQUEST` | Malformed JSON or an unsupported request |
| 401 | `UNAUTHENTICATED` | No credentials, or credentials that are invalid or expired |
| 403 | `FORBIDDEN` | The caller's role doesn't allow this |
| 403 | `INSUFFICIENT_SCOPE` | The API token lacks the required scope |
| 403 | `USER_REQUIRED` | Break-glass key used on a user-only endpoint |
| 403 | `SESSION_REQUIRED` | The endpoint needs a browser session |
| 403 | `CSRF_FAILED` | Cookie-authenticated mutation from a disallowed origin |
| 404 | `NOT_FOUND` | Missing, or owned by someone else (ownership is never revealed) |
| 409 | `CONFLICT` | Generic uniqueness or state conflict |
| 409 | `LOCATION_IN_USE` | Deleting a location that devices still reference |
| 409 | `DEVICE_EXISTS` | The same MAC is already registered to this owner |
| 409 | `LAST_ADMIN` | The change would leave no active admin |
| 409 | `GOVEE_KEY_MISSING` | No Govee API key is available to control this device |
| 409 | `TOKEN_LIMIT` | The user already has the maximum of 25 API tokens |
| 410 | `GONE` | Legacy endpoint removed |
| 413 | `PAYLOAD_TOO_LARGE` | Body larger than 64 KB |
| 500 | `INTERNAL` / `CONFIG_ERROR` | Server bug or misconfiguration |
| 502 | `UPSTREAM_ERROR` | Govee or sunrise-sunset.org failed |

---

## Resources

### User
```json
{
  "id": "3f6c…",
  "email": "sam@example.com",
  "emailVerified": true,
  "displayName": "Sam",
  "timezone": "America/New_York",
  "role": "user",
  "status": "active",
  "hasGoveeKey": true,
  "createdAt": "2026-10-04T18:00:00.000Z",
  "lastLoginAt": "2026-10-04T18:00:00.000Z"
}
```
- `role`: `user` | `admin`.
- `status`: `active` | `disabled` | `invited`. An invited user is pre-created by an admin and becomes active on first login.
- The Govee API key itself is **never** returned; `hasGoveeKey` says whether one is set.

### Identity
```json
{ "id": "…", "issuer": "https://accounts.example.com", "email": "sam@example.com", "createdAt": "…", "lastLoginAt": "…" }
```

### Session
```json
{ "id": "…", "createdAt": "…", "lastSeenAt": "…", "expiresAt": "…", "ip": "203.0.113.4", "userAgent": "Mozilla/5.0 …", "current": true }
```
- `expiresAt` is the earlier of the idle timeout (default 7 days since last use) and the absolute timeout (default 30 days since login).

### ApiToken
```json
{ "id": "…", "name": "home-assistant", "prefix": "slx_AbCdEfGh", "scopes": ["read", "write"], "createdAt": "…", "lastUsedAt": null, "expiresAt": null }
```
The create response also contains `"token": "slx_…"`, and only that once.

### Location
```json
{
  "id": "…",
  "ownerId": "…",
  "name": "Home",
  "lat": 40.2539,
  "lon": -75.2335,
  "timezone": "America/New_York",
  "sun": {
    "sunriseAt": "2026-10-04T11:04:00.000Z",
    "sunsetAt": "2026-10-04T22:38:00.000Z",
    "updatedAt": "2026-10-04T18:00:00.000Z",
    "error": null
  },
  "createdAt": "…",
  "updatedAt": "…"
}
```
- `sun` is refreshed every 2 hours and right after the location is created or moved.
- `sun.error` holds the last refresh failure. When there is one, the previous times are kept.
- `timezone` (IANA name, optional but recommended) makes sure the sunrise and sunset values are for the location's local date.

### Device
```json
{
  "id": "…",
  "ownerId": "…",
  "locationId": "…",
  "name": "Porch",
  "mac": "AB:CD:EF:01:23:45:67:89",
  "model": "H6008",
  "sunriseOffsetMin": 0,
  "sunsetOffsetMin": -15,
  "enabled": true,
  "schedule": { "offAt": "2026-10-04T11:04:00.000Z", "onAt": "2026-10-04T22:23:00.000Z" },
  "lastAction": { "state": "on", "at": "…", "source": "schedule", "error": null },
  "createdAt": "…",
  "updatedAt": "…"
}
```
- Behaviour: the light turns **off** at sunrise + `sunriseOffsetMin` and **on** at sunset + `sunsetOffsetMin`. Offsets are in minutes, from −720 to 720.
- `schedule` is computed from the location's current sun times. Its fields are `null` when the sun times are unknown.
- `lastAction` is `null` until the first action. `lastAction.source` is `schedule` | `manual`.
- `mac` is the Govee device ID: 6 or 8 hex octets separated by colons, normalised to upper case.

### AuditEvent
```json
{
  "id": "…",
  "at": "…",
  "action": "device.created",
  "actor": { "userId": "…", "via": "session" },
  "target": { "type": "device", "id": "…", "userId": "…" },
  "ip": "203.0.113.4",
  "requestId": "…",
  "metadata": { "name": "Porch" }
}
```
- `actor.via`: `session` | `token` | `breakglass` | `system`.
- Actions:
  - Auth: `auth.login`, `auth.login_failed`, `auth.logout`
  - Users: `user.created`, `user.updated`, `user.role_changed`, `user.status_changed`, `user.deleted`, `user.govee_key_set`, `user.govee_key_cleared`
  - Sessions and tokens: `session.revoked`, `session.revoked_all`, `token.created`, `token.revoked`
  - Locations: `location.created`, `location.updated`, `location.deleted`, `location.refreshed`
  - Devices: `device.created`, `device.updated`, `device.deleted`, `device.state_set`
  - Other: `legacy.imported`, `breakglass.used`

---

## Endpoints

Auth column: **none**, **user** (session or token, with a real user), **session** (browser session only), **admin**, **any** (user or break-glass).

### Health and auth

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/health` | none | `{ "data": { "status": "ok", "version": "1" } }` |
| GET | `/auth/login?returnTo=` | none | `302` to the IdP |
| GET | `/auth/callback` | none | `302` to the app (sets the session) |
| POST | `/auth/logout` | none | Response is `{ "data": { "endSessionUrl": string \| null } }`. Safe to call when already signed out. |

### Current user (`/me`)

| Method | Path | Auth | Body | Response |
|---|---|---|---|---|
| GET | `/me` | user | — | `User` |
| PATCH | `/me` | user | `{ displayName?, timezone?, goveeApiKey? }` | `User` |
| DELETE | `/me` | session | `{ "confirm": true }` | `204`; clears the cookie; `409 LAST_ADMIN` |
| GET | `/me/identities` | user | — | `Identity[]` (no pagination) |
| GET | `/me/sessions` | user | — | `Session[]` (no pagination) |
| DELETE | `/me/sessions` | user | — | `204`; revokes every session **except** the current one |
| DELETE | `/me/sessions/:id` | user | — | `204` |
| GET | `/me/tokens` | user | — | `ApiToken[]` (no pagination) |
| POST | `/me/tokens` | session | `{ name, scopes, expiresInDays? }` | `201` with `ApiToken & { token }` |
| DELETE | `/me/tokens/:id` | user | — | `204` |
| GET | `/me/audit` | user | — | Paginated `AuditEvent[]` where the user is actor or target |

Field rules:
- `displayName`: string 1–100, or `null`.
- `timezone`: IANA zone, or `null`.
- `goveeApiKey`: string 8–128 to set the key, `null` to clear it.
- `scopes`: `["read"]`, `["read","write"]`, or either of those plus `"admin"` (admins only).
- `expiresInDays`: 1–365; leave it out for no expiry.

### Stats

| Method | Path | Auth | Response |
|---|---|---|---|
| GET | `/stats` | user | `{ locations, devices, enabledDevices }` for the caller. Admins can add `?all=true` for global counts. |

### Locations

| Method | Path | Auth | Body / query | Response |
|---|---|---|---|---|
| GET | `/locations` | any | `?limit&cursor`, admin-only `?all=true` or `?ownerId=` | Paginated `Location[]` |
| POST | `/locations` | any | `{ name, lat, lon, timezone?, ownerId? }` | `201 Location` |
| GET | `/locations/:id` | any | — | `Location` |
| PATCH | `/locations/:id` | any | `{ name?, lat?, lon?, timezone? }` | `Location` |
| DELETE | `/locations/:id` | any | — | `204`; `409 LOCATION_IN_USE` |
| POST | `/locations/:id/refresh` | any | — | `Location` with fresh `sun`; `502 UPSTREAM_ERROR` |

Notes:
- `ownerId` on create is admin-only; users always create for themselves.
- Break-glass callers must pass `ownerId` on create.
- "any" means the caller must own the resource or be an admin. Otherwise the response is `404`.

### Devices

| Method | Path | Auth | Body / query | Response |
|---|---|---|---|---|
| GET | `/devices` | any | `?locationId&limit&cursor`, admin-only `?all=true` or `?ownerId=` | Paginated `Device[]` |
| POST | `/devices` | any | `{ name, mac, model, locationId, sunriseOffsetMin?, sunsetOffsetMin?, enabled?, ownerId? }` | `201 Device`; `409 DEVICE_EXISTS` |
| GET | `/devices/:id` | any | — | `Device` |
| PATCH | `/devices/:id` | any | Any create field except `ownerId` | `Device` |
| DELETE | `/devices/:id` | any | — | `204` |
| POST | `/devices/:id/state` | any | `{ "on": boolean }` | `{ deviceId, on, at }`; `409 GOVEE_KEY_MISSING`; `502 UPSTREAM_ERROR` |

Notes:
- `locationId` must belong to the device's owner. If not, the response is `400 VALIDATION_FAILED` with `details[0].path = "locationId"`.
- Offsets default to `0`; `enabled` defaults to `true`.
- `model` matches `^[A-Za-z0-9_-]{2,32}$`.
- Govee commands use the owner's Govee API key from `PATCH /me`. Depending on deployment config, admins may fall back to the operator's key.

### Admin

| Method | Path | Body / query | Response |
|---|---|---|---|
| GET | `/admin/users` | `?q` (email or name contains), `?role`, `?status`, `?limit&cursor` | Paginated `User[]` |
| POST | `/admin/users` | `{ email, role? }` | `201 User` with `status: "invited"` |
| GET | `/admin/users/:id` | — | `User` |
| PATCH | `/admin/users/:id` | `{ role?, status?, displayName? }` | `User`; `409 LAST_ADMIN` |
| DELETE | `/admin/users/:id` | — | `204`; cascades to their sessions, tokens, locations and devices; `409 LAST_ADMIN` |
| POST | `/admin/users/:id/sessions/revoke` | `{ includeTokens?: boolean }` | `{ sessionsRevoked, tokensRevoked }` |
| GET | `/admin/audit` | `?action&actorId&targetUserId&since&until&limit&cursor` | Paginated `AuditEvent[]` |
| POST | `/admin/import/legacy-kv` | `?dryRun=true`, `?ownerId=` (required with break-glass) | Import report (see below) |
| POST | `/admin/jobs/sun-refresh` | — | `{ refreshed, failed }` |
| POST | `/admin/jobs/light-ops` | — | `{ checked, actions, errors }` |

Notes:
- `status: "disabled"` signs the user out everywhere and blocks their tokens. Their devices also stop being scheduled.
- `since` and `until` are ISO timestamps.
- The import copies the pre-v1 KV data (`loc*` and `dev*` JSON arrays) into the given owner's account. Running it again is a no-op.

Import report:
```json
{ "data": {
  "dryRun": false,
  "locations": { "created": 1, "skipped": 0, "invalid": [] },
  "devices":   { "created": 3, "skipped": 0, "invalid": [ { "legacyId": 4, "reason": "unknown location 9" } ] }
} }
```

### Legacy (pre-v1)

| Method | Path | Notes |
|---|---|---|
| GET | `/api/stats` | Public; `{ "locations": n, "devices": n }` global counts; `Deprecation: true` header |
| * | `/api/admin/*` | `410 GONE`; use the `/api/v1/admin/*` replacements |

---

## Local development

```bash
cp .dev.vars.example .dev.vars    # fill in the secrets
npm install
npm run db:migrate:local
npm run dev                       # API on http://localhost:8787
```

Run the UI dev server with a proxy, so the UI and API share an origin and the cookie works:

```ts
// vite.config.ts
export default { server: { proxy: { "/api": "http://localhost:8787" } } };
```

Then set the following in `.dev.vars`:

```
SOLUX_APP_URL=http://localhost:5173
SOLUX_CORS_ORIGINS=http://localhost:5173
OIDC_REDIRECT_URI=http://localhost:5173/api/v1/auth/callback
```

Register `http://localhost:5173/api/v1/auth/callback` as a redirect URI with the IdP.

To call the API without a browser:

```bash
curl -H "x-api-token: $SOLUX_ADM_API_KEY" http://localhost:8787/api/v1/admin/users
curl -H "Authorization: Bearer slx_…"      http://localhost:8787/api/v1/devices
```
