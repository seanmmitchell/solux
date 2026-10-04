import * as client from 'openid-client';
import type { OidcConfig } from '../lib/config';
import type { OidcClaims } from '../services/users';

const DISCOVERY_TTL_MS = 60 * 60_000;

let cached: { key: string; expires: number; promise: Promise<client.Configuration> } | null = null;

/** Clears the discovery cache (tests, or after config changes). */
export function resetOidcCache(): void {
	cached = null;
}

// Resolve fetch at call time so it can be observed/mocked.
const lateFetch: client.CustomFetch = (url, options) => globalThis.fetch(url, options as RequestInit);

/** Discovers and caches the IdP configuration for an hour (failures are not cached). */
export function getOidcConfiguration(oidc: OidcConfig): Promise<client.Configuration> {
	const key = JSON.stringify([oidc.issuer, oidc.clientId, oidc.clientSecret, oidc.tokenAuth, oidc.allowInsecure]);
	const now = Date.now();
	if (cached && cached.key === key && cached.expires > now) return cached.promise;

	const auth =
		oidc.tokenAuth === 'none'
			? client.None()
			: oidc.tokenAuth === 'client_secret_post'
				? client.ClientSecretPost(oidc.clientSecret)
				: client.ClientSecretBasic(oidc.clientSecret);
	// Verify ID token signatures against the IdP's JWKS even though they arrive over TLS.
	const execute: Array<(c: client.Configuration) => void> = [client.enableNonRepudiationChecks];
	if (oidc.allowInsecure) execute.push(client.allowInsecureRequests);

	const promise = client
		.discovery(new URL(oidc.issuer), oidc.clientId, undefined, auth, { execute, timeout: 10, [client.customFetch]: lateFetch })
		.then(config => {
			config[client.customFetch] = lateFetch;
			return config;
		});
	promise.catch(() => {
		if (cached?.promise === promise) cached = null;
	});
	cached = { key, expires: now + DISCOVERY_TTL_MS, promise };
	return promise;
}

export type LoginStart = { url: URL; state: string; nonce: string; codeVerifier: string };

export async function startLogin(oidc: OidcConfig, redirectUri: string): Promise<LoginStart> {
	const config = await getOidcConfiguration(oidc);
	const state = client.randomState();
	const nonce = client.randomNonce();
	const codeVerifier = client.randomPKCECodeVerifier();
	const url = client.buildAuthorizationUrl(config, {
		redirect_uri: redirectUri,
		scope: oidc.scopes,
		state,
		nonce,
		code_challenge: await client.calculatePKCECodeChallenge(codeVerifier),
		code_challenge_method: 'S256',
	});
	return { url, state, nonce, codeVerifier };
}

/**
 * Exchanges the authorization code and validates the ID token (signature,
 * issuer, audience, expiry, nonce) and PKCE. `callbackSearch` is the query
 * string the IdP sent to the callback.
 */
export async function completeLogin(
	oidc: OidcConfig,
	redirectUri: string,
	callbackSearch: string,
	checks: { state: string; nonce: string; codeVerifier: string },
): Promise<OidcClaims> {
	const config = await getOidcConfiguration(oidc);
	// Rebuild from the registered redirect URI so the token request's redirect_uri
	// matches exactly, even when the request arrived through a proxy.
	const currentUrl = new URL(redirectUri);
	currentUrl.search = callbackSearch;
	const tokens = await client.authorizationCodeGrant(config, currentUrl, {
		pkceCodeVerifier: checks.codeVerifier,
		expectedState: checks.state,
		expectedNonce: checks.nonce,
		idTokenExpected: true,
	});
	const claims = tokens.claims();
	if (!claims) throw new Error('No ID token returned');
	const str = (v: unknown) => (typeof v === 'string' && v.length > 0 ? v : null);
	return {
		issuer: claims.iss,
		subject: claims.sub,
		email: str(claims.email),
		emailVerified: claims.email_verified === true,
		name: str(claims.name) ?? str(claims.preferred_username),
	};
}

/** RP-initiated logout URL, or null if the IdP doesn't advertise end_session_endpoint. */
export async function buildLogoutUrl(oidc: OidcConfig, postLogoutRedirectUri: string): Promise<string | null> {
	const config = await getOidcConfiguration(oidc);
	if (!config.serverMetadata().end_session_endpoint) return null;
	return client.buildEndSessionUrl(config, { client_id: oidc.clientId, post_logout_redirect_uri: postLogoutRedirectUri }).toString();
}
