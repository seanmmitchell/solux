const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function base64UrlEncode(bytes: Uint8Array): string {
	let binary = '';
	for (const b of bytes) binary += String.fromCharCode(b);
	return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function base64UrlDecode(s: string): Uint8Array {
	const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4);
	return Uint8Array.from(atob(b64), c => c.charCodeAt(0));
}

/** URL-safe random string with `bytes` bytes of entropy. */
export function randomToken(bytes = 32): string {
	return base64UrlEncode(crypto.getRandomValues(new Uint8Array(bytes)));
}

export async function sha256Hex(input: string): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', encoder.encode(input));
	return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
}

/** Constant-time string comparison (hashing first so lengths always match). */
export async function timingSafeEqualStr(a: string, b: string): Promise<boolean> {
	const [ha, hb] = await Promise.all([
		crypto.subtle.digest('SHA-256', encoder.encode(a)),
		crypto.subtle.digest('SHA-256', encoder.encode(b)),
	]);
	return crypto.subtle.timingSafeEqual(ha, hb);
}

const keyCache = new Map<string, Promise<CryptoKey>>();

function importKey(keyB64: string): Promise<CryptoKey> {
	let key = keyCache.get(keyB64);
	if (!key) {
		const raw = Uint8Array.from(atob(keyB64), c => c.charCodeAt(0));
		key = crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
		keyCache.set(keyB64, key);
	}
	return key;
}

/** AES-256-GCM. Output format: `v1.<iv>.<ciphertext>` (base64url). `aad` binds the value to its owner. */
export async function encryptSecret(plaintext: string, keyB64: string, aad: string): Promise<string> {
	const iv = crypto.getRandomValues(new Uint8Array(12));
	const ct = await crypto.subtle.encrypt(
		{ name: 'AES-GCM', iv, additionalData: encoder.encode(aad) },
		await importKey(keyB64),
		encoder.encode(plaintext),
	);
	return `v1.${base64UrlEncode(iv)}.${base64UrlEncode(new Uint8Array(ct))}`;
}

export async function decryptSecret(blob: string, keyB64: string, aad: string): Promise<string> {
	const [version, iv, ct] = blob.split('.');
	if (version !== 'v1' || !iv || !ct) throw new Error('Unsupported secret format');
	const pt = await crypto.subtle.decrypt(
		{ name: 'AES-GCM', iv: base64UrlDecode(iv), additionalData: encoder.encode(aad) },
		await importKey(keyB64),
		base64UrlDecode(ct),
	);
	return decoder.decode(pt);
}
