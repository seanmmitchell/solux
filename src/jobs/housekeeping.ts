import { getConfig } from '../lib/config';

const DAY_MS = 86_400_000;
/** Expired API tokens stay listed (as expired) for this long before being purged. */
const EXPIRED_TOKEN_GRACE_MS = 30 * DAY_MS;

/** Purges expired sessions, login flows and tokens, and audit rows past retention. */
export async function runHousekeeping(env: Env, now = Date.now()): Promise<void> {
	const cfg = getConfig(env);
	const db = env.DB;
	const [sessions, flows, tokens, auditRows] = await db.batch([
		db.prepare('DELETE FROM sessions WHERE expires_at <= ? OR idle_expires_at <= ?').bind(now, now),
		db.prepare('DELETE FROM oidc_flows WHERE expires_at <= ?').bind(now),
		db.prepare('DELETE FROM api_tokens WHERE expires_at IS NOT NULL AND expires_at <= ?').bind(now - EXPIRED_TOKEN_GRACE_MS),
		db.prepare('DELETE FROM audit_events WHERE created_at < ?').bind(now - cfg.auditRetentionDays * DAY_MS),
	]);
	console.info(
		`housekeeping | Purged sessions=${sessions?.meta.changes ?? 0} flows=${flows?.meta.changes ?? 0} tokens=${tokens?.meta.changes ?? 0} audit=${auditRows?.meta.changes ?? 0}`,
	);
}
