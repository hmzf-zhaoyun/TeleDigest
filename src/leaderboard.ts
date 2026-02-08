import {
  DEFAULT_LEADERBOARD_SCHEDULE,
  DEFAULT_LEADERBOARD_WINDOW,
  LEADERBOARD_TOP_N,
} from "./constants";
import type { Env } from "./types";
import {
  getLeaderboardEnabledGroups,
  getGroupConfig,
  getMessageLeaderboard,
  updateGroupAfterLeaderboard,
} from "./db";
import { getScheduleTzOffsetMinutes, isScheduleDue, parseSchedule } from "./schedule";
import { sendMessage } from "./telegram/api";
import { parseDuration } from "./utils";

type LeaderboardResult = {
  success: boolean;
  content: string;
  error?: string;
};

export async function runScheduledLeaderboards(env: Env): Promise<void> {
  if (!env.DB || !env.TG_BOT_TOKEN) {
    return;
  }

  const groups = await getLeaderboardEnabledGroups(env);
  if (!groups.length) {
    return;
  }

  const now = new Date();
  const tzOffset = getScheduleTzOffsetMinutes(env);

  for (const group of groups) {
    try {
      const scheduleText = (group.leaderboard_schedule || DEFAULT_LEADERBOARD_SCHEDULE).trim();
      const parsed = parseSchedule(scheduleText);
      if (!parsed) {
        continue;
      }
      if (!isScheduleDue(parsed, group.last_leaderboard_time, now, tzOffset)) {
        continue;
      }
      await runLeaderboardForGroup(env, group.group_id, now);
    } catch (error) {
      console.error("scheduled leaderboard failed", {
        groupId: group.group_id,
        error,
      });
    }
  }
}

export async function runLeaderboardForGroup(
  env: Env,
  groupId: number,
  now: Date = new Date(),
): Promise<LeaderboardResult> {
  const config = await getGroupConfig(env, groupId);
  if (!config) {
    return { success: false, content: "", error: "群组配置不存在" };
  }

  const scheduleText = (config.leaderboard_schedule || DEFAULT_LEADERBOARD_SCHEDULE).trim();
  const schedule = parseSchedule(scheduleText) || parseSchedule(DEFAULT_LEADERBOARD_SCHEDULE);
  if (!schedule) {
    return { success: false, content: "", error: "排行榜定时配置无效" };
  }

  const window = resolveLeaderboardWindow(config.leaderboard_window || DEFAULT_LEADERBOARD_WINDOW, now);
  const endIso = now.toISOString();
  const startIso = window.start.toISOString();

  const rows = await getMessageLeaderboard(env, groupId, startIso, endIso, LEADERBOARD_TOP_N);
  if (!rows.length) {
    await updateGroupAfterLeaderboard(env, groupId, endIso);
    return { success: true, content: "" };
  }

  const groupName = config.group_name || String(groupId);
  const header = `🏆 ${groupName} 消息排行榜（${window.label}）`;
  const lines = rows.map((row, index) => {
    const name = row.sender_name || String(row.sender_id);
    return `${index + 1}. ${name} - ${row.message_count}条`;
  });
  const text = [header, "", ...lines].join("\n");

  const targetChat = config.target_chat_id ?? groupId;
  await sendMessage(env, targetChat, text);
  await updateGroupAfterLeaderboard(env, groupId, endIso);

  return { success: true, content: text };
}

function resolveLeaderboardWindow(
  windowText: string,
  now: Date,
): { start: Date; label: string } {
  const parsed = parseDuration(windowText) ?? parseDuration(DEFAULT_LEADERBOARD_WINDOW);
  const windowMs = Math.max(parsed || 60_000, 60_000);
  const start = new Date(now.getTime() - windowMs);
  return { start, label: `过去${formatDuration(windowMs)}` };
}

function formatDuration(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes % 1440 === 0) {
    return `${minutes / 1440}天`;
  }
  if (minutes % 60 === 0) {
    return `${minutes / 60}小时`;
  }
  return `${minutes}分钟`;
}
