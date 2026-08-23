import { RoomDO } from "./room-do";
import { generateCode, isValidCode, normalizeCode } from "../shared/code";
import { BUILD_ID } from "../shared/build";
import { CODE_ALPHABET, CODE_LENGTH } from "../shared/protocol";
import type { Track } from "../shared/protocol";

export { RoomDO };

/** 25 MB per track: comfortably a 10-minute 320 kbps MP3. */
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
/** A session -- and everything uploaded during it -- lives for one day. */
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;

const ALLOWED_AUDIO = new Set([
  "audio/mpeg",
  "audio/mp4",
  "audio/aac",
  "audio/ogg",
  "audio/wav",
  "audio/x-wav",
  "audio/flac",
  "audio/x-flac",
  "audio/webm",
]);

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const { pathname } = url;

    try {
      if (pathname === "/api/health") {
        // BUILD_ID is injected at build time; open tabs compare against it.
        return new Response(
          JSON.stringify({ ok: true, service: "downbeat", build: BUILD_ID }),
          {
            headers: {
              "content-type": "application/json; charset=utf-8",
              "cache-control": "no-store",
            },
          },
        );
      }

      if (pathname === "/api/rooms" && request.method === "POST") {
        return await createRoom(request, env);
      }

      if (pathname === "/api/rooms/end" && request.method === "POST") {
        return await endRoom(request, env);
      }

      if (pathname === "/api/ws") {
        return await joinRoom(request, env);
      }

      if (pathname === "/api/upload" && request.method === "POST") {
        return await upload(request, env);
      }

      if (pathname.startsWith("/audio/")) {
        return await serveAudio(request, env, ctx, pathname.slice("/audio/".length));
      }

      if (pathname.startsWith("/api/")) {
        return json({ error: "not found" }, 404);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : "unexpected error";
      return json({ error: message }, 500);
    }

    return env.ASSETS.fetch(request);
  },
  /**
   * Hourly sweep. Sessions and their audio are not meant to outlive the party
   * that created them: expired rows are removed, and any R2 object no live
   * upload row still points at goes with them. Without this the bucket only
   * ever grows, and every abandoned session stays a valid claim on its code.
   */
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(sweep(env));
  },
} satisfies ExportedHandler<Env>;

async function sweep(env: Env): Promise<void> {
  const now = Date.now();
  const cutoff = now - SESSION_TTL_MS;

  await env.DB.prepare("DELETE FROM sessions WHERE expires_at < ?1 OR (revoked = 1 AND last_seen_at < ?2)")
    .bind(now, cutoff)
    .run();

  // Audio is content-addressed, so the same id can be shared by several rooms.
  // Only drop an object once every row referencing it has aged out.
  const stale = await env.DB.prepare(
    "SELECT id FROM uploads GROUP BY id HAVING MAX(created_at) < ?1 LIMIT 500",
  )
    .bind(cutoff)
    .all<{ id: string }>();

  for (const row of stale.results ?? []) {
    await env.AUDIO.delete(row.id);
    await env.DB.prepare("DELETE FROM uploads WHERE id = ?1").bind(row.id).run();
  }

  console.log(
    JSON.stringify({ event: "sweep", removedObjects: (stale.results ?? []).length, at: now }),
  );
}

/* ------------------------------------------------------------------ rooms */

