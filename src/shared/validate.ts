/**
 * Shape checks for everything a client can send the server.
 *
 * TypeScript types stop at the wire: a socket can carry any JSON. Whatever is
 * accepted here is stored in the room and broadcast to every device, so a
 * value of the wrong type or size must not get past this file.
 */
import type { HostCommand, LiveState, Track } from "./protocol";

/** JSON bodies of the room endpoints are a passphrase and a few short fields. */
export const MAX_JSON_BODY_BYTES = 4096;
/** A text frame is a command or a telemetry report; `addTracks` is the largest. */
export const MAX_TEXT_FRAME_CHARS = 64 * 1024;
/** One live audio frame: 20 ms of 24-bit FLAC is ~4 kB; this leaves 60x headroom. */
export const MAX_AUDIO_FRAME_BYTES = 256 * 1024;
export const MAX_QUEUE = 200;
export const MAX_NAME_CHARS = 24;
export const MAX_LABEL_CHARS = 80;
export const MAX_TITLE_CHARS = 120;
/** A day, in seconds: no track or seek target is longer. */
export const MAX_TRACK_SECONDS = 86_400;

type Json = Record<string, unknown>;

export function isObject(v: unknown): v is Json {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** A finite number inside [min, max], else `fallback`. */
export function num<T>(v: unknown, fallback: T, min = -1e12, max = 1e12): number | T {
  return typeof v === "number" && Number.isFinite(v) && v >= min && v <= max ? v : fallback;
}

/** C0/C1 control characters and the two Unicode line separators. */
function isControl(code: number): boolean {
  return code < 0x20 || (code >= 0x7f && code <= 0x9f) || code === 0x2028 || code === 0x2029;
}

/** Printable text: control characters removed, trimmed, cut to `max`. */
export function cleanText(v: unknown, max: number): string {
  if (typeof v !== "string") return "";
  let out = "";
  for (const ch of v.slice(0, max * 4)) if (!isControl(ch.codePointAt(0)!)) out += ch;
  return out.trim().slice(0, max);
}

export interface Telemetry {
  rtt: number;
  sync: number;
  startError: number | null;
  playoutMs: number | null;
  marginMs: number | null;
  cushionMs: number | null;
  underruns: number | null;
  ctxRate: number | null;
  stuck: boolean;
}

/** Numbers stay numbers; anything else becomes the "not reported" value. */
export function sanitizeTelemetry(msg: unknown): Telemetry {
  const m = isObject(msg) ? msg : {};
  return {
    rtt: num(m.rtt, 0, 0),
    sync: num(m.sync, 0, 0),
    startError: num(m.startError, null),
    playoutMs: num(m.playoutMs, null),
    marginMs: num(m.marginMs, null),
    cushionMs: num(m.cushionMs, null),
    underruns: num(m.underruns, null, 0),
    ctxRate: num(m.ctxRate, null, 0, 1e6),
    stuck: m.stuck === true,
  };
}

/** Track ids are the first 32 hex digits of the upload's SHA-256. */
export const isTrackId = (v: unknown): v is string => typeof v === "string" && /^[0-9a-f]{32}$/.test(v);

export function sanitizeTrack(v: unknown): Track | null {
  if (!isObject(v) || !isTrackId(v.id)) return null;
  return {
    id: v.id,
    title: cleanText(v.title, MAX_TITLE_CHARS) || "Untitled",
    duration: num(v.duration, 0, 0, MAX_TRACK_SECONDS),
    size: num(v.size, 0, 0),
    mimeType: cleanText(v.mimeType, 64),
  };
}

export function sanitizeLive(v: unknown): Omit<LiveState, "active"> | null {
  if (!isObject(v)) return null;
  const sampleRate = num(v.sampleRate, null, 8000, 384_000);
  const channels = num(v.channels, null, 1, 8);
  const frameSize = num(v.frameSize, null, 1, 65_536);
  const bufferMs = num(v.bufferMs, null, 0, 60_000);
  if (sampleRate === null || channels === null || frameSize === null || bufferMs === null) return null;
  if (!Number.isInteger(channels) || !Number.isInteger(frameSize)) return null;
  if (v.codec !== undefined && v.codec !== "opus" && v.codec !== "flac") return null;
  const live: Omit<LiveState, "active"> = {
    sampleRate,
    channels,
    frameSize,
    bufferMs,
    sourceLabel: cleanText(v.sourceLabel, MAX_LABEL_CHARS),
  };
  if (v.codec !== undefined) live.codec = v.codec;
  const bitDepth = num(v.bitDepth, null, 8, 32);
  if (bitDepth !== null) live.bitDepth = bitDepth;
  const epoch = num(v.epoch, null, 0, 1e15);
  if (epoch !== null) live.epoch = epoch;
  return live;
}

/** A well-formed host command, or null. Unknown fields are dropped. */
export function sanitizeCommand(v: unknown): HostCommand | null {
  if (!isObject(v)) return null;
  switch (v.c) {
    case "pause":
    case "next":
    case "prev":
    case "forceStart":
    case "liveStop":
      return { c: v.c };
    case "play": {
      const cmd: HostCommand = { c: "play" };
      if (v.index !== undefined) {
        const index = num(v.index, null, 0, MAX_QUEUE - 1);
        if (index === null || !Number.isInteger(index)) return null;
        cmd.index = index;
      }
      if (v.offsetInTrack !== undefined) {
        const offset = num(v.offsetInTrack, null, 0, MAX_TRACK_SECONDS);
        if (offset === null) return null;
        cmd.offsetInTrack = offset;
      }
      return cmd;
    }
    case "seek": {
      const offset = num(v.offsetInTrack, null, -MAX_TRACK_SECONDS, MAX_TRACK_SECONDS);
      return offset === null ? null : { c: "seek", offsetInTrack: offset };
    }
    case "addTracks": {
      if (!Array.isArray(v.tracks) || v.tracks.length > MAX_QUEUE) return null;
      const tracks: Track[] = [];
      for (const raw of v.tracks) {
        const track = sanitizeTrack(raw);
        if (!track) return null;
        tracks.push(track);
      }
      return { c: "addTracks", tracks };
    }
    case "removeTrack":
      return isTrackId(v.id) ? { c: "removeTrack", id: v.id } : null;
    case "liveStart": {
      const live = sanitizeLive(v.live);
      return live ? { c: "liveStart", live } : null;
    }
    default:
      return null;
  }
}

/** Seconds from the `X-Track-Duration` header; 0 when absent or nonsense. */
export function parseDuration(raw: string | null): number {
  if (!raw || !/^\d+(\.\d+)?$/.test(raw.trim())) return 0;
  return num(Number(raw), 0, 0, MAX_TRACK_SECONDS);
}

export class BodyTooLarge extends Error {}

/**
 * Reads a request body up to `max` bytes and throws `BodyTooLarge` beyond it,
 * without first buffering a body of unknown size.
 */
export async function readCapped(request: Request, max: number): Promise<Uint8Array> {
  const declared = request.headers.get("content-length");
  if (declared !== null && Number(declared) > max) throw new BodyTooLarge();
  if (!request.body) return new Uint8Array(0);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel();
      throw new BodyTooLarge();
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.byteLength;
  }
  return out;
}

/** A small JSON object body, or null when it is missing, malformed, not an object or too large. */
export async function readJsonObject(request: Request, max = MAX_JSON_BODY_BYTES): Promise<Json | null> {
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(await readCapped(request, max)));
    return isObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}
