/**
 * ContextClockWatchdog -- notices when the audio clock has come off its rails.
 *
 * A healthy AudioContext advances `currentTime` at wall-clock rate, paced by
 * the hardware pulling samples. When the OS-level output stream dies or never
 * attaches (seen on a Samsung S24 Ultra in Chrome), Chromium keeps the context
 * "running" but freewheels it -- currentTime advancing ~21x faster than real
 * time -- while rendering silence. Every layer above then works perfectly
 * against a clock that lies: packets decode, the ring fills, telemetry looks
 * alive, and no sound ever comes out. Nothing inside the page can revive that
 * stream; the only cure is a fresh AudioContext, which needs a user gesture.
 *
 * So this watchdog does the one thing the rest of the engine cannot: it
 * compares the context clock against `performance.now()` and says, out loud,
 * "this clock is not real". The verdict gates a tap-to-fix prompt and is
 * reported in telemetry so a broken device is legible from the host's
 * dashboard instead of masquerading as a comedy cushion value.
 */

/** One rate measurement needs at least this much wall time to mean anything. */
const MIN_INTERVAL_MS = 250;
/**
 * A gap this long means the page was frozen (backgrounded tab, device sleep)
 * and the two clocks stopped under different rules -- start a fresh window
 * rather than reading a verdict from it.
 */
const MAX_INTERVAL_MS = 5000;
/**
 * Generous on purpose. Genuine contexts hold 1.0 to within crystal tolerance
 * (parts per million); the failure this hunts reads 0x or 20x. Anything a
 * device legitimately does -- jitter in timer delivery, a resumed context
 * jump-starting -- lands well inside this band over a 1 s window.
 */
const MIN_RATE = 0.9;
const MAX_RATE = 1.1;
/** Consecutive bad windows before declaring broken: one could be a glitch. */
const CONFIRM = 2;

export class ContextClockWatchdog {
  private last: { perf: number; ctx: number } | null = null;
  private bad = 0;
  private lastRate: number | null = null;
  private isBroken = false;

  constructor(
    private readonly ctxSeconds: () => number,
    private readonly perfMs: () => number = () => performance.now(),
  ) {}

  /**
   * Feed one observation; call ~1/s. `running` is whether the context CLAIMS
   * to be running -- while suspended the clock is frozen by design, so no
   * verdict can be read and the window restarts.
   */
  sample(running: boolean): void {
    if (!running) {
      this.last = null;
      return;
    }
    const perf = this.perfMs();
    const ctx = this.ctxSeconds();
    const prev = this.last;
    this.last = { perf, ctx };
    if (!prev) return;

    const dt = perf - prev.perf;
    if (dt < MIN_INTERVAL_MS) {
      // Too short to judge; keep accumulating the same window.
      this.last = prev;
      return;
    }
    if (dt > MAX_INTERVAL_MS) return;

    const rate = ((ctx - prev.ctx) * 1000) / dt;
    this.lastRate = rate;
    if (rate < MIN_RATE || rate > MAX_RATE) {
      this.bad++;
      if (this.bad >= CONFIRM) this.isBroken = true;
    } else {
      // Self-healing: if the stream comes back, the prompt goes away and the
      // engine's own dislocation detectors walk the mapping home.
      this.bad = 0;
      this.isBroken = false;
    }
  }

  /** Most recent measured rate (1.0 = wall clock), or null before the first. */
  get rate(): number | null {
    return this.lastRate;
  }

  get broken(): boolean {
    return this.isBroken;
  }

  /** Forget everything -- for a rebuilt context. */
  reset(): void {
    this.last = null;
    this.bad = 0;
    this.lastRate = null;
    this.isBroken = false;
  }
}