async function createRoom(request: Request, env: Env): Promise<Response> {
  const body = (await request.json().catch(() => ({}))) as {
    passphrase?: string;
    code?: string;
    takeover?: boolean;
    sourceLabel?: string;
  };
  const expected = env.HOST_PASSPHRASE;

  if (!expected) {
    return json({ error: "server not configured: HOST_PASSPHRASE unset" }, 503);
  }
  if (!body.passphrase || !timingSafeEqual(body.passphrase, expected)) {
    return json({ error: "wrong passphrase" }, 401);
  }

  // A host may name their own room -- handy for a code printed on a poster, or
  // for reclaiming the same room after a restart. Safe because getting this far
  // already required the passphrase.
  let code: string;
  if (body.code) {
    code = normalizeCode(body.code);
    if (!isValidCode(code)) {
      return json({ error: `bad code: ${CODE_LENGTH} chars from ${CODE_ALPHABET}` }, 400);
    }
  } else {
    code = generateCode();
  }

  const now = Date.now();

  // Two hosts feeding one room would interleave two audio streams into the same
  // decoder. Refuse rather than produce noise, and make taking over explicit.
  const existing = await env.DB.prepare(
    "SELECT created_at, source_label FROM sessions WHERE code = ?1 AND revoked = 0 AND expires_at > ?2",
  )
    .bind(code, now)
    .first<{ created_at: number; source_label: string | null }>();

  if (existing && !body.takeover) {
    return json(
      {
        error: "room already hosted",
        code,
        since: existing.created_at,
        sourceLabel: existing.source_label,
      },
      409,
    );
  }

  const expiresAt = now + SESSION_TTL_MS;
  const hostToken = await mintHostToken(code, expiresAt, env);

  // Only the hash is stored: a leaked database must not hand out live sessions.
  await env.DB.prepare(
    `INSERT INTO sessions (code, token_hash, created_at, expires_at, last_seen_at, source_label, revoked)
     VALUES (?1, ?2, ?3, ?4, ?3, ?5, 0)
     ON CONFLICT(code) DO UPDATE SET
       token_hash = ?2, created_at = ?3, expires_at = ?4, last_seen_at = ?3,
       source_label = ?5, revoked = 0`,
  )
    .bind(code, await sha256Hex(hostToken), now, expiresAt, body.sourceLabel ?? null)
    .run();

  return json({ code, hostToken, expiresAt, tookOver: !!existing });
}

/** A host giving the room back, so the code is immediately reusable. */
async function endRoom(request: Request, env: Env): Promise<Response> {
  const body = (await request.json().catch(() => ({}))) as {
    code?: string;
    hostToken?: string;
  };
  const code = normalizeCode(body.code ?? "");
  if (!isValidCode(code)) return json({ error: "bad room code" }, 400);
  if (!(await verifyHostToken(body.hostToken ?? "", code, env))) {
    return json({ error: "not the host" }, 401);
  }
  await env.DB.prepare("UPDATE sessions SET revoked = 1 WHERE code = ?1").bind(code).run();
  return json({ ok: true });
}

async function joinRoom(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const code = normalizeCode(url.searchParams.get("code") ?? "");

  if (!isValidCode(code)) return json({ error: "bad room code" }, 400);

  // Host and source roles are granted only against a signed token, never on
  // request. `source` is the CLI feeding live audio; it may push binary frames.
  let role = "listener";
  const token = url.searchParams.get("hostToken");
  if (token && (await verifyHostToken(token, code, env))) {
    role = url.searchParams.get("role") === "source" ? "source" : "host";
  }

  const forward = new URL(request.url);
  forward.searchParams.set("code", code);
  forward.searchParams.set("role", role);
  forward.searchParams.delete("hostToken");

  const id = env.ROOM.idFromName(code);
  return env.ROOM.get(id).fetch(new Request(forward, request));
}

/* ------------------------------------------------------------------ audio */

