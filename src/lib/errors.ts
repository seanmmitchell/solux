import type { ContentfulStatusCode } from 'hono/utils/http-status';

export type ErrorDetail = { path: string; message: string };

export class ApiError extends Error {
	constructor(
		readonly status: ContentfulStatusCode,
		readonly code: string,
		message: string,
		readonly details?: ErrorDetail[],
	) {
		super(message);
		this.name = 'ApiError';
	}
}

export const notFound = (what = 'Resource') => new ApiError(404, 'NOT_FOUND', `${what} not found.`);
export const badRequest = (message: string) => new ApiError(400, 'BAD_REQUEST', message);
export const unauthenticated = (message = 'Authentication required.') => new ApiError(401, 'UNAUTHENTICATED', message);
export const forbidden = (message = 'You do not have permission to do that.') => new ApiError(403, 'FORBIDDEN', message);
export const conflict = (code: string, message: string) => new ApiError(409, code, message);
export const validationFailed = (details: ErrorDetail[], message = 'Invalid request.') =>
	new ApiError(400, 'VALIDATION_FAILED', message, details);
export const upstreamError = (message: string) => new ApiError(502, 'UPSTREAM_ERROR', message);

/** Maps SQLite constraint failures surfaced by D1 to API errors. */
export function fromD1Error(err: unknown): ApiError | null {
	const message = err instanceof Error ? err.message : String(err);
	if (message.includes('UNIQUE constraint failed')) {
		return conflict('CONFLICT', 'A conflicting resource already exists.');
	}
	if (message.includes('FOREIGN KEY constraint failed')) {
		return conflict('CONFLICT', 'The resource is referenced by, or references, another resource.');
	}
	return null;
}
