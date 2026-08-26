/**
 * Host-token authority and the small crypto helpers everything shares.
 *
 * A host token is `code.expiresAt.signature` — HMAC-signed with a key derived
 * from the operator passphrase, and only honoured while it is ALSO the session
 * on record in D1. The signature alone cannot be revoked and cannot be
 * superseded by a takeover, so the database is the authority on who currently
 * owns a room.
 */

export async function hmacKey(env: Env): Promise<CryptoKey> {
  const secret = env.HOST_PASSPHRASE ?? "";
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(`downbeat:${secret}`),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

export async function mintHostToken(code: string, expiresAt: number, env: Env): Promise<string> {
  const payload = `${code}.${expiresAt}`;
  const sig = await crypto.subtle.sign("HMAC", await hmacKey(env), enc(payload));
  return `${payload}.${b64url(sig)}`;
}

export async function verifyHostToken(token: string, code: string, env: Env): Promise<boolean> {
  const parts = token.split(".");
  if (parts.length !== 3) return false;
  const [tokenCode, expRaw, sig] = parts;
  if (tokenCode !== code) return false;

  const exp = Number(expRaw);
  const now = Date.now();
  if (!Number.isFinite(exp) || exp < now) return false;

  const expected = await crypto.subtle.sign("HMAC", await hmacKey(env), enc(`${tokenCode}.${expRaw}`));
  if (!timingSafeEqual(sig, b64url(expected))) return false;

  const row = await env.DB.prepare(
    "SELECT token_hash FROM sessions WHERE code = ?1 AND revoked = 0 AND expires_at > ?2",
  )
    .bind(code, now)
    .first<{ token_hash: string }>();
  if (!row) return false;
  if (!timingSafeEqual(row.token_hash, await sha256Hex(token))) return false;

  await env.DB.prepare("UPDATE sessions SET last_seen_at = ?2 WHERE code = ?1")
    .bind(code, now)
    .run();
  return true;
}

/** Constant-time compare so a wrong passphrase leaks no timing signal. */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export const enc = (s: string) => new TextEncoder().encode(s);

export async function sha256Hex(text: string): Promise<string> {
  return hex(await crypto.subtle.digest("SHA-256", enc(text)));
}

export function hex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function b64url(buf: ArrayBuffer): string {
  let s = "";
  for (const b of new Uint8Array(buf)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}
