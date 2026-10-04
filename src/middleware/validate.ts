import { validator } from 'hono/validator';
import * as vb from 'valibot';
import { type ErrorDetail, validationFailed } from '../lib/errors';

function details(issues: vb.BaseIssue<unknown>[]): ErrorDetail[] {
	return issues.map(i => ({ path: vb.getDotPath(i) ?? '', message: i.message }));
}

/** Validates the JSON body; failures become 400 VALIDATION_FAILED with per-field details. */
export function jsonBody<T extends vb.GenericSchema>(schema: T) {
	return validator('json', async (value): Promise<vb.InferOutput<T>> => {
		const r = await vb.safeParseAsync(schema, value);
		if (!r.success) throw validationFailed(details(r.issues), 'Invalid request body.');
		return r.output;
	});
}

export function queryParams<T extends vb.GenericSchema>(schema: T) {
	return validator('query', async (value): Promise<vb.InferOutput<T>> => {
		const r = await vb.safeParseAsync(schema, value);
		if (!r.success) throw validationFailed(details(r.issues), 'Invalid query parameters.');
		return r.output;
	});
}
