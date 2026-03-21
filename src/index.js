import { ensureSchema, purgeOldMessages } from "./db";
import { handleTelegramWebhook } from "./telegram/handlers";
import { runScheduledSummaries } from "./schedule";
import { runScheduledLeaderboards } from "./leaderboard";
export default {
    async fetch(request, env, ctx) {
        const url = new URL(request.url);
        if (url.pathname === "/telegram") {
            return handleTelegramWebhook(request, env, ctx);
        }
        if (url.pathname === "/health") {
            return new Response("ok");
        }
        return new Response("Not Found", { status: 404 });
    },
    async scheduled(_event, env, _ctx) {
        if (env.DB) {
            await ensureSchema(env);
        }
        await Promise.allSettled([runScheduledSummaries(env), runScheduledLeaderboards(env), purgeOldMessages(env)]);
    },
};
