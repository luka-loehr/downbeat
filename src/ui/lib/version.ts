/**
 * Keep a long-lived tab from running against a deployment that has moved on.
 *
 * A page left open across a deploy keeps its old JavaScript forever. For an
 * audio engine that means a device playing by different rules than everyone
 * else, and -- because its own clock telemetry still looks healthy -- with no
 * visible sign that anything is wrong. It took a hard refresh to clear, which
 * is not something a guest at a party will ever think to do.
 *
 * So the page checks, and reloads itself. Only while nothing is playing: a
 * reload mid-song would be a far more obvious fault than the one being fixed.
 */
import { BUILD_ID } from "../../shared/build";

const CHECK_INTERVAL_MS = 60_000;

export function watchForNewBuild(isBusy: () => boolean): () => void {
  let stopped = false;

  const check = async () => {
    if (stopped || isBusy()) return;
    try {
      const res = await fetch("/api/health", { cache: "no-store" });
      if (!res.ok) return;
      const data = (await res.json()) as { build?: string };
      if (data.build && data.build !== BUILD_ID) {
        location.reload();
      }
    } catch {
      /* offline or blocked; try again next tick */
    }
  };

  const timer = setInterval(check, CHECK_INTERVAL_MS);
  // Coming back to a backgrounded tab is the most likely moment to be stale.
  const onVisible = () => {
    if (document.visibilityState === "visible") void check();
  };
  document.addEventListener("visibilitychange", onVisible);
  void check();

  return () => {
    stopped = true;
    clearInterval(timer);
    document.removeEventListener("visibilitychange", onVisible);
  };
}
