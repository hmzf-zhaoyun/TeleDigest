import {
  DEFAULT_LEADERBOARD_SCHEDULE,
  DEFAULT_LEADERBOARD_WINDOW,
  DEFAULT_SCHEDULE,
} from "./constants";
import type {
  AdminActionRow,
  Env,
  GroupConfigRow,
  GroupMessageRow,
  TelegramMessage,
  TelegramUser,
} from "./types";

let schemaReady = false;
let kvWindowUntil = 0;
let kvWindowCheckedAt = 0;
const KV_WINDOW_CACHE_MS = 5_000;
const KV_SYNC_WINDOW_KEY = "kv_sync_window_until";

export type LeaderboardRow = {
  sender_id: number;
  sender_name: string;
  message_count: number;
};

export async function ensureSchema(env: Env): Promise<void> {
  if (schemaReady) return;
  schemaReady = true;
  try {
    await env.DB.prepare(
      `CREATE TABLE IF NOT EXISTS app_settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT DEFAULT CURRENT_TIMESTAMP
      )`
    ).run();

    await env.DB.prepare(
      `CREATE TABLE IF NOT EXISTS admin_actions (
        user_id INTEGER PRIMARY KEY,
        action TEXT NOT NULL,
        group_id INTEGER NOT NULL,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        expires_at TEXT
      )`
    ).run();

    const info = await env.DB.prepare("PRAGMA table_info(group_configs)").all<{
      name: string;
    }>();
    const columns = new Set((info.results || []).map((row) => row.name));

    if (!columns.has("leaderboard_schedule")) {
      await env.DB.prepare(
        "ALTER TABLE group_configs ADD COLUMN leaderboard_schedule TEXT DEFAULT '1h'"
      ).run();
    }
    if (!columns.has("leaderboard_enabled")) {
      await env.DB.prepare(
        "ALTER TABLE group_configs ADD COLUMN leaderboard_enabled INTEGER DEFAULT 0"
      ).run();
    }
    if (!columns.has("leaderboard_window")) {
      await env.DB.prepare(
        "ALTER TABLE group_configs ADD COLUMN leaderboard_window TEXT DEFAULT '1h'"
      ).run();
    }
    if (!columns.has("last_leaderboard_time")) {
      await env.DB.prepare(
        "ALTER TABLE group_configs ADD COLUMN last_leaderboard_time TEXT"
      ).run();
    }
    if (!columns.has("spoiler_enabled")) {
      await env.DB.prepare(
        "ALTER TABLE group_configs ADD COLUMN spoiler_enabled INTEGER DEFAULT 0"
      ).run();
    }
    if (!columns.has("spoiler_auto_delete")) {
      await env.DB.prepare(
        "ALTER TABLE group_configs ADD COLUMN spoiler_auto_delete INTEGER DEFAULT 0"
      ).run();
    }

    const msgInfo = await env.DB.prepare("PRAGMA table_info(group_messages)").all<{
      name: string;
    }>();
    const msgColumns = new Set((msgInfo.results || []).map((row) => row.name));
    if (!msgColumns.has("sender_is_bot")) {
      await env.DB.prepare(
        "ALTER TABLE group_messages ADD COLUMN sender_is_bot INTEGER DEFAULT 0"
      ).run();
    }

    await env.DB.prepare(
      "CREATE INDEX IF NOT EXISTS idx_messages_group_date ON group_messages(group_id, message_date)"
    ).run();
  } catch (error) {
    schemaReady = false;
    console.error("ensureSchema failed", error);
  }
}

export async function getGroupConfig(env: Env, groupId: number): Promise<GroupConfigRow | null> {
  const row = await env.DB.prepare(
    `SELECT group_id, group_name, enabled, schedule, leaderboard_schedule, leaderboard_enabled, leaderboard_window,
            target_chat_id, last_summary_time, last_message_id, last_leaderboard_time,
            spoiler_enabled, spoiler_auto_delete
     FROM group_configs WHERE group_id = ?`
  )
    .bind(groupId)
    .first<GroupConfigRow>();
  return row || null;
}

