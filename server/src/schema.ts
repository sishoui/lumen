export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  user_key      TEXT    NOT NULL UNIQUE,
  display_name  TEXT,
  first_seen_at INTEGER NOT NULL,
  last_seen_at  INTEGER NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS usage_logs (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id         INTEGER NOT NULL REFERENCES users(id),
  device_key      TEXT    NOT NULL,
  device_name     TEXT,
  device_id       TEXT,
  platform        TEXT    NOT NULL DEFAULT 'unknown',
  started_at      INTEGER NOT NULL,
  ended_at        INTEGER,
  reported_at     INTEGER NOT NULL,
  client_event_id TEXT    NOT NULL UNIQUE
) STRICT;

CREATE INDEX IF NOT EXISTS idx_usage_logs_device ON usage_logs(device_key);
CREATE INDEX IF NOT EXISTS idx_usage_logs_user   ON usage_logs(user_id);
CREATE INDEX IF NOT EXISTS idx_usage_logs_start  ON usage_logs(started_at);

CREATE VIEW IF NOT EXISTS v_devices AS
SELECT
  device_key,
  MAX(device_name)                            AS device_name,
  COUNT(*)                                    AS use_count,
  COUNT(DISTINCT user_id)                     AS user_count,
  MAX(COALESCE(ended_at, started_at))         AS last_seen_at,
  COUNT(DISTINCT CASE
                   WHEN device_id IS NOT NULL AND instr(device_id, ':') > 0
                   THEN upper(device_id)
                 END)                         AS mac_count
FROM usage_logs
GROUP BY device_key;

CREATE VIEW IF NOT EXISTS v_users AS
SELECT
  u.id,
  u.user_key,
  u.display_name,
  u.first_seen_at,
  u.last_seen_at,
  COUNT(l.id)                  AS use_count,
  COUNT(DISTINCT l.device_key) AS device_count
FROM users u
LEFT JOIN usage_logs l ON l.user_id = u.id
GROUP BY u.id;
`;

export const MIGRATIONS: ReadonlyArray<{ readonly version: number; readonly sql: string }> = [];
