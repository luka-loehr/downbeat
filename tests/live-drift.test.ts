import { describe, expect, it } from "vitest";

/**
 * The live drift controller, mirrored from public/live-processor.js.
 *
 * The worklet cannot be imported here (it needs an AudioWorkletGlobalScope), so
 * the control law is restated and exercised against a simulated clock. What is
 * being tested is the thing that actually matters over an evening: whether the
 * error stops growing, and how big the residue is.
 */
const SAMPLE_RATE = 48000;
const BLOCK = 128;
const TAU_SECONDS = 1.5;
const TAU_INTEGRAL_SECONDS = 8;
const MAX_RATE_DEVIATION = 0.002;
const RECOVERY_RATE_DEVIATION = 0.01;
const RECOVERY_THRESHOLD_FRAMES = SAMPLE_RATE * 0.02;

/** The PI law from public/live-processor.js, as a closure over its state. */
function controller() {
  let integral = 0;
  return (err: number, dt: number) => {
    const ceiling =
      Math.abs(err) > RECOVERY_THRESHOLD_FRAMES ? RECOVERY_RATE_DEVIATION : MAX_RATE_DEVIATION;
    const proportional = -err / (TAU_SECONDS * SAMPLE_RATE);
    const limit = ceiling * TAU_INTEGRAL_SECONDS * SAMPLE_RATE;
    integral = Math.max(-limit, Math.min(limit, integral - err * dt));
    const i = integral / (TAU_INTEGRAL_SECONDS * SAMPLE_RATE);
    return 1 + Math.max(-ceiling, Math.min(ceiling, proportional + i));
  };
}

/** Kept for the tests that only exercise the proportional limits. */
function steer(err: number): number {
  const ceiling =
    Math.abs(err) > RECOVERY_THRESHOLD_FRAMES ? RECOVERY_RATE_DEVIATION : MAX_RATE_DEVIATION;
  const correction = -err / (TAU_SECONDS * SAMPLE_RATE);
  return 1 + Math.max(-ceiling, Math.min(ceiling, correction));
}

/**
 * Run the loop for `seconds` with the target advancing `ppm` faster than this
 * device's frame clock, and report the worst error once settled.
 */
function simulate(ppm: number, seconds: number) {
  const blocks = Math.floor((seconds * SAMPLE_RATE) / BLOCK);
  const settleAfter = Math.floor((40 * SAMPLE_RATE) / BLOCK);
  const dt = BLOCK / SAMPLE_RATE;
  const steerPI = controller();
  let readPos = 0;
  let target = 0;
  let worst = 0;
  let last = 0;
  for (let b = 0; b < blocks; b++) {
    const err = readPos - target;
    const rate = steerPI(err, dt);
    readPos += BLOCK * rate;
    target += BLOCK * (1 + ppm);
    last = err;
    if (b > settleAfter) worst = Math.max(worst, Math.abs(err));
  }
  return { worstMs: (worst / SAMPLE_RATE) * 1000, finalMs: (last / SAMPLE_RATE) * 1000 };
}

describe("live drift controller", () => {
  /**
   * The point of the integral term. A proportional-only controller settles at
   * a residue proportional to the disturbance, and every device has a
   * different crystal, so every device settles somewhere else -- which a sharp
   * transient exposes as looseness. With the integrator the residue goes to
   * zero, not merely to "small".
   */
  it("drives a typical 50 ppm difference to essentially zero, not just small", () => {
    const { worstMs } = simulate(50e-6, 3600);
    expect(worstMs).toBeLessThan(0.02);
  });

  it("drives a bad 100 ppm crystal to essentially zero", () => {
    const { worstMs } = simulate(100e-6, 3600);
    expect(worstMs).toBeLessThan(0.05);
  });

  it("leaves devices with opposite crystals agreeing to well under a millisecond", () => {
    // What a listener standing between two speakers actually hears.
    const fast = simulate(+110e-6, 1800).finalMs;
    const slow = simulate(-90e-6, 1800).finalMs;
    expect(Math.abs(fast - slow)).toBeLessThan(0.1);
  });

  it("does not let the error grow without bound, which is the old failure", () => {
    const oneMinute = simulate(100e-6, 60).worstMs;
    const oneHour = simulate(100e-6, 3600).worstMs;
    // Uncorrected, an hour at 100 ppm is 360 ms. Bounded means the hour is no
    // worse than the minute.
    expect(oneHour).toBeLessThan(oneMinute * 1.5 + 0.1);
    expect(oneHour).toBeLessThan(5);
  });

  it("survives a crystal far outside spec", () => {
    const { worstMs } = simulate(500e-6, 3600);
    expect(worstMs).toBeLessThan(2);
  });

  /**
   * The wake-from-locked-screen case: a large error must be walked off fast
   * enough that nobody stands there listening to it, and without overshoot.
   */
  it("recovers a 100 ms dislocation quickly and without overshoot", () => {
    const seen: number[] = [];
    let readPos = 4800; // 100 ms out to begin with
    let target = 0;
    const at: Record<number, number> = {};
    for (let b = 0; b < (60 * SAMPLE_RATE) / BLOCK; b++) {
      const err = readPos - target;
      seen.push(Math.abs(err));
      const seconds = Math.floor((b * BLOCK) / SAMPLE_RATE);
      if (at[seconds] === undefined) at[seconds] = (Math.abs(err) / SAMPLE_RATE) * 1000;
      readPos += BLOCK * steer(err);
      target += BLOCK * (1 + 50e-6);
    }
    // Measured behavior: 100 ms -> ~1 ms by 20 s, sub-millisecond by 40 s.
    expect(at[10]).toBeLessThan(20);
    expect(at[20]).toBeLessThan(2);
    expect(at[40]).toBeLessThan(0.5);
    // Never grows on the way back: a controller that overshoots would ring.
    expect(Math.max(...seen.slice(1))).toBeLessThanOrEqual(seen[0]);
  });

  it("keeps steady-state corrections in the inaudible band", () => {
    // A settled 100 ppm error is ~14 frames; the correction for it must stay
    // in the small band, never the recovery one.
    const settled = 100e-6 * TAU_SECONDS * SAMPLE_RATE;
    expect(Math.abs(steer(settled) - 1)).toBeLessThanOrEqual(MAX_RATE_DEVIATION);
    expect(Math.abs(settled)).toBeLessThan(RECOVERY_THRESHOLD_FRAMES);
  });

  it("never exceeds the recovery ceiling, however large the error", () => {
    for (const err of [-1e6, -4800, 0, 4800, 1e6]) {
      const rate = steer(err);
      expect(rate).toBeGreaterThanOrEqual(1 - RECOVERY_RATE_DEVIATION);
      expect(rate).toBeLessThanOrEqual(1 + RECOVERY_RATE_DEVIATION);
    }
  });
});
