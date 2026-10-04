import { ApiError } from './errors';

export type SignupPolicy = 'closed' | 'domain' | 'open';
export type TokenAuthMethod = 'client_secret_basic' | 'client_secret_post' | 'none';
export type SameSite = 'Lax' | 'Strict' | 'None';
export type GoveeFallbackPolicy = 'admins' | 'none';

/** Browsers cap cookie lifetime at 400 days. */
export const MAX_SESSION_HOURS = 9600;
/** Shorter break-glass keys are refused (break-glass is disabled). */
export const MIN_BREAKGLASS_KEY_LENGTH = 32;

export type OidcConfig = {
	issuer: string;
	clientId: string;
	clientSecret: string;
	/** null = derive from the request origin. */
	redirectUri: string | null;
	scopes: string;
	tokenAuth: TokenAuthMethod;
	rpLogout: boolean;
	allowInsecure: boolean;
};

export type Config = {
	/** null = this Worker's own origin. */
	appUrl: string | null;
	corsOrigins: string[];
	oidc: OidcConfig | null;
	signupPolicy: SignupPolicy;
	allowedEmailDomains: string[];
	adminEmails: string[];
	firstUserAdmin: boolean;
	sessionIdleTtlMs: number;
	sessionAbsoluteTtlMs: number;
	sameSite: SameSite;
	goveeFallbackPolicy: GoveeFallbackPolicy;
	goveeApiKey: string | null;
	auditRetentionDays: number;
	maxLocationsPerUser: number;
	maxDevicesPerUser: number;
	breakglassKey: string | null;
	encKey: string | null;
};

const cache = new WeakMap<object, Config>();

/** Parses and validates configuration from the Worker env. Memoised per env object. */
export function getConfig(env: Env): Config {
	let config = cache.get(env);
	if (!config) {
		config = parseConfig(env);
		cache.set(env, config);
	}
	return config;
}

