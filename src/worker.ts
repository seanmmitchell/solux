import { app } from './app';
import { handleScheduled } from './jobs';

export default {
	fetch: app.fetch,

	// Sun times: https://sunrise-sunset.org/api
	async scheduled(controller, env, ctx) {
		ctx.waitUntil(handleScheduled(controller.cron, env));
	},
} satisfies ExportedHandler<Env>;
