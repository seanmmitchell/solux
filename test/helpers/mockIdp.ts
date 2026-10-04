import { SignJWT, exportJWK, generateKeyPair } from 'jose';
import { base64UrlEncode } from '../../src/lib/crypto';
import { call, setCookies } from './app';
import { type Route, installFakeFetch, json } from './fakeFetch';

export const ISSUER = 'https://idp.test';
export const CLIENT_ID = 'solux-test';
export const CLIENT_SECRET = 'test-client-secret';
export const REDIRECT_URI = 'https://api.test/api/v1/auth/callback';

export type IdTokenClaims = { sub: string; email?: string; email_verified?: boolean; name?: string; [k: string]: unknown };

export type IdpKnobs = {
	claims: IdTokenClaims;
	/** Overrides for the ID token (e.g. aud, nonce, iss). */
	tokenOverrides?: Record<string, unknown>;
	/** Sign with a key that isn't in the JWKS. */
	foreignKey?: boolean;
};

/**
 * A fake OIDC provider served through the fetch spy: discovery, JWKS, and a
 * token endpoint that verifies client auth, the code and the PKCE verifier.
 */
export async function createMockIdp(initial: IdpKnobs = { claims: { sub: 'sub-1', email: 'sam@example.com', email_verified: true, name: 'Sam' } }) {
	const keys = await generateKeyPair('RS256', { extractable: true });
	const foreign = await generateKeyPair('RS256', { extractable: true });
	const jwk = { ...(await exportJWK(keys.publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' };

	let knobs = initial;
	const issued = new Map<string, { challenge: string; nonce: string; redirectUri: string }>();
	const tokenRequests: URLSearchParams[] = [];

	const routes: Route[] = [
		{
			match: url => url.href === `${ISSUER}/.well-known/openid-configuration`,
			respond: () =>
				json({
					issuer: ISSUER,
					authorization_endpoint: `${ISSUER}/authorize`,
					token_endpoint: `${ISSUER}/token`,
					jwks_uri: `${ISSUER}/jwks`,
					end_session_endpoint: `${ISSUER}/logout`,
					response_types_supported: ['code'],
					subject_types_supported: ['public'],
					id_token_signing_alg_values_supported: ['RS256'],
					code_challenge_methods_supported: ['S256'],
				}),
		},
		{ match: url => url.href === `${ISSUER}/jwks`, respond: () => json({ keys: [jwk] }) },
		{
			match: url => url.href === `${ISSUER}/token`,
			respond: async (_url, _init, request) => {
				const params = new URLSearchParams(await request.text());
				tokenRequests.push(params);
				// RFC 6749 §2.3.1: Basic credentials are form-urlencoded before base64.
				const [id, secret] = atob((request.headers.get('authorization') ?? '').replace(/^Basic /, ''))
					.split(':')
					.map(s => decodeURIComponent(s.replace(/\+/g, ' ')));
				if (id !== CLIENT_ID || secret !== CLIENT_SECRET) return json({ error: 'invalid_client' }, 401);
				const grant = issued.get(params.get('code') ?? '');
				if (params.get('grant_type') !== 'authorization_code' || !grant) return json({ error: 'invalid_grant' }, 400);
				if (params.get('redirect_uri') !== grant.redirectUri) return json({ error: 'invalid_grant', error_description: 'redirect_uri' }, 400);
				const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(params.get('code_verifier') ?? ''));
				if (base64UrlEncode(new Uint8Array(digest)) !== grant.challenge) return json({ error: 'invalid_grant', error_description: 'pkce' }, 400);
				issued.delete(params.get('code')!);

				const idToken = await new SignJWT({ nonce: grant.nonce, ...knobs.claims, ...knobs.tokenOverrides })
					.setProtectedHeader({ alg: 'RS256', kid: 'k1' })
					.setIssuer(String(knobs.tokenOverrides?.iss ?? ISSUER))
					.setAudience(String(knobs.tokenOverrides?.aud ?? CLIENT_ID))
					.setSubject(knobs.claims.sub)
					.setIssuedAt()
					.setExpirationTime('5m')
					.sign(knobs.foreignKey ? foreign.privateKey : keys.privateKey);
				return json({ access_token: 'at', token_type: 'Bearer', expires_in: 300, id_token: idToken });
			},
		},
	];
	const fake = installFakeFetch(routes);

	return {
		fake,
		tokenRequests,
		set(next: Partial<IdpKnobs>) {
			knobs = { ...knobs, ...next };
		},
		/** Starts login, "authenticates" at the IdP, and returns the authorize URL plus a callback query. */
		async begin(returnTo?: string) {
			const res = await call(`/api/v1/auth/login${returnTo ? `?returnTo=${encodeURIComponent(returnTo)}` : ''}`);
			const location = res.headers.get('location');
			if (res.status !== 302 || !location) throw new Error(`login did not redirect: ${res.status}`);
			const authorize = new URL(location);
			const flow = setCookies(res).get('__Host-solux_oidc');
			const code = `code-${crypto.randomUUID()}`;
			issued.set(code, {
				challenge: authorize.searchParams.get('code_challenge') ?? '',
				nonce: authorize.searchParams.get('nonce') ?? '',
				redirectUri: authorize.searchParams.get('redirect_uri') ?? '',
			});
			return {
				authorize,
				state: authorize.searchParams.get('state') ?? '',
				code,
				flowCookie: flow ? `__Host-solux_oidc=${flow.value}` : '',
			};
		},
		/** Full happy-path login; returns the callback response and the session Cookie header. */
		async login(returnTo?: string) {
			const b = await this.begin(returnTo);
			const res = await call(`/api/v1/auth/callback?code=${b.code}&state=${b.state}`, { cookie: b.flowCookie });
			const session = setCookies(res).get('__Host-solux_session');
			return { res, cookie: session?.value ? `__Host-solux_session=${session.value}` : null, sessionSetCookie: session?.raw ?? null };
		},
	};
}
