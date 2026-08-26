/** The NDJSON contract with `downbeat-core`. */

export interface ConfigEvent {
  t: "config";
  source: string;
  sampleRate: number;
  channels: number;
  bufferMs: number;
  muted: boolean;
  local: boolean;
  offline: boolean;
}

export interface RoomEvent {
  t: "room";
  code: string;
  url: string;
  host: string;
  /** Rows of "0"/"1"; "1" is a dark module. */
  qr: string[];
}

/** One connected speaker, as the room's Durable Object sees it. */
export interface Member {
  id: string;
  name: string;
  role: string;
  /** Round-trip time in ms, last reported by that client. 0 = not yet reported. */
  rtt: number;
  /** Clock-offset confidence in ms. 0 = not yet reported. */
  sync: number;
  /** Track id this member has fully buffered, or null. */
  readyFor: string | null;
  /** Measured start error in ms against the scheduled instant, or null. */
  startError: number | null;
}

export interface MembersEvent {
  t: "members";
  count: number;
  list: Member[];
}

export interface StatusEvent {
  t: "status";
  peakDb: number;
  capturedSec: number;
  packets: number;
  kbits: number;
  clockMs: number;
  synced: boolean;
  /** The adaptive delay budget as it currently stands, ms. */
  bufferMs?: number;
  starved: number;
  reanchors: number;
  listeners: number;
  uptimeSec: number;
  /** Output level for the host Mac only, 0...1. */
  localGain: number;
  /** Which app is being captured right now. */
  source: string;
  /** dBFS per ~10 ms of capture since the last status, oldest first. */
  levels?: number[];
}

export interface ListenersEvent {
  t: "listeners";
  count: number;
}

export interface SourcesEvent {
  t: "sources";
  current: string;
  list: Array<{ pid: number; name: string; active: boolean }>;
}

export interface SourceEvent {
  t: "source";
  label: string;
  pid: number;
}

export interface LocalEvent {
  t: "local";
  gain: number;
}

export interface LinkEvent {
  t: "link";
  up: boolean;
  reason: string;
}

export interface LogEvent {
  t: "log";
  level: "info" | "warn" | "error";
  msg: string;
}

export type CoreEvent =
  | ConfigEvent
  | RoomEvent
  | MembersEvent
  | StatusEvent
  | ListenersEvent
  | SourcesEvent
  | SourceEvent
  | LocalEvent
  | LinkEvent
  | LogEvent;

/**
 * Split a byte stream into NDJSON events.
 *
 * The core writes a line at a time, but a pipe does not promise to deliver it
 * that way: a status line can arrive in two chunks, and two lines can arrive as
 * one. Anything that is not valid JSON is surfaced as a log line rather than
 * dropped, because that is where a core-side error message would appear.
 */
export function createParser(onEvent: (event: CoreEvent) => void) {
  let buffer = "";
  return (chunk: string) => {
    buffer += chunk;
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        onEvent(JSON.parse(trimmed) as CoreEvent);
      } catch {
        onEvent({ t: "log", level: "error", msg: trimmed });
      }
    }
  };
}
