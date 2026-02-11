import { DEFAULT_SCHEDULE, LLM_TIMEOUT_MS } from "./constants";
import type { Env, Schedule } from "./types";
import { parseNumberEnv } from "./utils";
import { getEnabledGroups } from "./db";
import { runSummaryForGroup } from "./summary";

/** Per-group wall-clock guard so one slow LLM call cannot exhaust the worker. */
const GROUP_TIMEOUT_MS = LLM_TIMEOUT_MS + 10_000; // LLM timeout + 10 s buffer

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

export async function runScheduledSummaries(env: Env): Promise<void> {
  if (!env.DB || !env.TG_BOT_TOKEN) {
    return;
  }

  const groups = await getEnabledGroups(env);
  if (!groups.length) {
    return;
  }

  const now = new Date();
  const tzOffset = getScheduleTzOffsetMinutes(env);

  const tasks: Promise<void>[] = [];

  for (const group of groups) {
    const schedule = group.schedule || DEFAULT_SCHEDULE;
    const parsed = parseSchedule(schedule);
    if (!parsed) {
      continue;
    }
    if (!isScheduleDue(parsed, group.last_summary_time, now, tzOffset)) {
      continue;
    }
    tasks.push(
      withTimeout(
        runSummaryForGroup(env, group.group_id).then(() => { }),
        GROUP_TIMEOUT_MS,
        `summary:${group.group_id}`,
      ).catch((error) => {
        console.error("scheduled summary failed", { groupId: group.group_id, error });
      }),
    );
  }

  await Promise.allSettled(tasks);
}

export function parseSchedule(schedule: string): Schedule | null {
  const trimmed = schedule.trim();
  const intervalMatch = /^(\d+)\s*([mhd])$/.exec(trimmed);
  if (intervalMatch) {
    const amount = parseInt(intervalMatch[1], 10);
    const unit = intervalMatch[2];
    if (!Number.isFinite(amount) || amount <= 0) {
      return null;
    }
    const multiplier =
      unit === "m" ? 60_000 : unit === "h" ? 3_600_000 : 86_400_000;
    return { kind: "interval", ms: amount * multiplier };
  }

  const parts = trimmed.split(/\s+/);
  if (parts.length === 5) {
    return { kind: "cron", fields: parts };
  }

  return null;
}

export function getScheduleTzOffsetMinutes(env: Env): number {
  const value = parseNumberEnv(env.SCHEDULE_TZ_OFFSET_MINUTES, 0);
  return Math.trunc(value);
}

export function isScheduleDue(
  schedule: Schedule,
  lastSummary: string | null,
  now: Date,
  tzOffsetMinutes: number,
): boolean {
  if (schedule.kind === "interval") {
    if (!lastSummary) {
      return true;
    }
    const last = Date.parse(lastSummary);
    if (Number.isNaN(last)) {
      return true;
    }
    return now.getTime() - last >= schedule.ms;
  }

  const localNow = new Date(now.getTime() + tzOffsetMinutes * 60_000);
  if (lastSummary) {
    const last = Date.parse(lastSummary);
    if (Number.isFinite(last)) {
      const localLast = new Date(last + tzOffsetMinutes * 60_000);
      if (isSameMinute(localLast, localNow, tzOffsetMinutes)) {
        return false;
      }
    }
  }

  return cronMatches(schedule.fields, localNow);
}

function isSameMinute(a: Date, b: Date, tzOffsetMinutes: number): boolean {
  const aLocal = new Date(a.getTime() + tzOffsetMinutes * 60_000);
  const bLocal = new Date(b.getTime() + tzOffsetMinutes * 60_000);
  return (
    aLocal.getFullYear() === bLocal.getFullYear() &&
    aLocal.getMonth() === bLocal.getMonth() &&
    aLocal.getDate() === bLocal.getDate() &&
    aLocal.getHours() === bLocal.getHours() &&
    aLocal.getMinutes() === bLocal.getMinutes()
  );
}

function cronMatches(fields: string[], date: Date): boolean {
  const [minField, hourField, dayField, monthField, dowField] = fields;
  return (
    cronFieldMatches(minField, date.getMinutes(), 0, 59, false) &&
    cronFieldMatches(hourField, date.getHours(), 0, 23, false) &&
    cronFieldMatches(dayField, date.getDate(), 1, 31, false) &&
    cronFieldMatches(monthField, date.getMonth() + 1, 1, 12, false) &&
    cronFieldMatches(dowField, date.getDay(), 0, 7, true)
  );
}

function cronFieldMatches(
  field: string,
  value: number,
  min: number,
  max: number,
  isDow: boolean,
): boolean {
  if (field === "*") {
    return true;
  }
  const parts = field.split(",");
  for (const part of parts) {
    if (cronPartMatches(part.trim(), value, min, max, isDow)) {
      return true;
    }
  }
  return false;
}

function cronPartMatches(
  part: string,
  value: number,
  min: number,
  max: number,
  isDow: boolean,
): boolean {
  if (!part) {
    return false;
  }

  let rangePart = part;
  let step = 1;
  if (part.includes("/")) {
    const [range, stepRaw] = part.split("/");
    rangePart = range || "*";
    step = parseInt(stepRaw, 10);
    if (!Number.isFinite(step) || step <= 0) {
      return false;
    }
  }

  if (rangePart === "*") {
    return ((value - min) % step) === 0;
  }

  let rangeStart: number;
  let rangeEnd: number;

  if (rangePart.includes("-")) {
    const [startRaw, endRaw] = rangePart.split("-");
    rangeStart = parseInt(startRaw, 10);
    rangeEnd = parseInt(endRaw, 10);
  } else {
    rangeStart = parseInt(rangePart, 10);
    rangeEnd = rangeStart;
  }

  if (!Number.isFinite(rangeStart) || !Number.isFinite(rangeEnd)) {
    return false;
  }

  if (isDow) {
    rangeStart = rangeStart === 7 ? 0 : rangeStart;
    rangeEnd = rangeEnd === 7 ? 0 : rangeEnd;
  }

  if (rangeStart < min || rangeEnd > max) {
    return false;
  }

  if (rangeStart <= rangeEnd) {
    if (value < rangeStart || value > rangeEnd) {
      return false;
    }
    return ((value - rangeStart) % step) === 0;
  }

  if (value >= rangeStart || value <= rangeEnd) {
    const distance = value >= rangeStart ? value - rangeStart : (max - rangeStart + 1) + value;
    return distance % step === 0;
  }

  return false;
}
