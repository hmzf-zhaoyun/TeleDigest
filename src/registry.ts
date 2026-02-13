import {
  DEFAULT_LEADERBOARD_SCHEDULE,
  DEFAULT_LEADERBOARD_WINDOW,
  DEFAULT_SCHEDULE,
} from "./constants";
import type { Env, GroupConfigRow } from "./types";
import {
  getGroupConfig,
  insertGroupConfig,
  isKvSyncWindowOpen,
  updateGroupEnabled,
  updateGroupLeaderboardSchedule,
  updateGroupLeaderboardEnabled,
  updateGroupLeaderboardWindow,
  updateGroupName,
  updateGroupSchedule,
  updateGroupSpoilerAutoDelete,
  updateGroupSpoilerEnabled,
} from "./db";

const GROUP_PREFIX = "group:";

type GroupRegistryEntry = {
  group_id: number;
  group_name: string;
  enabled?: number;
  schedule?: string;
  leaderboard_schedule?: string;
  leaderboard_enabled?: number;
  leaderboard_window?: string;
  spoiler_enabled?: number;
  spoiler_auto_delete?: number;
  updated_at: string;
};

async function canUseKv(env: Env): Promise<boolean> {
  if (!env.GROUPS_KV) {
    return false;
  }
  return isKvSyncWindowOpen(env);
}

export async function registerGroup(
  env: Env,
  groupId: number,
  groupName: string,
  meta: Partial<GroupRegistryEntry> = {},
): Promise<void> {
  if (!(await canUseKv(env))) {
    return;
  }
  const kv = env.GROUPS_KV;
  if (!kv) {
    return;
  }
  const key = `${GROUP_PREFIX}${groupId}`;
  const existing = await kv.get(key, "json") as GroupRegistryEntry | null;
  const entry: GroupRegistryEntry = {
    ...(existing || {}),
    group_id: groupId,
    group_name: groupName || existing?.group_name || "",
    updated_at: new Date().toISOString(),
    ...meta,
  };
  await kv.put(key, JSON.stringify(entry));
}

export async function removeGroup(env: Env, groupId: number): Promise<void> {
  if (!(await canUseKv(env))) {
    return;
  }
  const kv = env.GROUPS_KV;
  if (!kv) {
    return;
  }
  await kv.delete(`${GROUP_PREFIX}${groupId}`);
}

export async function updateRegistryFromConfig(
  env: Env,
  config: GroupConfigRow,
): Promise<void> {
  await registerGroup(env, config.group_id, config.group_name || "", {
    enabled: Number(config.enabled) === 1 ? 1 : 0,
    schedule: config.schedule || DEFAULT_SCHEDULE,
    leaderboard_schedule: config.leaderboard_schedule || DEFAULT_LEADERBOARD_SCHEDULE,
    leaderboard_enabled: Number(config.leaderboard_enabled) === 1 ? 1 : 0,
    leaderboard_window: config.leaderboard_window || DEFAULT_LEADERBOARD_WINDOW,
    spoiler_enabled: Number(config.spoiler_enabled) === 1 ? 1 : 0,
    spoiler_auto_delete: Number(config.spoiler_auto_delete) === 1 ? 1 : 0,
  });
}

export async function syncGroupsFromRegistry(env: Env): Promise<{
  total: number;
  inserted: number;
  updated: number;
  skipped: number;
  unavailable: boolean;
}> {
  if (!env.GROUPS_KV) {
    return { total: 0, inserted: 0, updated: 0, skipped: 0, unavailable: true };
  }
  if (!(await isKvSyncWindowOpen(env))) {
    return { total: 0, inserted: 0, updated: 0, skipped: 0, unavailable: true };
  }

  const kv = env.GROUPS_KV;
  let cursor: string | undefined = undefined;
  let total = 0;
  let inserted = 0;
  let updated = 0;
  let skipped = 0;

  do {
    const list: KVNamespaceListResult<unknown, string> = await kv.list({ prefix: GROUP_PREFIX, cursor });
    cursor = list.list_complete ? undefined : list.cursor;
    for (const key of list.keys) {
      const entry = await kv.get(key.name, "json") as GroupRegistryEntry | null;
      if (!entry || !Number.isFinite(entry.group_id)) {
        skipped += 1;
        continue;
      }
      total += 1;
      const config = await getGroupConfig(env, entry.group_id);
      if (!config) {
        await insertGroupConfig(
          env,
          entry.group_id,
          entry.group_name || "",
          Number(entry.enabled) === 1,
          entry.schedule || DEFAULT_SCHEDULE,
        );
        if (entry.leaderboard_schedule) {
          await updateGroupLeaderboardSchedule(env, entry.group_id, entry.leaderboard_schedule);
        }
        if (entry.leaderboard_window) {
          await updateGroupLeaderboardWindow(env, entry.group_id, entry.leaderboard_window);
        }
        if (entry.leaderboard_enabled !== undefined) {
          await updateGroupLeaderboardEnabled(
            env,
            entry.group_id,
            Number(entry.leaderboard_enabled) === 1,
          );
        }
        if (Number(entry.spoiler_enabled) === 1) {
          await updateGroupSpoilerEnabled(env, entry.group_id, true);
        }
        if (Number(entry.spoiler_auto_delete) === 1) {
          await updateGroupSpoilerAutoDelete(env, entry.group_id, true);
        }
        inserted += 1;
        continue;
      }

      let didUpdate = false;
      if (entry.group_name && entry.group_name !== config.group_name) {
        await updateGroupName(env, entry.group_id, entry.group_name);
        didUpdate = true;
      }
      if (entry.schedule && entry.schedule !== config.schedule) {
        await updateGroupSchedule(env, entry.group_id, entry.schedule);
        didUpdate = true;
      }
      if (
        entry.leaderboard_schedule &&
        entry.leaderboard_schedule !== config.leaderboard_schedule
      ) {
        await updateGroupLeaderboardSchedule(env, entry.group_id, entry.leaderboard_schedule);
        didUpdate = true;
      }
      if (
        entry.leaderboard_window &&
        entry.leaderboard_window !== config.leaderboard_window
      ) {
        await updateGroupLeaderboardWindow(env, entry.group_id, entry.leaderboard_window);
        didUpdate = true;
      }
      if (
        entry.leaderboard_enabled !== undefined &&
        Number(entry.leaderboard_enabled) !== Number(config.leaderboard_enabled)
      ) {
        await updateGroupLeaderboardEnabled(env, entry.group_id, Number(entry.leaderboard_enabled) === 1);
        didUpdate = true;
      }
      if (entry.enabled !== undefined && Number(entry.enabled) !== Number(config.enabled)) {
        await updateGroupEnabled(env, entry.group_id, Number(entry.enabled) === 1);
        didUpdate = true;
      }
      if (
        entry.spoiler_enabled !== undefined &&
        Number(entry.spoiler_enabled) !== Number(config.spoiler_enabled)
      ) {
        await updateGroupSpoilerEnabled(env, entry.group_id, Number(entry.spoiler_enabled) === 1);
        didUpdate = true;
      }
      if (
        entry.spoiler_auto_delete !== undefined &&
        Number(entry.spoiler_auto_delete) !== Number(config.spoiler_auto_delete)
      ) {
        await updateGroupSpoilerAutoDelete(
          env,
          entry.group_id,
          Number(entry.spoiler_auto_delete) === 1,
        );
        didUpdate = true;
      }
      if (didUpdate) {
        updated += 1;
      } else {
        skipped += 1;
      }
    }
  } while (cursor);

  return { total, inserted, updated, skipped, unavailable: false };
}
