import type { Env } from "./types";
import { ensureSchema } from "./db";
import { handleTelegramWebhook } from "./telegram/handlers";
import { runScheduledSummaries } from "./schedule";
import { runScheduledLeaderboards } from "./leaderboard";

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/telegram") {
      return handleTelegramWebhook(request, env, ctx);
    }
    if (url.pathname === "/health") {
      return new Response("ok");
    }
    return new Response("Not Found", { status: 404 });
  },

  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    if (env.DB) {
      await ensureSchema(env);
    }
    ctx.waitUntil(Promise.all([runScheduledSummaries(env), runScheduledLeaderboards(env)]));
  },
};
