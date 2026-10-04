/**
 * Resolves a post-login redirect target. Accepts an app-relative path
 * ("/devices?x=1") or an absolute URL on an allowed origin. Anything else
 * falls back to the app root, preventing open redirects.
 */
export function resolveReturnTo(raw: string | undefined | null, appUrl: string, allowedOrigins: string[]): string {
	if (!raw) return appUrl;
	if (raw.startsWith('/')) {
		// Reject protocol-relative ("//evil") and backslash tricks ("/\evil").
		if (raw.startsWith('//') || raw.includes('\\') || /[\u0000-\u001f]/.test(raw)) return appUrl;
		try {
			const base = new URL(appUrl);
			const resolved = new URL(raw, base.origin);
			if (resolved.origin !== base.origin) return appUrl;
			return resolved.toString();
		} catch {
			return appUrl;
		}
	}
	try {
		const url = new URL(raw);
		if ((url.protocol === 'https:' || url.protocol === 'http:') && allowedOrigins.includes(url.origin)) return url.toString();
	} catch {
		// fall through
	}
	return appUrl;
}
