/**
 * The operator's Spotify connection.
 *
 * Downbeat is self-hosted and single-operator: one deployment, one Spotify
 * account — the operator's own. This module runs the Authorization Code +
 * PKCE flow entirely server-side (the redirect lands on this Worker, never on
 * localhost), keeps only the refresh token, AES-GCM-encrypted under a key
 * that lives in a Worker secret, and mints short-lived access tokens for the
 * source container on demand. The container never sees the client secret or
 * the refresh token; a compromised container holds nothing that outlives an
 * hour.
 *
 * Starting the flow requires the operator passphrase — otherwise any visitor
 * could attach THEIR Spotify account to this deployment and stream on the
 * operator's bill.
 */

import { json, timingSafeEqual, verifyHostToken } from "./auth";
import { decryptSecret, encryptSecret } from "./token-crypto";
import { isValidCode, normalizeCode } from "../shared/code";

/**
 * `streaming` is the scope librespot needs to register as a Connect device;
 * the profile scopes let the dashboard show whose account is connected and
 * warn when it is not Premium (Connect playback requires Premium).
 */
const SCOPE = "streaming user-read-email user-read-private";

/** An abandoned login attempt is dead after this long. */
export const AUTH_TTL_MS = 10 * 60 * 1000;

/** There is exactly one operator per deployment; rows are keyed by this. */
const OPERATOR = "primary";

/* ------------------------------------------------------------------- login */

/** POST /api/spotify/login {passphrase} → {url} for the browser to follow. */
export async function spotifyLogin(request: Request, env: Env): Promise<Response> {
  const body = (await request.json().catch(() => ({}))) as { passphrase?: string };
  const gate = requireConfig(env) ?? requirePassphrase(body.passphrase, env);
  if (gate) return gate;

  const verifier = randomB64url(32);
  const state = randomB64url(24);
  const challenge = b64url(await crypto.subtle.digest("SHA-256", ascii(verifier)));
  const redirect = `${new URL(request.url).origin}/api/spotify/callback`;

  // The verifier never rides in a URL the browser could leak; it waits here,
  // keyed by the state nonce, until Spotify sends the browser back.
  await env.DB.prepare(
    "INSERT INTO spotify_auth (state, verifier, redirect, created_at) VALUES (?1, ?2, ?3, ?4)",
  )
    .bind(state, verifier, redirect, Date.now())
    .run();

  const url = new URL("https://accounts.spotify.com/authorize");
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", env.SPOTIFY_CLIENT_ID);
  url.searchParams.set("redirect_uri", redirect);
  url.searchParams.set("scope", SCOPE);
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("code_challenge", challenge);
  return json({ url: url.toString() });
}

/** GET /api/spotify/callback — Spotify sends the browser here. */
export async function spotifyCallback(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const back = (outcome: string) =>
    Response.redirect(`${url.origin}/host?spotify=${outcome}`, 302);

  if (url.searchParams.get("error")) return back("denied");
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state") ?? "";
  if (!code || !state) return back("error");

  // One shot: the state row is consumed whether or not the exchange succeeds,
  // so a replayed callback URL cannot retry the flow.
  const row = await env.DB.prepare(
    "DELETE FROM spotify_auth WHERE state = ?1 AND created_at > ?2 RETURNING verifier, redirect",
  )
    .bind(state, Date.now() - AUTH_TTL_MS)
    .first<{ verifier: string; redirect: string }>();
  if (!row) return back("expired");

  const tokens = await exchange(env, {
    grant_type: "authorization_code",
    code,
    redirect_uri: row.redirect,
    code_verifier: row.verifier,
  });
  if (!tokens?.refresh_token) return back("error");
  // A token without `streaming` cannot drive a Connect device; better to fail
  // here, loudly, than when the container tries to log in.
  if (!(tokens.scope ?? "").includes("streaming")) return back("scope");

  // Who connected? Shown on the dashboard, and Premium is checked up front.
  const me = (await (
    await fetch("https://api.spotify.com/v1/me", {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    })
  )
    .json()
    .catch(() => ({}))) as { display_name?: string; product?: string };

  await env.DB.prepare(
    `INSERT INTO spotify_tokens (operator, refresh_enc, scope, display_name, product, connected_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6)
     ON CONFLICT(operator) DO UPDATE SET
       refresh_enc = ?2, scope = ?3, display_name = ?4, product = ?5, connected_at = ?6`,
  )
    .bind(
      OPERATOR,
      await encryptSecret(tokens.refresh_token, env.TOKEN_KEY),
      tokens.scope ?? SCOPE,
      me.display_name ?? null,
      me.product ?? null,
      Date.now(),
    )
    .run();

  return back(me.product === "premium" ? "connected" : "free");
}

/* ------------------------------------------------------------- status/logout */

/** POST /api/spotify/status {passphrase} → what the dashboard shows. */
export async function spotifyStatus(request: Request, env: Env): Promise<Response> {
  const body = (await request.json().catch(() => ({}))) as { passphrase?: string };
  const gate = requireConfig(env) ?? requirePassphrase(body.passphrase, env);
  if (gate) return gate;

  const row = await env.DB.prepare(
    "SELECT display_name, product, scope, connected_at FROM spotify_tokens WHERE operator = ?1",
  )
    .bind(OPERATOR)
    .first<{ display_name: string | null; product: string | null; scope: string; connected_at: number }>();

  if (!row) return json({ connected: false });
  return json({
    connected: true,
    displayName: row.display_name,
    product: row.product,
    connectedAt: row.connected_at,
  });
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
 * the env-var token it might have been born with would be an hour stale by
 * then. Authentication is the room's host token: the same credential that let
 * the container join the room as its source.
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

  const tokens = await exchange(env, { grant_type: "refresh_token", refresh_token: refresh });
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

/** One call to accounts.spotify.com/api/token, authenticated as our app. */
async function exchange(env: Env, params: Record<string, string>): Promise<TokenSet | null> {
  const resp = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${btoa(`${env.SPOTIFY_CLIENT_ID}:${env.SPOTIFY_CLIENT_SECRET}`)}`,
    },
    body: new URLSearchParams(params),
  });
  if (!resp.ok) {
    console.log(JSON.stringify({ event: "spotify-exchange-failed", status: resp.status }));
    return null;
  }
  return (await resp.json()) as TokenSet;
}

function requireConfig(env: Env): Response | null {
  if (!env.SPOTIFY_CLIENT_ID || !env.SPOTIFY_CLIENT_SECRET) {
    return json({ error: "server not configured: Spotify secrets unset" }, 503);
  }
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
