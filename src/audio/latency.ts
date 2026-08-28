/**
 * Output-latency estimation and the per-device manual offset.
 *
 * The browser's own estimate is only ever an estimate, and Safari does not
 * implement `outputLatency` at all. Anything it misses -- and on a Bluetooth
 * speaker that is 150-300 ms it cannot see -- is absorbed by `deviceOffset`,
 * a value the user sets once and we remember.
 */

const STORE_KEY = "downbeat.deviceOffset.v1";

/** Room-clock ms. Positive means "this device runs late, start it earlier". */
export type DeviceOffsetMs = number;

/**
 * Hardware output latency in seconds. Chrome and Android report it; Safari
 * returns undefined, in which case `baseLatency` (the graph's own buffering)
 * is the best we have and `deviceOffset` covers the remainder.
 */
export function outputLatency(ctx: AudioContext): number {
  const out = (ctx as AudioContext & { outputLatency?: number }).outputLatency;
  if (typeof out === "number" && Number.isFinite(out) && out > 0) return out;
  if (typeof ctx.baseLatency === "number" && Number.isFinite(ctx.baseLatency)) {
    return ctx.baseLatency;
  }
  return 0;
}

/**
 * `getOutputTimestamp()`, but only when it is telling a plausible story.
 *
 * `contextTime` names a sample that has already been rendered, so it can only
 * TRAIL `currentTime` -- by roughly the output latency -- and `performanceTime`
 * says when that sample reaches the speaker, so it must sit near now. Broken
 * Android audio stacks hand back pairs that violate both, and a clock mapping
 * seeded from one is not slightly wrong but unrecoverable: every device
 * steering by it is silently kilometres from the room. When the pair is
 * implausible, act as if the API were not implemented at all -- the
 * `currentTime` + `outputLatency` fallback is coarser but cannot lie this big.
 */
const MAX_CONTEXT_LAG_S = 2;
const MAX_CONTEXT_LEAD_S = 0.05;
const MAX_PERF_SKEW_MS = 2000;

export function plausibleOutputTimestamp(
  ctx: AudioContext,
): { contextTime: number; performanceTime: number } | null {
  const ts = ctx.getOutputTimestamp?.();
  const c = ts?.contextTime;
  const p = ts?.performanceTime;
  if (typeof c !== "number" || typeof p !== "number" || c <= 0 || p <= 0) return null;
  const behind = ctx.currentTime - c;
  if (behind < -MAX_CONTEXT_LEAD_S || behind > MAX_CONTEXT_LAG_S) return null;
  if (Math.abs(p - performance.now()) > MAX_PERF_SKEW_MS) return null;
  return { contextTime: c, performanceTime: p };
}

/**
 * A stable-enough key for "this device with this output path". Changing the
 * output route (speaker -> headphones -> Bluetooth) changes latency, so the
 * sample rate is folded in: switching route usually changes it.
 */
function profileKey(ctx: AudioContext): string {
  return `${Math.round(ctx.sampleRate)}`;
}

export function loadDeviceOffset(ctx: AudioContext): DeviceOffsetMs {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return 0;
    const map = JSON.parse(raw) as Record<string, number>;
    const v = map[profileKey(ctx)];
    return Number.isFinite(v) ? v : 0;
  } catch {
    return 0;
  }
}

export function saveDeviceOffset(ctx: AudioContext, ms: DeviceOffsetMs): void {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    const map = raw ? (JSON.parse(raw) as Record<string, number>) : {};
    map[profileKey(ctx)] = ms;
    localStorage.setItem(STORE_KEY, JSON.stringify(map));
  } catch {
    /* private mode, quota, whatever -- the offset just will not persist */
  }
}

/**
 * iOS: without this the physical mute switch silences Web Audio, which for a
 * party speaker app looks exactly like "the site is broken". Safari 16.4+.
 */
export function claimPlaybackAudioSession(): void {
  const nav = navigator as Navigator & { audioSession?: { type: string } };
  if (nav.audioSession) {
    try {
      nav.audioSession.type = "playback";
    } catch {
      /* not settable on this build */
    }
  }
}

/**
 * An AudioContext may only be created or resumed inside a user gesture on iOS
 * and Android. Call this from the join tap, never on page load.
 */
export async function unlockAudio(ctx: AudioContext): Promise<void> {
  claimPlaybackAudioSession();
  if (ctx.state === "suspended") await ctx.resume();
  // A zero-length blip forces the hardware output path to actually open, so
  // the first real scheduled start is not delayed by device wake-up.
  const buf = ctx.createBuffer(1, 1, ctx.sampleRate);
  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.connect(ctx.destination);
  src.start();
}