export async function getAllGroups(env: Env): Promise<GroupConfigRow[]> {
  const results = await env.DB.prepare(
    `SELECT group_id, group_name, enabled, schedule, leaderboard_schedule, leaderboard_enabled, leaderboard_window,
            target_chat_id, last_summary_time, last_message_id, last_leaderboard_time,
            spoiler_enabled, spoiler_auto_delete
     FROM group_configs ORDER BY updated_at DESC`
  ).all<GroupConfigRow>();
  return results.results || [];
}

export async function getEnabledGroups(env: Env): Promise<GroupConfigRow[]> {
  const results = await env.DB.prepare(
    `SELECT group_id, group_name, enabled, schedule, leaderboard_schedule, leaderboard_enabled, leaderboard_window,
            target_chat_id, last_summary_time, last_message_id, last_leaderboard_time,
            spoiler_enabled, spoiler_auto_delete
     FROM group_configs WHERE enabled = 1`
  ).all<GroupConfigRow>();
  return results.results || [];
}

export async function getLeaderboardEnabledGroups(env: Env): Promise<GroupConfigRow[]> {
  const results = await env.DB.prepare(
    `SELECT group_id, group_name, enabled, schedule, leaderboard_schedule, leaderboard_enabled, leaderboard_window,
            target_chat_id, last_summary_time, last_message_id, last_leaderboard_time,
            spoiler_enabled, spoiler_auto_delete
     FROM group_configs WHERE leaderboard_enabled = 1`
  ).all<GroupConfigRow>();
  return results.results || [];
}