async function upload(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const code = normalizeCode(url.searchParams.get("code") ?? "");
  const token = url.searchParams.get("hostToken") ?? "";

  if (!isValidCode(code)) return json({ error: "bad room code" }, 400);
  if (!(await verifyHostToken(token, code, env))) return json({ error: "not the host" }, 401);

  const type = (request.headers.get("Content-Type") ?? "").split(";")[0].trim();
  if (!ALLOWED_AUDIO.has(type)) return json({ error: `unsupported type: ${type}` }, 415);

  const declared = Number(request.headers.get("Content-Length") ?? "0");
  if (declared > MAX_UPLOAD_BYTES) {
    return json({ error: `too large (max ${MAX_UPLOAD_BYTES} bytes)` }, 413);
  }

  const bytes = new Uint8Array(await request.arrayBuffer());
  if (!bytes.byteLength) return json({ error: "empty body" }, 400);
  if (bytes.byteLength > MAX_UPLOAD_BYTES) {
    return json({ error: `too large (max ${MAX_UPLOAD_BYTES} bytes)` }, 413);
  }

  // Content-addressed: re-uploading the same song across rooms costs nothing.
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const id = hex(digest).slice(0, 32);

  const existing = await env.AUDIO.head(id);
  if (!existing) {
    await env.AUDIO.put(id, bytes, {
      httpMetadata: { contentType: type, cacheControl: "public, max-age=31536000, immutable" },
      customMetadata: { uploaded: String(Date.now()) },
    });
  }

  await env.DB.prepare(
    "INSERT INTO uploads (id, code, size, created_at) VALUES (?1, ?2, ?3, ?4) " +
      "ON CONFLICT(id) DO UPDATE SET created_at = ?4",
  )
    .bind(id, code, bytes.byteLength, Date.now())
    .run();

  const title = decodeTitle(request.headers.get("X-Track-Title")).slice(0, 120);
  const track: Track = {
    id,
    title,
    duration: Number(request.headers.get("X-Track-Duration") ?? "0") || 0,
    size: bytes.byteLength,
    mimeType: type,
  };
  return json({ track });
}

async function serveAudio(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  key: string,
): Promise<Response> {
  if (!/^[0-9a-f]{32}$/.test(key)) return new Response("bad key", { status: 400 });

  // Edge cache first: every extra listener in the room is then a cache hit.
  const cache = caches.default;
  const cacheKey = new Request(new URL(request.url).toString(), { method: "GET" });
  if (!request.headers.has("Range")) {
    const hit = await cache.match(cacheKey);
    if (hit) return hit;
  }

  const object = await env.AUDIO.get(key, {
    range: request.headers,
    onlyIf: request.headers,
  });
  if (!object) return new Response("not found", { status: 404 });

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("etag", object.httpEtag);
  headers.set("accept-ranges", "bytes");
  headers.set("cache-control", "public, max-age=31536000, immutable");

  if (!("body" in object)) {
    return new Response(null, { status: 304, headers });
  }

  const range = object.range as { offset?: number; length?: number } | undefined;
  let status = 200;
  if (request.headers.has("Range") && range && typeof range.offset === "number") {
    const start = range.offset;
    const end = start + (range.length ?? object.size - start) - 1;
    headers.set("content-range", `bytes ${start}-${end}/${object.size}`);
    status = 206;
  }

  const response = new Response(object.body, { status, headers });
  if (status === 200) ctx.waitUntil(cache.put(cacheKey, response.clone()));
  return response;
}

/* ------------------------------------------------------------------ host tokens */

async function hmacKey(env: Env): Promise<CryptoKey> {
  const secret = env.HOST_PASSPHRASE ?? "";
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(`downbeat:${secret}`),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

async function mintHostToken(code: string, expiresAt: number, env: Env): Promise<string> {
  const payload = `${code}.${expiresAt}`;
  const sig = await crypto.subtle.sign("HMAC", await hmacKey(env), enc(payload));
  return `${payload}.${b64url(sig)}`;
}

/**
 * A token is only good if it is BOTH correctly signed and still the session on
 * record. The signature alone cannot be revoked and cannot be superseded by a
 * takeover, so the database is the authority on who currently owns a room.
 */
async function verifyHostToken(token: string, code: string, env: Env): Promise<boolean> {
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

/* ------------------------------------------------------------------ small helpers */

/** Constant-time compare so a wrong passphrase leaks no timing signal. */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

const enc = (s: string) => new TextEncoder().encode(s);

async function sha256Hex(text: string): Promise<string> {
  return hex(await crypto.subtle.digest("SHA-256", enc(text)));
}

/** Titles arrive percent-encoded because HTTP headers cannot carry UTF-8. */
function decodeTitle(raw: string | null): string {
  if (!raw) return "Untitled";
  try {
    return decodeURIComponent(raw) || "Untitled";
  } catch {
    return raw;
  }
}

function hex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function b64url(buf: ArrayBuffer): string {
  let s = "";
  for (const b of new Uint8Array(buf)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}
