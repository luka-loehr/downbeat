/**
 * The operator's Spotify connection.
 *
 * Downbeat is self-hosted and single-operator: one deployment, one Spotify
 * account — the operator's own. Authentication is the same device flow
 * librespot itself uses: Authorization Code + PKCE against Spotify's own
 * desktop client id, a public client with no secret anywhere. That id is not
 * a choice made lightly — Spotify Connect's login5 endpoint refuses tokens
 * minted by Web-API developer apps outright, so an "own app" model cannot
 * drive a Connect device at all (measured, not assumed: INVALID_CREDENTIALS
 * and BAD_REQUEST for every combination of custom client id and credential).
 *
 * The flow costs the operator one paste, once: the consent redirect points at
 * 127.0.0.1 — registered to that client id since forever — where nothing is
 * listening, and the address of that dead page carries the authorization
 * code. The operator pastes it into the console; the exchange happens here,
 * server-side. Only the refresh token is kept, AES-GCM-encrypted under a key
 * that lives in a Worker secret, and the source container is handed
 * hour-lived access tokens on demand.
 *
 * Starting the flow requires the operator passphrase — otherwise any visitor
 * could attach THEIR Spotify account to this deployment.
 */

import { json, timingSafeEqual, verifyHostToken } from "./auth";
import { decryptSecret, encryptSecret } from "./token-crypto";
import { isValidCode, normalizeCode } from "../shared/code";

/** Spotify's desktop client id — the identity librespot speaks as. */
export const SPOTIFY_CLIENT_ID = "65b708073fc0480ea92a077233ca87bd";

/** Registered to that client id; nothing listens there, and nothing needs to. */
const REDIRECT_URI = "http://127.0.0.1:8898/login";

/** `streaming` is the one scope Connect playback needs, and the one this client grants. */
const SCOPE = "streaming";

/** An abandoned login attempt is dead after this long. */
export const AUTH_TTL_MS = 10 * 60 * 1000;

/** There is exactly one operator per deployment; rows are keyed by this. */
const OPERATOR = "primary";

/* ------------------------------------------------------------------- login */

/** POST /api/spotify/login {passphrase} → {url} for the operator to open. */
export async function spotifyLogin(request: Request, env: Env): Promise<Response> {
  const body = (await request.json().catch(() => ({}))) as { passphrase?: string };
  const gate = requireConfig(env) ?? requirePassphrase(body.passphrase, env);
  if (gate) return gate;

  const verifier = randomB64url(32);
  const state = randomB64url(24);
  const challenge = b64url(await crypto.subtle.digest("SHA-256", ascii(verifier)));

  // The verifier stays server-side, keyed by the state nonce, until the
  // operator pastes the redirect address back.
  await env.DB.prepare(
    "INSERT INTO spotify_auth (state, verifier, redirect, created_at) VALUES (?1, ?2, ?3, ?4)",
  )
    .bind(state, verifier, REDIRECT_URI, Date.now())
    .run();

  const url = new URL("https://accounts.spotify.com/authorize");
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", SPOTIFY_CLIENT_ID);
  url.searchParams.set("redirect_uri", REDIRECT_URI);
  url.searchParams.set("scope", SCOPE);
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("code_challenge", challenge);
  return json({ url: url.toString() });
}

/**
 * POST /api/spotify/complete {passphrase, redirectUrl} — the operator pastes
 * the address of the dead 127.0.0.1 page Spotify left them on.
 */
export async function spotifyComplete(request: Request, env: Env): Promise<Response> {
  const body = (await request.json().catch(() => ({}))) as {
    passphrase?: string;
    redirectUrl?: string;
  };
  const gate = requireConfig(env) ?? requirePassphrase(body.passphrase, env);
  if (gate) return gate;

  let code: string | null = null;
  let state = "";
  try {
    const pasted = new URL((body.redirectUrl ?? "").trim());
    code = pasted.searchParams.get("code");
    state = pasted.searchParams.get("state") ?? "";
  } catch {
    return json({ error: "that does not look like the copied address" }, 400);
  }
  if (!code || !state) {
    return json({ error: "the pasted address is missing its code" }, 400);
  }

  // One shot: the state row is consumed whether or not the exchange succeeds,
  // so a replayed paste cannot retry the flow.
  const row = await env.DB.prepare(
    "DELETE FROM spotify_auth WHERE state = ?1 AND created_at > ?2 RETURNING verifier",
  )
    .bind(state, Date.now() - AUTH_TTL_MS)
    .first<{ verifier: string }>();
  if (!row) return json({ error: "this login attempt expired — start again" }, 410);

  const tokens = await exchange({
    grant_type: "authorization_code",
    code,
    redirect_uri: REDIRECT_URI,
    code_verifier: row.verifier,
  });
  if (!tokens?.refresh_token) return json({ error: "Spotify rejected the exchange" }, 502);

  await env.DB.prepare(
    `INSERT INTO spotify_tokens (operator, refresh_enc, scope, display_name, product, connected_at)
     VALUES (?1, ?2, ?3, NULL, NULL, ?4)
     ON CONFLICT(operator) DO UPDATE SET
       refresh_enc = ?2, scope = ?3, display_name = NULL, product = NULL, connected_at = ?4`,
  )
    .bind(OPERATOR, await encryptSecret(tokens.refresh_token, env.TOKEN_KEY), tokens.scope ?? SCOPE, Date.now())
    .run();

  return json({ connected: true });
}

