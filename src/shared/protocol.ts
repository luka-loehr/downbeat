/**
 * Wire protocol between browser clients and the RoomDO.
 *
 * All timestamps named `*At` / `t0` / `t1` / `t2` are milliseconds in the
 * ROOM CLOCK domain -- the Durable Object's `Date.now()`. Clients never use
 * their own wall clock for scheduling; they use `SyncedClock.now()`, which
 * maps local `performance.now()` into this domain.
 */

export const PROTOCOL_VERSION = 1;

/** Crockford base32 without I, L, O, U -- unambiguous when read aloud. */
export const CODE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
export const CODE_LENGTH = 6;

/** `source` is a Downbeat CLI feeding live audio into the room. */
export type Role = "host" | "listener" | "source";

export interface Track {
  id: string;
  title: string;
  /** Seconds. 0 when unknown (client fills it in after decode). */
  duration: number;
  /** Bytes, for the prefetch progress UI. */
  size: number;
  mimeType: string;
}

export interface Member {
  id: string;
  name: string;
  role: Role;
  /** Round-trip time in ms, as last reported by that client. */
  rtt: number;
  /** Clock-offset confidence in ms, as last reported by that client. */
  sync: number;
  /** Track id this member has fully buffered, or null. */
  readyFor: string | null;
  /** Measured start error in ms vs. the scheduled instant; null until played. */
  startError: number | null;
  /**
   * The device's total room-clock-to-speaker offset in ms, as it currently
   * believes it to be: clock offset, hardware output latency, and the drift
   * controller's standing error combined.
   *
   * This is the only number that says anything about whether two devices agree
   * with EACH OTHER. A device's internal control error can read zero on both
   * while they are audibly apart, because each is steering towards its own idea
   * of where the speaker is. The spread of this value across the room is the
   * inter-device sync error, and it is what the host displays.
   */
  playoutMs: number | null;
}

/** `arming` = everyone is buffering; `scheduled` = deadline set, waiting for it. */
export type PlayMode = "idle" | "arming" | "scheduled" | "playing" | "paused";

/** Describes the live stream currently being fed into a room, if any. */
export interface LiveState {
  active: boolean;
  sampleRate: number;
  channels: number;
  /** Frames per Opus packet -- 960 at 48 kHz, i.e. 20 ms. */
  frameSize: number;
  /** Delay between capture and playout, ms. */
  bufferMs: number;
  /** What is being captured, for the UI. */
  sourceLabel: string;
  /**
   * Identifies one run of the source across reconnects. A re-announce with
   * the same epoch means "the stream you are playing", so a listener that
   * never noticed the outage keeps playing without a restart; a new epoch is
   * a restarted CLI with a fresh sample timeline, which requires one.
   */
  epoch?: number;
}

export interface RoomState {
  code: string;
  mode: PlayMode;
  queue: Track[];
  /** Index into `queue`, or -1. */
  current: number;
  /** Room-clock instant at which playback starts. Meaningful when scheduled/playing. */
  startAt: number;
  /** Seconds into the track that `startAt` corresponds to. */
  offsetInTrack: number;
  /** Bumped on every transport change so late/duplicate messages can be dropped. */
  seq: number;
  members: Member[];
  live: LiveState | null;
}

/* ---------------------------------------------------------------- client -> server */

export type ClientMessage =
  | { t: "hello"; role: Role; name: string; hostToken?: string; v: number }
  /** Time probe. `t0` is the client's `performance.now()` at send. */
  | { t: "ping"; t0: number }
  /** Client has decoded `trackId` and can start on demand. */
  | { t: "ready"; trackId: string; seq: number }
  /** Client's own quality telemetry, shown on the host's device list. */
  | {
      t: "telemetry";
      rtt: number;
      sync: number;
      startError: number | null;
      playoutMs?: number | null;
    }
  | { t: "cmd"; cmd: HostCommand };

export type HostCommand =
  | { c: "play"; index?: number; offsetInTrack?: number }
  | { c: "pause" }
  | { c: "seek"; offsetInTrack: number }
  | { c: "next" }
  | { c: "prev" }
  | { c: "addTracks"; tracks: Track[] }
  | { c: "removeTrack"; id: string }
  /** Start even though not every member has buffered. */
  | { c: "forceStart" }
  /** The calling socket becomes this room's live audio source. */
  | { c: "liveStart"; live: Omit<LiveState, "active"> }
  | { c: "liveStop" };

/* ---------------------------------------------------------------- server -> client */

export type ServerMessage =
  /**
   * Time-probe reply. `t1` is stamped as the FIRST statement of the message
   * handler: in Workers `Date.now()` only advances after I/O, and the socket
   * read is that I/O, so stamping before any other work keeps it fresh.
   */
  | { t: "pong"; t0: number; t1: number }
  | { t: "welcome"; you: string; role: Role; state: RoomState; v: number }
  | { t: "state"; state: RoomState }
  /** Arm for a scheduled start. */
  | { t: "play"; trackId: string; startAt: number; offsetInTrack: number; seq: number }
  | { t: "pause"; seq: number }
  | { t: "live"; live: LiveState | null }
  | { t: "error"; message: string; fatal: boolean };

/**
 * Live audio does not travel as JSON. Each binary frame is:
 *
 *   [ Float64 playAtRoomMs ][ Float64 sampleIndex ][ Opus packet bytes ]
 *
 * `playAtRoomMs` anchors the stream to the room clock once, and is what makes a
 * late packet detectable. `sampleIndex` is what the receiver actually places by.
 *
 * Both are needed, and the reason is the whole difference between clean audio
 * and a crackle. Deriving a packet's position from its timestamp means running
 * it through the room->context mapping fifty times a second, and that mapping
 * moves by fractions of a millisecond as the clock is corrected. Rounded to
 * samples, consecutive packets then land 959 or 961 frames apart instead of
 * exactly 960, and every one-sample hole is a click. The sample index is exact
 * and monotonic, so placement is contiguous by construction; the timestamp is
 * consulted once to decide where the stream begins, and afterwards only to
 * notice if it has drifted far enough to be worth re-anchoring.
 */
export const LIVE_HEADER_BYTES = 16;

/** Seconds of lead time granted so every client can schedule before the deadline. */
export const MIN_LEAD_MS = 1500;
/** Extra lead per client that has not yet buffered, capped by MAX_LEAD_MS. */
export const MAX_LEAD_MS = 15000;
