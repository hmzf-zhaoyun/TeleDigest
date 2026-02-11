CREATE TABLE IF NOT EXISTS group_configs (
  group_id INTEGER PRIMARY KEY,
  group_name TEXT DEFAULT '',
  enabled INTEGER DEFAULT 0,
  schedule TEXT DEFAULT '0 * * * *',
  leaderboard_schedule TEXT DEFAULT '1h',
  leaderboard_enabled INTEGER DEFAULT 0,
  leaderboard_window TEXT DEFAULT '1h',
  target_chat_id INTEGER,
  last_summary_time TEXT,
  last_message_id INTEGER DEFAULT 0,
  last_leaderboard_time TEXT,
  spoiler_enabled INTEGER DEFAULT 0,
  spoiler_auto_delete INTEGER DEFAULT 0,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS group_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id INTEGER NOT NULL,
  group_id INTEGER NOT NULL,
  sender_id INTEGER NOT NULL,
  sender_name TEXT DEFAULT '',
  sender_is_bot INTEGER DEFAULT 0,
  content TEXT DEFAULT '',
  message_date TEXT NOT NULL,
  has_media INTEGER DEFAULT 0,
  media_type TEXT,
  is_summarized INTEGER DEFAULT 0,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(group_id, message_id)
);

CREATE TABLE IF NOT EXISTS admin_actions (
  user_id INTEGER PRIMARY KEY,
  action TEXT NOT NULL,
  group_id INTEGER NOT NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  expires_at TEXT
);

CREATE TABLE IF NOT EXISTS app_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS user_linuxdo_tokens (
  user_id INTEGER PRIMARY KEY,
  token TEXT NOT NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_messages_group_summarized
ON group_messages(group_id, is_summarized);

CREATE INDEX IF NOT EXISTS idx_messages_date
ON group_messages(message_date);

CREATE INDEX IF NOT EXISTS idx_messages_group_date
ON group_messages(group_id, message_date);
