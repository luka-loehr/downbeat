import { describe, expect, it } from "vitest";
import { ContextClockWatchdog } from "../src/audio/watchdog";
import { plausibleOutputTimestamp } from "../src/audio/latency";

/**
 * Drives the watchdog with a synthetic pair of clocks: wall time in ms and a
 * context clock advancing at `rate` seconds per wall second. This is the
 * whole point of the injectable constructor -- the S24 failure is a clock
 * relationship, and a clock relationship needs no AudioContext to test.
 */
function harness(rate: number) {
  let perf = 0;
  let ctx = 0;
  const dog = new ContextClockWatchdog(
    () => ctx,
    () => perf,
  );
  return {
    dog,
    advance(ms: number, running = true, r = rate) {
      perf += ms;
      ctx += (ms / 1000) * r;
      dog.sample(running);
    },
    setRate(r: number) {
      rate = r;
    },
  };
}

describe("ContextClockWatchdog", () => {
  it("calls a healthy 1x clock healthy", () => {
    const h = harness(1);
    h.advance(0);
    for (let i = 0; i < 10; i++) h.advance(1000);
    expect(h.dog.broken).toBe(false);
    expect(h.dog.rate).toBeCloseTo(1, 3);
  });

  it("tolerates crystal-grade deviation and timer jitter", () => {
    const h = harness(1.0005); // 500 ppm, far worse than any real crystal
    h.advance(0);
    h.advance(970);
    h.advance(1130);
    h.advance(1002);
    expect(h.dog.broken).toBe(false);
  });

  it("declares the S24 failure: context freewheeling at ~21x", () => {
    const h = harness(21);
    h.advance(0);
    h.advance(1000);
    expect(h.dog.broken).toBe(false); // one bad window could be a glitch
    h.advance(1000);
    expect(h.dog.broken).toBe(true);
    expect(h.dog.rate).toBeCloseTo(21, 1);
  });

  it("declares a frozen clock that still claims to be running", () => {
    const h = harness(0);
    h.advance(0);
    h.advance(1000);
    h.advance(1000);
    expect(h.dog.broken).toBe(true);
    expect(h.dog.rate).toBe(0);
  });

  it("reads no verdict from a suspended context", () => {
    const h = harness(0);
    h.advance(0, false);
    h.advance(1000, false);
    h.advance(1000, false);
    expect(h.dog.broken).toBe(false);
    expect(h.dog.rate).toBeNull();
  });

  it("restarts the window after a suspension instead of judging across it", () => {
    const h = harness(1);
    h.advance(0);
    h.advance(1000);
    // Suspended for a while: context frozen, wall clock running.
    h.advance(3000, false, 0);
    // Resumed: healthy from here on. The first post-resume window must not
    // blend the frozen stretch into its rate.
    h.advance(1000);
    h.advance(1000);
    h.advance(1000);
    expect(h.dog.broken).toBe(false);
    expect(h.dog.rate).toBeCloseTo(1, 3);
  });

  it("reads no verdict across a frozen-tab gap", () => {
    const h = harness(1);
    h.advance(0);
    // The page slept: timers stopped, so the next sample arrives minutes
    // late with the context clock having advanced by who-knows-what.
    h.advance(120_000, true, 0.1);
    expect(h.dog.broken).toBe(false);
    // And the window after the gap judges only itself.
    h.advance(1000);
    expect(h.dog.broken).toBe(false);
    expect(h.dog.rate).toBeCloseTo(1, 3);
  });

  it("accumulates sub-window samples instead of judging noise", () => {
    const h = harness(1);
    h.advance(0);
    // 100 ms apart: individually too short to judge, together a full window.
    for (let i = 0; i < 10; i++) h.advance(100);
    expect(h.dog.rate).toBeCloseTo(1, 3);
  });

  it("self-heals when the stream comes back", () => {
    const h = harness(21);
    h.advance(0);
    h.advance(1000);
    h.advance(1000);
    expect(h.dog.broken).toBe(true);
    h.setRate(1);
    h.advance(1000);
    expect(h.dog.broken).toBe(false);
  });

  it("forgets everything on reset", () => {
    const h = harness(21);
    h.advance(0);
    h.advance(1000);
    h.advance(1000);
    h.dog.reset();
    expect(h.dog.broken).toBe(false);
    expect(h.dog.rate).toBeNull();
  });
});

describe("plausibleOutputTimestamp", () => {
  /** The gate only reads these three things off the context. */
  function fake(currentTime: number, ts?: { contextTime: number; performanceTime: number }) {
    return {
      currentTime,
      getOutputTimestamp: ts ? () => ts : undefined,
    } as unknown as AudioContext;
  }

  it("accepts a pair that trails currentTime by an output latency", () => {
    const now = performance.now();
    const ts = { contextTime: 9.95, performanceTime: now + 40 };
    expect(plausibleOutputTimestamp(fake(10, ts))).toEqual(ts);
  });

  it("rejects a missing or unimplemented API", () => {
    expect(plausibleOutputTimestamp(fake(10))).toBeNull();
  });

  it("rejects the zero pair some browsers return before output starts", () => {
    expect(
      plausibleOutputTimestamp(fake(10, { contextTime: 0, performanceTime: 0 })),
    ).toBeNull();
  });

  it("rejects a contextTime leading currentTime -- an unrendered sample", () => {
    expect(
      plausibleOutputTimestamp(
        fake(10, { contextTime: 12, performanceTime: performance.now() }),
      ),
    ).toBeNull();
  });

  it("rejects a contextTime lagging by more than any real output path", () => {
    expect(
      plausibleOutputTimestamp(
        fake(300, { contextTime: 10, performanceTime: performance.now() }),
      ),
    ).toBeNull();
  });

  it("rejects a performanceTime nowhere near now -- a foreign timebase", () => {
    expect(
      plausibleOutputTimestamp(
        fake(10, { contextTime: 9.9, performanceTime: performance.now() + 60_000 }),
      ),
    ).toBeNull();
  });
});
