CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  x_user_id TEXT NOT NULL UNIQUE,
  username TEXT NOT NULL,
  name TEXT,
  avatar_url TEXT,
  created_at TEXT NOT NULL,
  last_login_at TEXT
);

CREATE TABLE IF NOT EXISTS x_tokens (
  user_id TEXT PRIMARY KEY REFERENCES users(id),
  access_token_enc TEXT NOT NULL,
  refresh_token_enc TEXT,
  expires_at TEXT,
  scope TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS user_keys (
  user_id TEXT PRIMARY KEY REFERENCES users(id),
  xai_api_key_enc TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  status TEXT NOT NULL,
  paid_by TEXT NOT NULL DEFAULT 'host',
  quiz_json TEXT,
  taste_json TEXT,
  proposal_json TEXT,
  result_json TEXT,
  bookmarks_scanned INTEGER DEFAULT 0,
  likes_scanned INTEGER DEFAULT 0,
  follows_scanned INTEGER DEFAULT 0,
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_runs_user ON runs(user_id);
CREATE INDEX IF NOT EXISTS idx_runs_day ON runs(created_at);

CREATE TABLE IF NOT EXISTS daily_free_pool (
  day_key TEXT PRIMARY KEY,
  unlock_at TEXT NOT NULL,
  used_count INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS created_lists (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id),
  user_id TEXT NOT NULL,
  x_list_id TEXT NOT NULL,
  name TEXT NOT NULL,
  member_count INTEGER DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
