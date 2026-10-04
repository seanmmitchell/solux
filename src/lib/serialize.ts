import type { ApiTokenRow, AuditRow, DeviceWithSunRow, IdentityRow, LocationRow, SessionRow, UserRow } from '../db/rows';

const iso = (ms: number | null | undefined): string | null => (ms == null ? null : new Date(ms).toISOString());

export function userDto(u: UserRow) {
	return {
		id: u.id,
		email: u.email,
		emailVerified: u.email_verified === 1,
		displayName: u.display_name,
		timezone: u.timezone,
		role: u.role,
		status: u.status,
		hasGoveeKey: u.govee_key_enc != null,
		createdAt: iso(u.created_at),
		lastLoginAt: iso(u.last_login_at),
	};
}

export function identityDto(i: IdentityRow) {
	return { id: i.id, issuer: i.issuer, email: i.email, createdAt: iso(i.created_at), lastLoginAt: iso(i.last_login_at) };
}

export function sessionDto(s: SessionRow, currentSessionId: string | undefined) {
	return {
		id: s.id,
		createdAt: iso(s.created_at),
		lastSeenAt: iso(s.last_seen_at),
		expiresAt: iso(Math.min(s.idle_expires_at, s.expires_at)),
		ip: s.ip,
		userAgent: s.user_agent,
		current: s.id === currentSessionId,
	};
}

export function apiTokenDto(t: ApiTokenRow) {
	return {
		id: t.id,
		name: t.name,
		prefix: t.token_prefix,
		scopes: t.scopes.split(' ').filter(Boolean),
		createdAt: iso(t.created_at),
		lastUsedAt: iso(t.last_used_at),
		expiresAt: iso(t.expires_at),
	};
}

export function locationDto(l: LocationRow) {
	return {
		id: l.id,
		ownerId: l.owner_id,
		name: l.name,
		lat: l.lat,
		lon: l.lon,
		timezone: l.timezone,
		sun: {
			sunriseAt: iso(l.sunrise_at),
			sunsetAt: iso(l.sunset_at),
			updatedAt: iso(l.sun_updated_at),
			error: l.sun_error,
		},
		createdAt: iso(l.created_at),
		updatedAt: iso(l.updated_at),
	};
}

export function deviceDto(d: DeviceWithSunRow) {
	return {
		id: d.id,
		ownerId: d.owner_id,
		locationId: d.location_id,
		name: d.name,
		mac: d.mac,
		model: d.model,
		sunriseOffsetMin: d.sunrise_offset_min,
		sunsetOffsetMin: d.sunset_offset_min,
		enabled: d.enabled === 1,
		schedule: {
			offAt: d.sunrise_at == null ? null : iso(d.sunrise_at + d.sunrise_offset_min * 60_000),
			onAt: d.sunset_at == null ? null : iso(d.sunset_at + d.sunset_offset_min * 60_000),
		},
		lastAction:
			d.last_action == null && d.last_error == null
				? null
				: { state: d.last_action, at: iso(d.last_action_at), source: d.last_action_source, error: d.last_error },
		createdAt: iso(d.created_at),
		updatedAt: iso(d.updated_at),
	};
}

export function auditDto(a: AuditRow) {
	let metadata: unknown = null;
	if (a.metadata) {
		try {
			metadata = JSON.parse(a.metadata);
		} catch {
			metadata = null;
		}
	}
	return {
		id: a.id,
		at: iso(a.created_at),
		action: a.action,
		actor: { userId: a.actor_user_id, via: a.actor_via },
		target: { type: a.target_type, id: a.target_id, userId: a.target_user_id },
		ip: a.ip,
		requestId: a.request_id,
		metadata,
	};
}
