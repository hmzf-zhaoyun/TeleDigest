export const TELEGRAM_API_BASE = "https://api.telegram.org";
export const DEFAULT_SCHEDULE = "0 * * * *";
export const MAX_MESSAGES_PER_SUMMARY = 500;
export const LLM_TIMEOUT_MS = 120000;
export const TELEGRAM_TEXT_LIMIT = 4096;
export const TELEGRAM_SAFE_LIMIT = 3500;
export const DEFAULT_LLM_MAX_TOKENS = 1000;
export const DEFAULT_LLM_TEMPERATURE = 0.7;
export const ADMIN_ACTION_TTL_MINUTES = 10;

export const CALLBACK_PANEL_OPEN = "panel:open";
export const CALLBACK_PANEL_LIST = "panel:list";
export const CALLBACK_PANEL_SYNC = "panel:sync";
export const CALLBACK_GROUP_SHOW = "grp:show";
export const CALLBACK_GROUP_ENABLE = "grp:enable";
export const CALLBACK_GROUP_DISABLE = "grp:disable";
export const CALLBACK_GROUP_SUMMARY = "grp:summary";
export const CALLBACK_SCHEDULE_MENU = "sch:menu";
export const CALLBACK_SCHEDULE_SET = "sch:set";
export const CALLBACK_SCHEDULE_CUSTOM = "sch:custom";
export const CALLBACK_SPOILER_MENU = "spo:menu";
export const CALLBACK_SPOILER_TOGGLE = "spo:toggle";
export const CALLBACK_SPOILER_DELETE = "spo:delete";

export const SCHEDULE_PRESETS: Array<{ label: string; value: string; description: string }> = [
  { label: "每小时", value: "1h", description: "每隔1小时" },
  { label: "每2小时", value: "2h", description: "每隔2小时" },
  { label: "每4小时", value: "4h", description: "每隔4小时" },
  { label: "每天早9点", value: "0 9 * * *", description: "每天 09:00" },
  { label: "每天晚8点", value: "0 20 * * *", description: "每天 20:00" },
  { label: "每12小时", value: "12h", description: "每隔12小时" },
];

export const SCHEDULE_CUSTOM_OPTIONS: Array<{ label: string; value: string }> = [
  { label: "30分钟", value: "30m" },
  { label: "45分钟", value: "45m" },
  { label: "90分钟", value: "90m" },
  { label: "3小时", value: "3h" },
  { label: "6小时", value: "6h" },
  { label: "8小时", value: "8h" },
];
