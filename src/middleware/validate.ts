import { validator } from 'hono/validator';
import type { z } from 'zod';
import { type ErrorDetail, validationFailed } from '../lib/errors';

function details(error: z.ZodError): ErrorDetail[] {
	return error.issues.map(i => ({ path: i.path.map(String).join('.'), message: i.message }));
}

/** Validates the JSON body; failures become 400 VALIDATION_FAILED with per-field details. */
export function jsonBody<T extends z.ZodType>(schema: T) {
	return validator('json', async (value): Promise<z.output<T>> => {
		const r = await schema.safeParseAsync(value);
		if (!r.success) throw validationFailed(details(r.error), 'Invalid request body.');
		return r.data;
	});
}

export function queryParams<T extends z.ZodType>(schema: T) {
	return validator('query', async (value): Promise<z.output<T>> => {
		const r = await schema.safeParseAsync(value);
		if (!r.success) throw validationFailed(details(r.error), 'Invalid query parameters.');
		return r.data;
	});
}
