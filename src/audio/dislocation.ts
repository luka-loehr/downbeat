/**
 * DislocationGuard -- what to do when the live ring reports the impossible.
 *
 * The worklet's cushion is "audio between the read head and the freshest
 * write". The ring holds ~11 s, so a cushion of a minute is not a large
 * buffer, it is a read head that has lost the stream entirely: the device is
 * rendering silence while every other number it reports looks alive. Its
 * mirror image is every packet arriving "late" for seconds on end -- the
 * device believes the room is a minute ahead of where the packets say it is.
 * Both mean the mapping between this device's clocks and the stream is wrong
 * by far more than the steering loops can ever walk off, and the context
 * clock's RATE is fine, so the freewheel watchdog never fires.
 *
 * First response: re-anchor. Drop the clock mapping and the anchor, let the
 * next packet establish both fresh. Cheap, silent for a moment, and it fixes
 * the case where a single bad measurement seeded the mapping. If the fault
 * comes straight back, the measurement itself is lying on this device, and
 * nothing inside the page can fix that: declare the device stuck so the UI
 * offers the tap that rebuilds the audio stack from scratch.
 */

export type DislocationVerdict = "ok" | "reanchor" | "stuck";

/** Consecutive implausible reports before acting: one could be a poll racing a jump. */
const CONFIRM = 3;
/** After a re-anchor the ring is empty by design; do not judge it while it refills. */
const SETTLE_MS = 4000;
/** Re-anchors tolerated inside WINDOW_MS before the device is declared stuck. */
const MAX_REANCHORS = 2;
const WINDOW_MS = 30_000;

export class DislocationGuard {
  private bad = 0;
  private recent: number[] = [];
  private settleUntil = 0;
  private isStuck = false;
  private total = 0;

  constructor(private readonly nowMs: () => number = () => performance.now()) {}

  /**
   * Feed one observation, ~4/s. `implausible` is "the ring claims something
   * no working ring can": more audio ahead than it holds, or a long unbroken
   * run of late packets.
   */
  report(implausible: boolean): DislocationVerdict {
    if (this.isStuck) return "stuck";
    const now = this.nowMs();
    if (now < this.settleUntil) return "ok";
    if (!implausible) {
      this.bad = 0;
      return "ok";
    }
    if (++this.bad < CONFIRM) return "ok";
    this.bad = 0;
    this.total++;
    this.settleUntil = now + SETTLE_MS;
    this.recent = this.recent.filter((t) => now - t < WINDOW_MS);
    this.recent.push(now);
    if (this.recent.length > MAX_REANCHORS) {
      this.isStuck = true;
      return "stuck";
    }
    return "reanchor";
  }

  /** The page has given up steering: only a rebuilt audio stack can help. */
  get stuck(): boolean {
    return this.isStuck;
  }

  /** Re-anchors ordered so far, including the one that led to `stuck`. */
  get dislocations(): number {
    return this.total;
  }

  /** Forget everything -- for a rebuilt audio stack. */
  reset(): void {
    this.bad = 0;
    this.recent = [];
    this.settleUntil = 0;
    this.isStuck = false;
    this.total = 0;
  }
}
