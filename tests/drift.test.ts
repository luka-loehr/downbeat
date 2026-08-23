import { describe, expect, it } from "vitest";
import { driftRate } from "../src/audio/engine";
import { generateCode, isValidCode, normalizeCode } from "../src/shared/code";
import { CODE_LENGTH } from "../src/shared/protocol";

describe("driftRate", () => {
  it("slows down when ahead and speeds up when behind", () => {
    expect(driftRate(0.01)!).toBeLessThan(1);
    expect(driftRate(-0.01)!).toBeGreaterThan(1);
    expect(driftRate(0)!).toBe(1);
  });

  it("never exceeds an inaudible +/-0.4%", () => {
    for (const err of [-0.024, -0.01, 0.01, 0.024]) {
      const r = driftRate(err)!;
      expect(r).toBeGreaterThanOrEqual(1 - 0.004);
      expect(r).toBeLessThanOrEqual(1 + 0.004);
    }
  });

  it("gives up and asks for a reseek beyond 25 ms", () => {
    expect(driftRate(0.026)).toBeNull();
    expect(driftRate(-0.026)).toBeNull();
  });

  /**
   * The real question: does the control law actually converge? Simulate a
   * device whose audio clock runs 100 ppm fast -- the worst end of consumer
   * crystal tolerance -- and check the error is driven to near zero and stays.
   */
  it("converges a 100 ppm crystal error to under a millisecond", () => {
    const PPM = 100e-6;
    const TICK = 0.25;
    let err = 0;
    let worstAfterSettle = 0;
    for (let i = 0; i < 400; i++) {
      const rate = driftRate(err);
      expect(rate).not.toBeNull();
      // Audio advances at `rate`, the room advances at 1, and the device's own
      // crystal adds its error on top.
      err += (rate! * (1 + PPM) - 1) * TICK;
      if (i > 60) worstAfterSettle = Math.max(worstAfterSettle, Math.abs(err));
    }
    expect(worstAfterSettle).toBeLessThan(0.001);
  });

  /**
   * The worst error the controller is willing to hide is 25 ms. It must erase
   * it fast enough that nobody stands in the room listening to a flam.
   */
  it("pulls the worst tolerated error back under 5 ms within eight seconds", () => {
    let err = 0.025;
    for (let i = 0; i < 32; i++) err += (driftRate(err)! - 1) * 0.25;
    expect(Math.abs(err)).toBeLessThan(0.005);
  });
});

describe("room codes", () => {
  it("generates valid codes of the right length", () => {
    for (let i = 0; i < 200; i++) {
      const c = generateCode();
      expect(c).toHaveLength(CODE_LENGTH);
      expect(isValidCode(c)).toBe(true);
    }
  });

  it("excludes glyphs that are misread aloud", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 500; i++) for (const ch of generateCode()) seen.add(ch);
    for (const bad of ["I", "L", "O", "U"]) expect(seen.has(bad)).toBe(false);
  });

  it("rejects malformed codes", () => {
    expect(isValidCode("abc")).toBe(false);
    expect(isValidCode("ABCDEFG")).toBe(false);
    expect(isValidCode("ABCDEI")).toBe(false);
    expect(isValidCode("")).toBe(false);
  });
});

describe("code normalisation", () => {
  it("accepts the glyphs people substitute when reading aloud", () => {
    // The alphabet drops I, L, O and U because they are confusable; that only
    // helps if someone who types the confusable one still gets in.
    expect(normalizeCode("mono01")).toBe("M0N001");
    expect(normalizeCode("hello1")).toBe("HE11 01".replace(" ", ""));
    expect(normalizeCode(" party7 ")).toBe("PARTY7");
    expect(normalizeCode("ab-cd12")).toBe("ABCD12");
  });

  it("produces valid codes from confusable input", () => {
    expect(isValidCode(normalizeCode("MONO01"))).toBe(true);
    expect(isValidCode(normalizeCode("SUNSET"))).toBe(false); // U has no mapping
  });
});
