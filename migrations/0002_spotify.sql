-- Spotify connection for the single operator of this deployment.
--
-- Downbeat is self-hosted: one Cloudflare account, one Spotify account — the
-- operator's own. Only the refresh token is kept, encrypted with a key that
-- lives in a Worker secret, so a leaked database hands out nothing usable. The
-- row is keyed by a constant because there is exactly one operator per
-- deployment; a small invite list would key by operator id instead.
CREATE TABLE IF NOT EXISTS spotify_tokens (
  operator      TEXT PRIMARY KEY,   -- "primary" for the single-operator model
  refresh_enc   TEXT NOT NULL,      -- AES-GCM(refresh_token), base64
  scope         TEXT NOT NULL,
  display_name  TEXT,
  product       TEXT,               -- "premium" or not; Connect needs Premium
  connected_at  INTEGER NOT NULL
);

-- In-flight OAuth handshakes. The PKCE verifier is stored server-side against
-- the state nonce so it never has to ride in a URL the browser could leak, and
-- the hourly cron sweep drops anything older than a few minutes.
CREATE TABLE IF NOT EXISTS spotify_auth (
  state       TEXT PRIMARY KEY,
  verifier    TEXT NOT NULL,
  redirect    TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_spotify_auth_created ON spotify_auth (created_at);
