/**
 * Secrets are not emitted by `wrangler types` (they live in the Workers secret
 * store, not in wrangler.jsonc), so they are declared here by hand and merge
 * into the generated global `Env` interface.
 */
interface Env {
  /** Gates room creation, uploads, and the Spotify connection. `wrangler secret put HOST_PASSPHRASE`. */
  HOST_PASSPHRASE: string;
  /** The operator's Spotify app. `wrangler secret put SPOTIFY_CLIENT_ID`. */
  SPOTIFY_CLIENT_ID: string;
  /** Its secret — never leaves the Worker. `wrangler secret put SPOTIFY_CLIENT_SECRET`. */
  SPOTIFY_CLIENT_SECRET: string;
  /** 32 random bytes, base64; encrypts the stored refresh token. `openssl rand -base64 32`. */
  TOKEN_KEY: string;
}