/* ------------------------------------------------------------- status/logout */

/**
 * POST /api/spotify/status {passphrase} → what the console shows.
 *
 * Passphrase first, config second: this endpoint doubles as the console's
 * unlock check, and a deployment whose TOKEN_KEY is not set yet must still
 * let its operator in — to be told exactly that, on the page.
 */
export async function spotifyStatus(request: Request, env: Env): Promise<Response> {
  const body = (await request.json().catch(() => ({}))) as { passphrase?: string };
  const gate = requirePassphrase(body.passphrase, env);
  if (gate) return gate;
  if (requireConfig(env)) return json({ connected: false, configured: false });

  const row = await env.DB.prepare(
    "SELECT connected_at FROM spotify_tokens WHERE operator = ?1",
  )
    .bind(OPERATOR)
    .first<{ connected_at: number }>();

  if (!row) return json({ connected: false, configured: true });
  return json({ connected: true, configured: true, connectedAt: row.connected_at });
}

/** POST /api/spotify/logout {passphrase} — forget the refresh token. */
export async function spotifyLogout(request: Request, env: Env): Promise<Response> {
  const body = (await request.json().catch(() => ({}))) as { passphrase?: string };
  const gate = requireConfig(env) ?? requirePassphrase(body.passphrase, env);
  if (gate) return gate;
  await env.DB.prepare("DELETE FROM spotify_tokens WHERE operator = ?1").bind(OPERATOR).run();
  return json({ ok: true });
}

/* ----------------------------------------------------------- source tokens */

/**
 * POST /api/source/token {code, hostToken} → {accessToken, expiresInSec}.
 *
 * The container calls this at startup and again on every Spotify reconnect —
 * an env-var token would be an hour stale by then. Authentication is the
 * room's host token: the same credential that let the container join the
 * room as its source.
 */
export async function sourceToken(request: Request, env: Env): Promise<Response> {
  const body = (await request.json().catch(() => ({}))) as {
    code?: string;
    hostToken?: string;
  };
  const code = normalizeCode(body.code ?? "");
  if (!isValidCode(code)) return json({ error: "bad room code" }, 400);
  if (!(await verifyHostToken(body.hostToken ?? "", code, env))) {
    return json({ error: "not the host" }, 401);
  }

  const access = await freshAccessToken(env);
  if (!access) return json({ error: "spotify not connected" }, 409);
  return json({ accessToken: access.token, expiresInSec: access.expiresInSec });
}

/** Refresh-token dance, including Spotify's occasional refresh rotation. */
export async function freshAccessToken(
  env: Env,
): Promise<{ token: string; expiresInSec: number } | null> {
  const row = await env.DB.prepare(
    "SELECT refresh_enc FROM spotify_tokens WHERE operator = ?1",
  )
    .bind(OPERATOR)
    .first<{ refresh_enc: string }>();
  if (!row) return null;

  const refresh = await decryptSecret(row.refresh_enc, env.TOKEN_KEY).catch(() => null);
  if (!refresh) return null;

  const tokens = await exchange({ grant_type: "refresh_token", refresh_token: refresh });
  if (!tokens?.access_token) return null;

  if (tokens.refresh_token && tokens.refresh_token !== refresh) {
    await env.DB.prepare("UPDATE spotify_tokens SET refresh_enc = ?2 WHERE operator = ?1")
      .bind(OPERATOR, await encryptSecret(tokens.refresh_token, env.TOKEN_KEY))
      .run();
  }
  return { token: tokens.access_token, expiresInSec: tokens.expires_in ?? 3600 };
}

/* ---------------------------------------------------------------- internals */

interface TokenSet {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
}

/** One call to accounts.spotify.com/api/token, as the public client. */
async function exchange(params: Record<string, string>): Promise<TokenSet | null> {
  const resp = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ ...params, client_id: SPOTIFY_CLIENT_ID }),
  });
  if (!resp.ok) {
    console.log(JSON.stringify({ event: "spotify-exchange-failed", status: resp.status }));
    return null;
  }
  return (await resp.json()) as TokenSet;
}

function requireConfig(env: Env): Response | null {
  if (!env.TOKEN_KEY) {
    return json({ error: "server not configured: TOKEN_KEY unset" }, 503);
  }
  return null;
}

function requirePassphrase(given: string | undefined, env: Env): Response | null {
  if (!env.HOST_PASSPHRASE) {
    return json({ error: "server not configured: HOST_PASSPHRASE unset" }, 503);
  }
  if (!given || !timingSafeEqual(given, env.HOST_PASSPHRASE)) {
    return json({ error: "wrong passphrase" }, 401);
  }
  return null;
}

/* ------------------------------------------------------------------ base64 */

const ascii = (s: string) => new TextEncoder().encode(s);

function b64url(buf: ArrayBuffer): string {
  let s = "";
  for (const b of new Uint8Array(buf)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function randomB64url(bytes: number): string {
  const buf = crypto.getRandomValues(new Uint8Array(bytes));
  return b64url(buf.buffer as ArrayBuffer);
}
