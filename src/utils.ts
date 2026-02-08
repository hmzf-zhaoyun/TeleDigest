export function parseNumberEnv(
  value: string | undefined,
  fallback: number,
  options: { min?: number; max?: number } = {},
): number {
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  if (options.min !== undefined && parsed < options.min) return options.min;
  if (options.max !== undefined && parsed > options.max) return options.max;
  return parsed;
}

export function parseDuration(value: string): number | null {
  const trimmed = value.trim();
  const match = /^(\d+)\s*([mhd])$/.exec(trimmed);
  if (!match) return null;
  const amount = parseInt(match[1], 10);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  const unit = match[2];
  const multiplier =
    unit === "m" ? 60_000 : unit === "h" ? 3_600_000 : 86_400_000;
  return amount * multiplier;
}

export function truncateLabel(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(1, max - 3))}...`;
}

export function encodeCallbackValue(value: string): string {
  return encodeURIComponent(value);
}

export function decodeCallbackValue(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export function isOwnerUser(env: { TG_BOT_OWNER_ID?: string }, userId: number): boolean {
  const raw = env.TG_BOT_OWNER_ID || "";
  const ids = raw
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)
    .map((value) => parseInt(value, 10))
    .filter((value) => Number.isFinite(value));
  return ids.includes(userId);
}
