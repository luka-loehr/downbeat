import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { SyncedClock, median, clamp } from "../src/audio/clock";

/**
 * The clock is fed synthetic probes with a known ground-truth offset so we can
 * assert on the estimator's accuracy rather than on its implementation.
 */
function feed(
  clock: SyncedClock,
  trueOffset: number,
  legs: Array<{ up: number; down: number }>,
): void {
  let t = 1000;
  for (const { up, down } of legs) {
    const t0 = t;
    // Server stamps on arrival: t0 + up, expressed in the room clock.
    const t1 = t0 + up + trueOffset;
    const t2 = t0 + up + down;
    vi.spyOn(performance, "now").mockReturnValue(t2);
    clock.onPong(t0, t1);
    t += 100;
  }
}

describe("median / clamp", () => {
  it("handles odd and even lengths", () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(median([])).toBe(0);
  });
  it("clamps both directions", () => {
    expect(clamp(5, 0, 1)).toBe(1);
    expect(clamp(-5, 0, 1)).toBe(0);
    expect(clamp(0.5, 0, 1)).toBe(0.5);
  });
});

describe("SyncedClock", () => {
  let clock: SyncedClock;
  beforeEach(() => {
    clock = new SyncedClock(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it("recovers a symmetric offset exactly", () => {
    feed(clock, 5000, Array.from({ length: 20 }, () => ({ up: 20, down: 20 })));
    vi.spyOn(performance, "now").mockReturnValue(0);
    expect(clock.now()).toBeCloseTo(5000, 6);
  });

  it("rejects slow, asymmetric probes in favour of fast ones", () => {
    // Nineteen badly asymmetric slow probes (which would each bias the estimate
    // by +200 ms) and one clean fast probe. Min-RTT filtering must win.
    const legs = Array.from({ length: 19 }, () => ({ up: 400, down: 0 }));
    legs.push({ up: 15, down: 15 });
    feed(clock, 5000, legs);
    vi.spyOn(performance, "now").mockReturnValue(0);
    expect(Math.abs(clock.now() - 5000)).toBeLessThan(10);
  });

  it("reports uncertainty that reflects real spread", () => {
    feed(clock, 0, Array.from({ length: 20 }, () => ({ up: 20, down: 20 })));
    expect(clock.stats().uncertainty).toBeLessThan(1);
    expect(clock.stats().synced).toBe(true);
  });

  it("slews toward a small correction instead of jumping to it", () => {
    feed(clock, 0, Array.from({ length: 20 }, () => ({ up: 20, down: 20 })));
    vi.spyOn(performance, "now").mockReturnValue(0);
    expect(clock.now()).toBeCloseTo(0, 6);

    // A 50 ms shift -- below the step threshold, so it must be approached
    // gradually. After twenty more probes it should have moved toward the new
    // offset without ever having snapped to it.
    feed(clock, 50, Array.from({ length: 20 }, () => ({ up: 20, down: 20 })));
    vi.spyOn(performance, "now").mockReturnValue(0);
    const after = clock.now();
    expect(after).toBeGreaterThan(0);
    expect(after).toBeLessThan(50);
  });

  /**
   * The phone-locked-and-woke case. Stale samples must not outvote reality.
   */
  it("recovers quickly when the clock genuinely jumps", () => {
    feed(clock, 0, Array.from({ length: 20 }, () => ({ up: 20, down: 20 })));
    // Only four probes after the jump -- the window still holds twenty stale
    // ones, and the estimator must side with the new truth anyway.
    feed(clock, 100000, Array.from({ length: 4 }, () => ({ up: 20, down: 20 })));
    vi.spyOn(performance, "now").mockReturnValue(0);
    expect(clock.now()).toBeCloseTo(100000, 3);
  });

  it("is not synced before any probe lands", () => {
    expect(clock.synced).toBe(false);
    expect(clock.stats().samples).toBe(0);
  });
});
