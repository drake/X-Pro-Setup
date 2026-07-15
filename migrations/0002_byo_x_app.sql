-- BYO X developer app (OAuth 2.0 Client ID + Secret encrypted per user)
-- Pending rows used before login; promoted to user_x_apps after OAuth.

CREATE TABLE IF NOT EXISTS oauth_pending (
  id TEXT PRIMARY KEY,
  client_id_enc TEXT NOT NULL,
  client_secret_enc TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS user_x_apps (
  user_id TEXT PRIMARY KEY REFERENCES users(id),
  client_id_enc TEXT NOT NULL,
  client_secret_enc TEXT NOT NULL,
  client_id_hint TEXT,
  updated_at TEXT NOT NULL
);
