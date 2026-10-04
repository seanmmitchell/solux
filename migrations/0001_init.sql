-- Solux v1 schema. Times are unix epoch milliseconds; ids are UUID strings.

CREATE TABLE users (
	id TEXT PRIMARY KEY,
	email TEXT,
	email_verified INTEGER NOT NULL DEFAULT 0,
	display_name TEXT,
	timezone TEXT,
	role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'admin')),
	status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled', 'invited')),
	-- AES-256-GCM "v1.<iv>.<ct>", AAD = users.id
	govee_key_enc TEXT,
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL,
	last_login_at INTEGER
);
CREATE INDEX users_email_idx ON users (email);
CREATE INDEX users_role_status_idx ON users (role, status);
CREATE INDEX users_created_idx ON users (created_at, id);

CREATE TABLE identities (
	id TEXT PRIMARY KEY,
	user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
	issuer TEXT NOT NULL,
	subject TEXT NOT NULL,
	email TEXT,
	created_at INTEGER NOT NULL,
	last_login_at INTEGER,
	UNIQUE (issuer, subject)
);
CREATE INDEX identities_user_idx ON identities (user_id);

CREATE TABLE sessions (
	id TEXT PRIMARY KEY,
	user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
	-- hex SHA-256 of the cookie value; the raw token is never stored
	token_hash TEXT NOT NULL UNIQUE,
	created_at INTEGER NOT NULL,
	last_seen_at INTEGER NOT NULL,
	idle_expires_at INTEGER NOT NULL,
	expires_at INTEGER NOT NULL,
	ip TEXT,
	user_agent TEXT
);
CREATE INDEX sessions_user_idx ON sessions (user_id);
CREATE INDEX sessions_expiry_idx ON sessions (expires_at);

CREATE TABLE api_tokens (
	id TEXT PRIMARY KEY,
	user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
	name TEXT NOT NULL,
	token_prefix TEXT NOT NULL,
	token_hash TEXT NOT NULL UNIQUE,
	-- space-separated subset of "read write admin"
	scopes TEXT NOT NULL,
	created_at INTEGER NOT NULL,
	last_used_at INTEGER,
	expires_at INTEGER
);
CREATE INDEX api_tokens_user_idx ON api_tokens (user_id);

CREATE TABLE locations (
	id TEXT PRIMARY KEY,
	owner_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
	name TEXT NOT NULL,
	lat REAL NOT NULL CHECK (lat BETWEEN -90 AND 90),
	lon REAL NOT NULL CHECK (lon BETWEEN -180 AND 180),
	timezone TEXT,
	sunrise_at INTEGER,
	sunset_at INTEGER,
	sun_updated_at INTEGER,
	sun_error TEXT,
	legacy_id INTEGER,
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL,
	-- target of the devices (location_id, owner_id) foreign key
	UNIQUE (id, owner_id)
);
CREATE INDEX locations_owner_idx ON locations (owner_id, created_at, id);
CREATE INDEX locations_created_idx ON locations (created_at, id);
CREATE UNIQUE INDEX locations_legacy_uq ON locations (legacy_id) WHERE legacy_id IS NOT NULL;

CREATE TABLE devices (
	id TEXT PRIMARY KEY,
	owner_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
	location_id TEXT NOT NULL,
	name TEXT NOT NULL,
	mac TEXT NOT NULL,
	model TEXT NOT NULL,
	sunrise_offset_min INTEGER NOT NULL DEFAULT 0 CHECK (sunrise_offset_min BETWEEN -720 AND 720),
	sunset_offset_min INTEGER NOT NULL DEFAULT 0 CHECK (sunset_offset_min BETWEEN -720 AND 720),
	enabled INTEGER NOT NULL DEFAULT 1,
	last_action TEXT CHECK (last_action IN ('on', 'off')),
	last_action_at INTEGER,
	last_action_source TEXT CHECK (last_action_source IN ('schedule', 'manual')),
	last_error TEXT,
	legacy_id INTEGER,
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL,
	UNIQUE (owner_id, mac),
	-- A device's location must belong to the same owner. NO ACTION (checked at statement end)
	-- lets a user delete cascade through both tables, while a direct delete of a location
	-- that still has devices fails.
	FOREIGN KEY (location_id, owner_id) REFERENCES locations (id, owner_id)
);
CREATE INDEX devices_owner_idx ON devices (owner_id, created_at, id);
CREATE INDEX devices_created_idx ON devices (created_at, id);
CREATE INDEX devices_location_idx ON devices (location_id);
CREATE UNIQUE INDEX devices_legacy_uq ON devices (legacy_id) WHERE legacy_id IS NOT NULL;

-- No foreign keys: audit rows must outlive the users and resources they describe.
CREATE TABLE audit_events (
	id TEXT PRIMARY KEY,
	created_at INTEGER NOT NULL,
	actor_user_id TEXT,
	actor_via TEXT NOT NULL CHECK (actor_via IN ('session', 'token', 'breakglass', 'system')),
	action TEXT NOT NULL,
	target_type TEXT,
	target_id TEXT,
	target_user_id TEXT,
	ip TEXT,
	user_agent TEXT,
	request_id TEXT,
	-- JSON; never secrets
	metadata TEXT
);
CREATE INDEX audit_created_idx ON audit_events (created_at, id);
CREATE INDEX audit_actor_idx ON audit_events (actor_user_id, created_at);
CREATE INDEX audit_target_user_idx ON audit_events (target_user_id, created_at);
CREATE INDEX audit_action_idx ON audit_events (action, created_at);
