-- Host sessions.
--
-- The host token is an HMAC and therefore self-describing, but a signature
-- alone cannot answer "is this session still the one that owns the room?" --
-- it cannot be revoked, it cannot expire early, and nothing stops two hosts
-- claiming the same code at once. The row is what makes a session a session.
CREATE TABLE IF NOT EXISTS sessions (
  code         TEXT PRIMARY KEY,
  token_hash   TEXT    NOT NULL,
  created_at   INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  source_label TEXT,
  revoked      INTEGER NOT NULL DEFAULT 0
);

-- The cron sweep queries purely on expiry.
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions (expires_at);

-- Uploaded audio, so the sweep can drop R2 objects nothing references any more.
CREATE TABLE IF NOT EXISTS uploads (
  id          TEXT PRIMARY KEY,
  code        TEXT    NOT NULL,
  size        INTEGER NOT NULL,
  created_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_uploads_created ON uploads (created_at);