function parseConfig(env: Env): Config {
	const problems: string[] = [];

	const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
	const list = (v: unknown) => str(v).split(',').map(s => s.trim()).filter(Boolean);
	const bool = (name: string, v: unknown) => {
		const s = str(v).toLowerCase();
		if (s === '' || s === 'false' || s === '0') return false;
		if (s === 'true' || s === '1') return true;
		problems.push(`${name} must be true or false`);
		return false;
	};
	const oneOf = <T extends string>(name: string, v: unknown, allowed: readonly T[], fallback: T): T => {
		const s = str(v);
		if (s === '') return fallback;
		if ((allowed as readonly string[]).includes(s)) return s as T;
		problems.push(`${name} must be one of ${allowed.join(', ')}`);
		return fallback;
	};
	const positive = (name: string, v: unknown, fallback: number) => {
		const s = str(v);
		if (s === '') return fallback;
		const n = Number(s);
		if (!Number.isFinite(n) || n <= 0) {
			problems.push(`${name} must be a positive number`);
			return fallback;
		}
		return n;
	};
	const url = (name: string, v: unknown) => {
		const s = str(v);
		if (s === '') return null;
		try {
			return new URL(s).toString().replace(/\/$/, '');
		} catch {
			problems.push(`${name} must be an absolute URL`);
			return null;
		}
	};
	/** Validated but kept verbatim: it must match the IdP registration byte for byte. */
	const exactUrl = (name: string, v: unknown) => {
		const s = str(v);
		if (s === '') return null;
		if (!URL.canParse(s)) {
			problems.push(`${name} must be an absolute URL`);
			return null;
		}
		return s;
	};

	const appUrl = url('SOLUX_APP_URL', env.SOLUX_APP_URL);
	const corsOrigins: string[] = [];
	for (const o of list(env.SOLUX_CORS_ORIGINS)) {
		try {
			corsOrigins.push(new URL(o).origin);
		} catch {
			problems.push(`SOLUX_CORS_ORIGINS entry "${o}" is not a URL`);
		}
	}
	if (appUrl) corsOrigins.push(new URL(appUrl).origin);

	const issuer = url('OIDC_ISSUER', env.OIDC_ISSUER);
	const clientId = str(env.OIDC_CLIENT_ID);
	const tokenAuth = oneOf<TokenAuthMethod>('OIDC_TOKEN_AUTH', env.OIDC_TOKEN_AUTH, ['client_secret_basic', 'client_secret_post', 'none'], 'client_secret_basic');
	let oidc: OidcConfig | null = null;
	if (issuer && clientId) {
		oidc = {
			issuer: str(env.OIDC_ISSUER),
			clientId,
			clientSecret: str(env.OIDC_CLIENT_SECRET),
			redirectUri: exactUrl('OIDC_REDIRECT_URI', env.OIDC_REDIRECT_URI),
			scopes: str(env.OIDC_SCOPES) || 'openid email profile',
			tokenAuth,
			rpLogout: bool('OIDC_RP_LOGOUT', env.OIDC_RP_LOGOUT),
			allowInsecure: bool('OIDC_ALLOW_INSECURE', env.OIDC_ALLOW_INSECURE),
		};
		if (tokenAuth !== 'none' && !oidc.clientSecret) problems.push('OIDC_CLIENT_SECRET is required unless OIDC_TOKEN_AUTH=none');
		if (!oidc.scopes.split(/\s+/).includes('openid')) problems.push('OIDC_SCOPES must include openid');
	}

	const sameSite = oneOf<SameSite>('SESSION_COOKIE_SAMESITE', env.SESSION_COOKIE_SAMESITE, ['Lax', 'Strict', 'None'], 'Lax');
	const idleHours = positive('SESSION_IDLE_TTL_HOURS', env.SESSION_IDLE_TTL_HOURS, 168);
	const absoluteHours = positive('SESSION_ABSOLUTE_TTL_HOURS', env.SESSION_ABSOLUTE_TTL_HOURS, 720);
	if (absoluteHours > MAX_SESSION_HOURS) problems.push(`SESSION_ABSOLUTE_TTL_HOURS must be at most ${MAX_SESSION_HOURS}`);

	let breakglassKey = str(env.SOLUX_ADM_API_KEY) || null;
	if (breakglassKey && breakglassKey.length < MIN_BREAKGLASS_KEY_LENGTH) {
		// Don't fail the whole Worker; just refuse a guessable key.
		console.error(`config | SOLUX_ADM_API_KEY is shorter than ${MIN_BREAKGLASS_KEY_LENGTH} characters; break-glass access is disabled.`);
		breakglassKey = null;
	}
	if (str(env.GOVEE_FALLBACK_POLICY) === 'all') {
		problems.push('GOVEE_FALLBACK_POLICY=all was removed: it let any user drive the operator\'s devices. Use admins or none.');
	}

	const encKey = str(env.SOLUX_ENC_KEY) || null;
	if (encKey && decodedLength(encKey) !== 32) problems.push('SOLUX_ENC_KEY must be base64 of exactly 32 bytes');

	const config: Config = {
		appUrl,
		corsOrigins: [...new Set(corsOrigins)],
		oidc,
		signupPolicy: oneOf<SignupPolicy>('SOLUX_SIGNUP_POLICY', env.SOLUX_SIGNUP_POLICY, ['closed', 'domain', 'open'], 'closed'),
		allowedEmailDomains: list(env.OIDC_ALLOWED_EMAIL_DOMAINS).map(d => d.toLowerCase().replace(/^@/, '')),
		adminEmails: list(env.SOLUX_ADMIN_EMAILS).map(e => e.toLowerCase()),
		firstUserAdmin: bool('SOLUX_FIRST_USER_ADMIN', env.SOLUX_FIRST_USER_ADMIN),
		sessionIdleTtlMs: Math.min(idleHours, absoluteHours) * 3_600_000,
		sessionAbsoluteTtlMs: absoluteHours * 3_600_000,
		sameSite,
		goveeFallbackPolicy: str(env.GOVEE_FALLBACK_POLICY) === 'all' ? 'none' : oneOf<GoveeFallbackPolicy>('GOVEE_FALLBACK_POLICY', env.GOVEE_FALLBACK_POLICY, ['admins', 'none'], 'admins'),
		goveeApiKey: str(env.GOVEE_API_KEY) || null,
		auditRetentionDays: positive('AUDIT_RETENTION_DAYS', env.AUDIT_RETENTION_DAYS, 365),
		maxLocationsPerUser: Math.floor(positive('MAX_LOCATIONS_PER_USER', env.MAX_LOCATIONS_PER_USER, 25)),
		maxDevicesPerUser: Math.floor(positive('MAX_DEVICES_PER_USER', env.MAX_DEVICES_PER_USER, 100)),
		breakglassKey,
		encKey,
	};

	if (problems.length > 0) {
		console.error(`config | Invalid configuration:\n\t${problems.join('\n\t')}`);
		throw new ApiError(500, 'CONFIG_ERROR', 'The server is misconfigured.');
	}
	return config;
}

function decodedLength(b64: string): number {
	try {
		return atob(b64).length;
	} catch {
		return -1;
	}
}
