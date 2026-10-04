import type { Role, UserStatus } from '../types';

export type UserRow = {
	id: string;
	email: string | null;
	email_verified: number;
	display_name: string | null;
	timezone: string | null;
	role: Role;
	status: UserStatus;
	govee_key_enc: string | null;
	created_at: number;
	updated_at: number;
	last_login_at: number | null;
};

export type IdentityRow = {
	id: string;
	user_id: string;
	issuer: string;
	subject: string;
	email: string | null;
	created_at: number;
	last_login_at: number | null;
};

export type SessionRow = {
	id: string;
	user_id: string;
	token_hash: string;
	created_at: number;
	last_seen_at: number;
	idle_expires_at: number;
	expires_at: number;
	ip: string | null;
	user_agent: string | null;
};

export type ApiTokenRow = {
	id: string;
	user_id: string;
	name: string;
	token_prefix: string;
	token_hash: string;
	scopes: string;
	created_at: number;
	last_used_at: number | null;
	expires_at: number | null;
};

export type LocationRow = {
	id: string;
	owner_id: string;
	name: string;
	lat: number;
	lon: number;
	timezone: string | null;
	sunrise_at: number | null;
	sunset_at: number | null;
	sun_updated_at: number | null;
	sun_error: string | null;
	sun_days: string | null;
	legacy_id: number | null;
	created_at: number;
	updated_at: number;
};

export type DeviceRow = {
	id: string;
	owner_id: string;
	location_id: string;
	name: string;
	mac: string;
	model: string;
	sunrise_offset_min: number;
	sunset_offset_min: number;
	enabled: number;
	last_action: 'on' | 'off' | null;
	last_action_at: number | null;
	last_action_source: 'schedule' | 'manual' | null;
	last_error: string | null;
	last_error_at: number | null;
	last_target_at: number | null;
	legacy_id: number | null;
	created_at: number;
	updated_at: number;
};

/** Device joined with its location's sun times. */
export type DeviceWithSunRow = DeviceRow & { sun_days: string | null };

export type AuditRow = {
	id: string;
	created_at: number;
	actor_user_id: string | null;
	actor_via: 'session' | 'token' | 'breakglass' | 'system';
	action: string;
	target_type: string | null;
	target_id: string | null;
	target_user_id: string | null;
	ip: string | null;
	user_agent: string | null;
	request_id: string | null;
	metadata: string | null;
};
