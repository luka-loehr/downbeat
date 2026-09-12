import { describe, expect, it } from "vitest";
import { DislocationGuard } from "../src/audio/dislocation";

/** Polls arrive every 250 ms; the guard only sees a boolean and a clock. */
function harness() {
  let now = 0;
  const guard = new DislocationGuard(() => now);
  return {
    guard,
    /** Feed `n` polls of the same verdict, 250 ms apart, returning the last result. */
    poll(implausible: boolean, n = 1) {
      let last: ReturnType<DislocationGuard["report"]> = "ok";
      for (let i = 0; i < n; i++) {
        now += 250;
        last = guard.report(implausible);
      }
      return last;
    },
    wait(ms: number) {
      now += ms;
    },
  };
}

describe("DislocationGuard", () => {
  it("stays quiet on a healthy ring", () => {
    const h = harness();
    expect(h.poll(false, 40)).toBe("ok");
    expect(h.guard.stuck).toBe(false);
    expect(h.guard.dislocations).toBe(0);
  });

  it("ignores a single implausible report: a poll can race a jump", () => {
    const h = harness();
    expect(h.poll(true, 2)).toBe("ok");
    expect(h.poll(false)).toBe("ok");
    expect(h.poll(true, 2)).toBe("ok");
    expect(h.guard.dislocations).toBe(0);
  });

  it("orders one re-anchor after three implausible reports in a row", () => {
    const h = harness();
    expect(h.poll(true, 2)).toBe("ok");
    expect(h.poll(true)).toBe("reanchor");
    expect(h.guard.dislocations).toBe(1);
    expect(h.guard.stuck).toBe(false);
  });

  it("does not judge the ring while it refills after a re-anchor", () => {
    const h = harness();
    h.poll(true, 3);
    // Right after a re-anchor the ring is empty and the cushion is junk;
    // 4 s of implausible polls must not count.
    expect(h.poll(true, 15)).toBe("ok");
    expect(h.guard.dislocations).toBe(1);
    // ...but once settled, a persisting fault is judged again.
    h.wait(1000);
    expect(h.poll(true, 3)).toBe("reanchor");
    expect(h.guard.dislocations).toBe(2);
  });

  it("declares the device stuck when the fault survives two re-anchors", () => {
    const h = harness();
    expect(h.poll(true, 3)).toBe("reanchor");
    h.wait(5000);
    expect(h.poll(true, 3)).toBe("reanchor");
    h.wait(5000);
    expect(h.poll(true, 3)).toBe("stuck");
    expect(h.guard.stuck).toBe(true);
    // Stuck is sticky: nothing in the page can fix it, so no more re-anchors.
    expect(h.poll(false, 10)).toBe("stuck");
    expect(h.poll(true, 10)).toBe("stuck");
    expect(h.guard.dislocations).toBe(3);
  });

  it("forgives re-anchors that are far apart in time", () => {
    const h = harness();
    expect(h.poll(true, 3)).toBe("reanchor");
    h.wait(40_000);
    expect(h.poll(true, 3)).toBe("reanchor");
    h.wait(40_000);
    expect(h.poll(true, 3)).toBe("reanchor");
    expect(h.guard.stuck).toBe(false);
  });

  it("starts over after a reset", () => {
    const h = harness();
    h.poll(true, 3);
    h.wait(5000);
    h.poll(true, 3);
    h.wait(5000);
    h.poll(true, 3);
    expect(h.guard.stuck).toBe(true);
    h.guard.reset();
    expect(h.guard.stuck).toBe(false);
    expect(h.guard.dislocations).toBe(0);
    expect(h.poll(false)).toBe("ok");
  });
});