export async function insertGroupConfig(
  env: Env,
  groupId: number,
  groupName: string,
  enabled: boolean,
  schedule: string,
): Promise<void> {
  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO group_configs
     (group_id, group_name, enabled, schedule, leaderboard_schedule, leaderboard_enabled,
      leaderboard_window, target_chat_id, last_summary_time, last_message_id,
      last_leaderboard_time, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 0, ?, NULL, NULL, 0, NULL, ?, ?)`
  )
    .bind(
      groupId,
      groupName,
      enabled ? 1 : 0,
      schedule,
      DEFAULT_LEADERBOARD_SCHEDULE,
      DEFAULT_LEADERBOARD_WINDOW,
      now,
      now,
    )
    .run();
}

export async function updateGroupEnabled(env: Env, groupId: number, enabled: boolean): Promise<void> {
  await env.DB.prepare(
    "UPDATE group_configs SET enabled = ?, updated_at = ? WHERE group_id = ?"
  )
    .bind(enabled ? 1 : 0, new Date().toISOString(), groupId)
    .run();
}

export async function updateGroupSchedule(env: Env, groupId: number, schedule: string): Promise<void> {
  await env.DB.prepare(
    "UPDATE group_configs SET schedule = ?, updated_at = ? WHERE group_id = ?"
  )
    .bind(schedule, new Date().toISOString(), groupId)
    .run();
}

export async function updateGroupLeaderboardSchedule(
  env: Env,
  groupId: number,
  schedule: string,
): Promise<void> {
  await env.DB.prepare(
    "UPDATE group_configs SET leaderboard_schedule = ?, updated_at = ? WHERE group_id = ?"
  )
    .bind(schedule, new Date().toISOString(), groupId)
    .run();
}

export async function updateGroupLeaderboardEnabled(
  env: Env,
  groupId: number,
  enabled: boolean,
): Promise<void> {
  await env.DB.prepare(
    "UPDATE group_configs SET leaderboard_enabled = ?, updated_at = ? WHERE group_id = ?"
  )
    .bind(enabled ? 1 : 0, new Date().toISOString(), groupId)
    .run();
}

export async function updateGroupLeaderboardWindow(
  env: Env,
  groupId: number,
  window: string,
): Promise<void> {
  await env.DB.prepare(
    "UPDATE group_configs SET leaderboard_window = ?, updated_at = ? WHERE group_id = ?"
  )
    .bind(window, new Date().toISOString(), groupId)
    .run();
}

export async function updateGroupName(env: Env, groupId: number, groupName: string): Promise<void> {
  await env.DB.prepare(
    "UPDATE group_configs SET group_name = ?, updated_at = ? WHERE group_id = ?"
  )
    .bind(groupName, new Date().toISOString(), groupId)
    .run();
}

export async function updateGroupSpoilerEnabled(
  env: Env,
  groupId: number,
  enabled: boolean,
): Promise<void> {
  await env.DB.prepare(
    "UPDATE group_configs SET spoiler_enabled = ?, updated_at = ? WHERE group_id = ?"
  )
    .bind(enabled ? 1 : 0, new Date().toISOString(), groupId)
    .run();
}

export async function updateGroupSpoilerAutoDelete(
  env: Env,
  groupId: number,
  enabled: boolean,
): Promise<void> {
  await env.DB.prepare(
    "UPDATE group_configs SET spoiler_auto_delete = ?, updated_at = ? WHERE group_id = ?"
  )
    .bind(enabled ? 1 : 0, new Date().toISOString(), groupId)
    .run();
}

export async function updateGroupAfterSummary(
  env: Env,
  groupId: number,
  lastMessageId: number,
): Promise<void> {
  await env.DB.prepare(
    "UPDATE group_configs SET last_summary_time = ?, last_message_id = ?, updated_at = ? WHERE group_id = ?"
  )
    .bind(new Date().toISOString(), lastMessageId, new Date().toISOString(), groupId)
    .run();
}

export async function updateGroupAfterLeaderboard(
  env: Env,
  groupId: number,
  lastLeaderboardTime: string,
): Promise<void> {
  await env.DB.prepare(
    "UPDATE group_configs SET last_leaderboard_time = ?, updated_at = ? WHERE group_id = ?"
  )
    .bind(lastLeaderboardTime, new Date().toISOString(), groupId)
    .run();
}

export async function setAdminAction(
  env: Env,
  userId: number,
  action: string,
  groupId: number,
  ttlMinutes: number,
): Promise<void> {
  const expiresAt = new Date(Date.now() + ttlMinutes * 60_000).toISOString();
  await env.DB.prepare(
    `INSERT INTO admin_actions (user_id, action, group_id, expires_at, created_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET
       action = excluded.action,
       group_id = excluded.group_id,
       expires_at = excluded.expires_at,
       created_at = excluded.created_at`
  )
    .bind(userId, action, groupId, expiresAt, new Date().toISOString())
    .run();
}

export async function getAdminAction(env: Env, userId: number): Promise<AdminActionRow | null> {
  const row = await env.DB.prepare(
    `SELECT user_id, action, group_id, expires_at
     FROM admin_actions WHERE user_id = ?`
  )
    .bind(userId)
    .first<AdminActionRow>();
  if (!row) {
    return null;
  }
  if (row.expires_at) {
    const expiresAt = Date.parse(row.expires_at);
    if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
      await clearAdminAction(env, userId);
      return null;
    }
  }
  return row;
}

export async function clearAdminAction(env: Env, userId: number): Promise<void> {
  await env.DB.prepare("DELETE FROM admin_actions WHERE user_id = ?")
    .bind(userId)
    .run();
}

export async function openKvSyncWindow(env: Env, durationMs: number): Promise<number> {
  const until = Date.now() + durationMs;
  kvWindowUntil = until;
  kvWindowCheckedAt = Date.now();
  await env.DB.prepare(
    `INSERT INTO app_settings (key, value, updated_at)
     VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET
       value = excluded.value,
       updated_at = excluded.updated_at`
  )
    .bind(KV_SYNC_WINDOW_KEY, String(until), new Date().toISOString())
    .run();
  return until;
}

export async function isKvSyncWindowOpen(env: Env): Promise<boolean> {
  const now = Date.now();
  if (kvWindowUntil > now) {
    return true;
  }
  if (now - kvWindowCheckedAt < KV_WINDOW_CACHE_MS) {
    return false;
  }
  kvWindowCheckedAt = now;
  const row = await env.DB.prepare(
    "SELECT value FROM app_settings WHERE key = ?"
  )
    .bind(KV_SYNC_WINDOW_KEY)
    .first<{ value: string }>();
  const until = row?.value ? Number(row.value) : 0;
  if (Number.isFinite(until) && until > now) {
    kvWindowUntil = until;
    return true;
  }
  kvWindowUntil = 0;
  return false;
}

export async function getUnsummarizedMessages(
  env: Env,
  groupId: number,
  limit: number,
): Promise<GroupMessageRow[]> {
  const results = await env.DB.prepare(
    `SELECT message_id, group_id, sender_id, sender_name, content, message_date, has_media, media_type, is_summarized
     FROM group_messages
     WHERE group_id = ? AND is_summarized = 0
     ORDER BY message_date ASC
     LIMIT ?`
  )
    .bind(groupId, limit)
    .all<GroupMessageRow>();
  return results.results || [];
}

export async function getMessageLeaderboard(
  env: Env,
  groupId: number,
  startIso: string,
  endIso: string,
  limit: number,
): Promise<LeaderboardRow[]> {
  const results = await env.DB.prepare(
    `SELECT sender_id,
            COALESCE(MAX(sender_name), '') AS sender_name,
            COUNT(*) AS message_count
     FROM group_messages
     WHERE group_id = ?
       AND message_date >= ? AND message_date < ?
       AND COALESCE(sender_is_bot, 0) = 0
     GROUP BY sender_id
     ORDER BY message_count DESC, MAX(message_date) DESC
     LIMIT ?`
  )
    .bind(groupId, startIso, endIso, limit)
    .all<LeaderboardRow>();
  return results.results || [];
}

export async function markMessagesSummarized(
  env: Env,
  groupId: number,
  upToMessageId: number,
): Promise<void> {
  await env.DB.prepare(
    `UPDATE group_messages
     SET is_summarized = 1
     WHERE group_id = ? AND message_id <= ? AND is_summarized = 0`
  )
    .bind(groupId, upToMessageId)
    .run();
}

export async function saveGroupMessage(message: TelegramMessage, env: Env): Promise<void> {
  const chat = message.chat;
  const groupId = chat.id;
  const groupName = chat.title || "";
  await upsertGroupFromMessage(env, groupId, groupName);

  const sender = message.from;
  const senderName = buildSenderName(sender);
  const senderIsBot = sender?.is_bot ? 1 : 0;
  const content = message.text || message.caption || "";
  const mediaType = detectMediaType(message);
  const hasMedia = mediaType !== null;
  const messageDate = new Date(message.date * 1000).toISOString();

  await env.DB.prepare(
    `INSERT OR IGNORE INTO group_messages
     (message_id, group_id, sender_id, sender_name, sender_is_bot, content, message_date, has_media, media_type, is_summarized, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`
  )
    .bind(
      message.message_id,
      groupId,
      sender?.id || 0,
      senderName,
      senderIsBot,
      content,
      messageDate,
      hasMedia ? 1 : 0,
      mediaType,
      new Date().toISOString(),
    )
    .run();
}

async function upsertGroupFromMessage(
  env: Env,
  groupId: number,
  groupName: string,
): Promise<void> {
  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO group_configs
     (group_id, group_name, enabled, schedule, leaderboard_schedule, leaderboard_enabled,
      leaderboard_window, target_chat_id, last_summary_time, last_message_id,
      last_leaderboard_time, created_at, updated_at)
     VALUES (?, ?, 0, ?, ?, 0, ?, NULL, NULL, 0, NULL, ?, ?)
     ON CONFLICT(group_id) DO UPDATE SET
       group_name = excluded.group_name,
       updated_at = excluded.updated_at`
  )
    .bind(
      groupId,
      groupName,
      DEFAULT_SCHEDULE,
      DEFAULT_LEADERBOARD_SCHEDULE,
      DEFAULT_LEADERBOARD_WINDOW,
      now,
      now,
    )
    .run();
}

function buildSenderName(sender?: TelegramUser): string {
  if (!sender) {
    return "Unknown";
  }
  const fullName = [sender.first_name, sender.last_name].filter(Boolean).join(" ");
  return fullName || sender.username || String(sender.id);
}

function detectMediaType(message: TelegramMessage): string | null {
  if (message.photo && message.photo.length > 0) return "photo";
  if (message.video) return "video";
  if (message.document) return "document";
  if (message.audio) return "audio";
  if (message.voice) return "voice";
  if (message.sticker) return "sticker";
  if (message.animation) return "animation";
  return null;
}
