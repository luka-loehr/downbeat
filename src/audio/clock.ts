/**
 * SyncedClock -- maps this device's monotonic clock into the room clock.
 *
 * Cristian's algorithm over the room WebSocket. The room clock is whatever the
 * Durable Object's `Date.now()` says; it does not need to be correct in an
 * absolute sense. Sync here is RELATIVE: if the DO clock is 40 ms away from
 * UTC, every device is 40 ms away *together* and they still agree with each
 * other. Only per-device jitter matters, and that is what min-RTT filtering
 * removes.
 *
 * `performance.now()` is the local time base, never `Date.now()`: it is
 * monotonic, so an NTP correction or the user editing their clock mid-song
 * cannot yank playback sideways.
 */

export interface ClockSample {
  rtt: number;
  offset: number;
}

export interface ClockStats {
  /** Best estimate of round-trip time, ms. */
  rtt: number;
  /** Spread of the accepted offset samples, ms -- our honest uncertainty. */
  uncertainty: number;
  /** How many probes have landed. */
  samples: number;
  synced: boolean;
}

/** Probes in the opening burst, fired ~40 ms apart. */
const BURST = 20;
const BURST_INTERVAL_MS = 40;
/** Steady-state re-probe period. */
const KEEPALIVE_MS = 2000;
/** Ring-buffer depth; at 2 s apart this is ~2 minutes of history. */
const WINDOW = 60;
/** Beyond this the clock has genuinely moved -- step instead of slewing. */
const STEP_THRESHOLD_MS = 250;
/** Maximum correction applied per update once running, ms. */
const MAX_SLEW_MS = 4;
/** A probe counts only if its round trip is close to the best one seen. */
const RTT_ACCEPT_FACTOR = 1.5;
const RTT_ACCEPT_SLACK_MS = 2;
/** Consecutive disagreeing probes needed to declare a genuine clock jump. */
const JUMP_CONFIRM = 4;

export class SyncedClock {
  private samples: ClockSample[] = [];
  private applied = 0;
  private hasApplied = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private burstLeft = 0;

  constructor(private readonly send: (t0: number) => void) {}

  /** Room-clock milliseconds, right now. */
  now(): number {
    return performance.now() + this.applied;
  }

  /** Convert a room-clock instant to local `performance.now()` domain. */
  toLocal(roomTime: number): number {
    return roomTime - this.applied;
  }

  /** Convert a local `performance.now()` stamp to the room-clock domain. */
  toRoom(localTime: number): number {
    return localTime + this.applied;
  }

  get synced(): boolean {
    return this.hasApplied && this.samples.length >= 4;
  }

  stats(): ClockStats {
    const accepted = this.accepted();
    const offsets = accepted.map((s) => s.offset);
    return {
      rtt: accepted.length ? Math.min(...accepted.map((s) => s.rtt)) : 0,
      uncertainty: offsets.length > 1 ? (Math.max(...offsets) - Math.min(...offsets)) / 2 : 0,
      samples: this.samples.length,
      synced: this.synced,
    };
  }

  /** Begin the opening burst, then settle into keepalive probing. */
  start(): void {
    this.stop();
    this.burstLeft = BURST;
    this.tick();
  }

  stop(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }

  /** Drop history after a reconnect -- the path may be completely different. */
  reset(): void {
    this.samples = [];
    this.hasApplied = false;
  }

  private tick = (): void => {
    this.send(performance.now());
    const next = this.burstLeft > 0 ? BURST_INTERVAL_MS : KEEPALIVE_MS;
    if (this.burstLeft > 0) this.burstLeft--;
    this.timer = setTimeout(this.tick, next);
  };

  /** Feed a `pong`. `t0` is our send stamp, `t1` the room clock at receipt. */
  onPong(t0: number, t1: number): void {
    const t2 = performance.now();
    const rtt = t2 - t0;
    if (rtt < 0) return;
    // Cristian: assume the two path legs are symmetric. Asymmetry is the
    // dominant error term, which is exactly why we keep only the fastest
    // probes -- a fast round trip has less room to hide asymmetry.
    const offset = t1 - (t0 + t2) / 2;
    this.samples.push({ rtt, offset });
    if (this.samples.length > WINDOW) this.samples.shift();
    this.update();
  }

  /**
   * Probes close to the fastest round trip seen. A quartile is too coarse: one
   * clean probe among nineteen slow ones would still be outvoted by slow ones
   * that happened to fall inside the quartile. A slow round trip has more room
   * to hide path asymmetry, and asymmetry is the error Cristian's algorithm
   * cannot see, so we judge each probe against the best one instead.
   */
  private accepted(): ClockSample[] {
    if (!this.samples.length) return [];
    const minRtt = Math.min(...this.samples.map((s) => s.rtt));
    const limit = minRtt * RTT_ACCEPT_FACTOR + RTT_ACCEPT_SLACK_MS;
    const kept = this.samples.filter((s) => s.rtt <= limit);
    return kept.length ? kept : [this.samples[this.samples.length - 1]];
  }

  private update(): void {
    const accepted = this.accepted();
    if (!accepted.length) return;
    const target = median(accepted.map((s) => s.offset));

    // During the opening burst we are still learning what the path looks like,
    // and a better probe can arrive at any point. Nothing is playing yet, so a
    // step costs nothing -- whereas slewing would strand us next to whichever
    // probe happened to land first, at 4 ms per update.
    if (!this.hasApplied || this.samples.length <= BURST) {
      this.applied = target;
      this.hasApplied = true;
      return;
    }

    // A phone that slept and woke resumes with a genuinely different offset.
    // The old samples are no longer describing reality, and left in the window
    // they would outvote the truth for minutes. If the last few probes all
    // disagree with us the same way, throw the history away.
    const recent = this.samples.slice(-JUMP_CONFIRM);
    if (recent.length === JUMP_CONFIRM) {
      const allAbove = recent.every((s) => s.offset - this.applied > STEP_THRESHOLD_MS);
      const allBelow = recent.every((s) => this.applied - s.offset > STEP_THRESHOLD_MS);
      if (allAbove || allBelow) {
        this.samples = recent;
        this.applied = median(recent.map((s) => s.offset));
        return;
      }
    }

    const err = target - this.applied;
    if (Math.abs(err) > STEP_THRESHOLD_MS) {
      // Something real changed (suspend/resume, network path flip). Jump, and
      // let the playback drift controller re-converge.
      this.applied = target;
      return;
    }
    // Otherwise slew. A step mid-song would move the whole timeline under the
    // drift controller's feet; a bounded slew stays inaudible.
    this.applied += clamp(err, -MAX_SLEW_MS, MAX_SLEW_MS);
  }
}

export function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

export function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}
