import type { SyncedClock } from "./clock";
import { clamp } from "./clock";
import { loadDeviceOffset, outputLatency, saveDeviceOffset } from "./latency";
import { LIVE_HEADER_BYTES } from "../shared/protocol";
import { WORKLET_VERSION } from "../shared/build";

/**
 * PlaybackEngine -- decode ahead of time, start on a shared instant, then hold
 * the line against drift.
 *
 * The whole design rests on one inversion: nothing streams at playback time.
 * The track is fully decoded into memory before a deadline is even chosen, so
 * network jitter cannot influence when a sample is heard. All that crosses the
 * wire at playback time is a number.
 */

/**
 * Beyond this, slewing would leave the device audibly out of step for too long
 * -- at the rate cap below, 40 ms would take ~13 s to erase, and two phones in
 * one room 40 ms apart sound like flanging the whole time. Past this point a
 * clean restart is the lesser evil.
 */
const HARD_RESEEK_S = 0.025;
/**
 * +/-0.4% is about 7 cents of pitch, applied as a brief ramp rather than a
 * sustained shift -- inaudible on program material, and it erases the worst
 * tolerated error in ~6 s instead of ~13 s.
 */
const MAX_RATE_DEVIATION = 0.004;
/** Proportional gain: aim to erase the error over roughly two seconds. */
const DRIFT_GAIN = 0.5;
const DRIFT_TICK_MS = 250;
/** Metronome: one click per room-clock second, accented every fourth. */
const CLICK_PERIOD_MS = 1000;
const CLICK_LOOKAHEAD_MS = 500;

export interface EngineStatus {
  state: "idle" | "loading" | "ready" | "scheduled" | "playing";
  trackId: string | null;
  /** Seconds into the track. */
  position: number;
  /** Current drift error in ms; positive means this device is running ahead. */
  driftMs: number;
  /** Playback rate currently applied by the drift controller. */
  rate: number;
  /** ms of start error we could not avoid because the deadline had passed. */
  startErrorMs: number | null;
  loadProgress: number;
}

type Listener = (s: EngineStatus) => void;

/**
 * The drift control law, isolated so it can be tested without an AudioContext.
 * `err` is seconds; positive means the device is running ahead of the room.
 * Returns the playback rate to apply, or null when the error is too large to
 * hide and the caller should hard-reseek instead.
 */
export function driftRate(err: number): number | null {
  if (Math.abs(err) > HARD_RESEEK_S) return null;
  return clamp(1 - err * DRIFT_GAIN, 1 - MAX_RATE_DEVIATION, 1 + MAX_RATE_DEVIATION);
}

export class PlaybackEngine {
  private buffers = new Map<string, AudioBuffer>();
  private source: AudioBufferSourceNode | null = null;
  private gain: GainNode;

  private trackId: string | null = null;
  private state: EngineStatus["state"] = "idle";
  private loadProgress = 0;
  private startErrorMs: number | null = null;

  /** Frozen room<->context mapping, captured when a start is scheduled. */
  private ctxRef = 0;
  private roomRef = 0;
  /** Scheduled values for the run in flight. */
  private startAt = 0;
  private offsetInTrack = 0;
  private startCtx = 0;
  /** Drift integrator. */
  private intCtx = 0;
  private intElapsed = 0;
  private rate = 1;
  private driftMs = 0;

  private ticker: ReturnType<typeof setInterval> | null = null;
  private clickTimer: ReturnType<typeof setInterval> | null = null;
  private clickScheduled = 0;
  private listeners = new Set<Listener>();

  deviceOffsetMs: number;

  constructor(
    private readonly ctx: AudioContext,
    private readonly clock: SyncedClock,
  ) {
    this.gain = ctx.createGain();
    this.gain.connect(ctx.destination);
    this.deviceOffsetMs = loadDeviceOffset(ctx);
  }

  /* ------------------------------------------------------------------ status */

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    fn(this.status());
    return () => this.listeners.delete(fn);
  }

  status(): EngineStatus {
    return {
      state: this.state,
      trackId: this.trackId,
      position: this.currentPosition(),
      driftMs: this.driftMs,
      rate: this.rate,
      startErrorMs: this.startErrorMs,
      loadProgress: this.loadProgress,
    };
  }

  private emit(): void {
    const s = this.status();
    for (const fn of this.listeners) fn(s);
  }

  setDeviceOffset(ms: number): void {
    this.deviceOffsetMs = ms;
    saveDeviceOffset(this.ctx, ms);
    // Re-derive the schedule so the change is heard immediately.
    if (this.state === "playing" || this.state === "scheduled") this.reseek();
  }

  setVolume(v: number): void {
    this.gain.gain.value = clamp(v, 0, 1);
  }

  /** Live playback shares the engine's output node, volume and device offset. */
  get output(): AudioNode {
    return this.gain;
  }

  /* ------------------------------------------------------------------ loading */

  has(trackId: string): boolean {
    return this.buffers.has(trackId);
  }

  /**
   * Fetch and decode a whole track. This is the step that buys sample-accurate
   * playback: by the time a deadline exists, the audio is already PCM in RAM.
   */
  async load(trackId: string, url: string): Promise<void> {
    if (this.buffers.has(trackId)) return;
    this.state = "loading";
    this.loadProgress = 0;
    this.trackId = trackId;
    this.emit();

    const res = await fetch(url);
    if (!res.ok) throw new Error(`fetch ${trackId}: HTTP ${res.status}`);

    const total = Number(res.headers.get("Content-Length") ?? "0");
    let bytes: Uint8Array;

    if (res.body && total > 0) {
      const reader = res.body.getReader();
      const chunks: Uint8Array[] = [];
      let got = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        got += value.byteLength;
        this.loadProgress = clamp(got / total, 0, 1);
        this.emit();
      }
      bytes = new Uint8Array(got);
      let at = 0;
      for (const c of chunks) {
        bytes.set(c, at);
        at += c.byteLength;
      }
    } else {
      bytes = new Uint8Array(await res.arrayBuffer());
      this.loadProgress = 1;
    }

    // decodeAudioData detaches the buffer, so hand it a copy we own.
    const audio = await this.ctx.decodeAudioData(bytes.buffer.slice(0) as ArrayBuffer);
    this.buffers.set(trackId, audio);
    this.loadProgress = 1;
    this.state = "ready";
    this.emit();
  }

  duration(trackId: string): number {
    return this.buffers.get(trackId)?.duration ?? 0;
  }

  /* ------------------------------------------------------------------ transport */

  /**
   * Freeze the room<->context mapping and schedule the start.
   *
   * `getOutputTimestamp()` is the good path: it pairs a context time with the
   * `performance.now()` moment that sample actually reaches the output, so it
   * already carries the hardware latency. Where it is not implemented we fall
   * back to `currentTime` plus the reported output latency.
   */
  schedule(trackId: string, startAt: number, offsetInTrack: number): void {
    const buffer = this.buffers.get(trackId);
    if (!buffer) throw new Error(`schedule: ${trackId} not loaded`);

    this.stopSource();
    this.trackId = trackId;
    this.startAt = startAt;
    this.offsetInTrack = offsetInTrack;
    this.startErrorMs = null;
    this.rate = 1;
    this.driftMs = 0;

    const map = this.captureMap();
    this.ctxRef = map.ctxRef;
    this.roomRef = map.roomRef;

    this.startCtx = this.ctxForHeard(startAt);

    const src = this.ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(this.gain);
    src.onended = () => {
      if (this.source === src) {
        this.state = "idle";
        this.stopTicker();
        this.emit();
      }
    };

    let when = this.startCtx;
    let from = offsetInTrack;
    const now = this.ctx.currentTime;
    if (when < now) {
      // The deadline already passed -- we joined late, or decoding overran.
      // Start now from the correct position and report the error honestly
      // rather than silently playing the wrong part of the song.
      this.startErrorMs = (now - when) * 1000;
      from = offsetInTrack + (now - when);
      when = now;
    }

    if (from >= buffer.duration) {
      this.state = "idle";
      this.emit();
      return;
    }

    src.start(when, from);
    this.source = src;
    this.intCtx = this.startCtx;
    this.intElapsed = 0;
    this.state = this.startCtx > now ? "scheduled" : "playing";
    this.startTicker();
    this.emit();
  }

  pause(): void {
    this.stopSource();
    this.stopTicker();
    this.state = "idle";
    this.emit();
  }

  private stopSource(): void {
    if (!this.source) return;
    try {
      this.source.onended = null;
      this.source.stop();
    } catch {
      /* never started */
    }
    this.source = null;
  }

  /* ------------------------------------------------------------------ drift */

  /**
   * Pair a context time with the room time at which that sample is HEARD.
   *
   * `getOutputTimestamp()` is the good path: it pairs a context time with the
   * `performance.now()` moment that sample actually reaches the output, so it
   * already carries the hardware latency. Where it is not implemented -- Safari
   * -- we fall back to `currentTime` plus the reported output latency.
   */
  private captureMap(): { ctxRef: number; roomRef: number } {
    const ts = this.ctx.getOutputTimestamp?.();
    const tsCtx = ts?.contextTime;
    const tsPerf = ts?.performanceTime;
    if (typeof tsCtx === "number" && typeof tsPerf === "number" && tsCtx > 0 && tsPerf > 0) {
      return { ctxRef: tsCtx, roomRef: this.clock.toRoom(tsPerf) };
    }
    return {
      ctxRef: this.ctx.currentTime,
      roomRef: this.clock.now() + outputLatency(this.ctx) * 1000,
    };
  }

  /** Context time at which a sample must sit to be HEARD at room time `r`. */
  private ctxForHeard(r: number): number {
    return this.ctxRef + (r - this.roomRef) / 1000 - this.deviceOffsetMs / 1000;
  }

  /* ------------------------------------------------------------------ metronome */

  /**
   * A click on every room-clock second boundary.
   *
   * This is the calibration instrument and the by-ear sync test in one: put two
   * phones side by side and you either hear one click or you hear two. It runs
   * through the same room->context mapping as music playback, so what you hear
   * is genuinely what the scheduler is doing.
   */
  startClick(): void {
    if (this.clickTimer !== null) return;
    this.clickScheduled = 0;
    const pump = () => {
      const map = this.captureMap();
      const horizon = this.clock.now() + CLICK_LOOKAHEAD_MS;
      let boundary = Math.ceil(this.clock.now() / CLICK_PERIOD_MS) * CLICK_PERIOD_MS;
      while (boundary < horizon) {
        if (boundary > this.clickScheduled) {
          const at =
            map.ctxRef + (boundary - map.roomRef) / 1000 - this.deviceOffsetMs / 1000;
          if (at > this.ctx.currentTime) {
            this.click(at, boundary % (CLICK_PERIOD_MS * 4) === 0);
            this.clickScheduled = boundary;
          }
        }
        boundary += CLICK_PERIOD_MS;
      }
    };
    pump();
    this.clickTimer = setInterval(pump, CLICK_LOOKAHEAD_MS / 2);
  }

  stopClick(): void {
    if (this.clickTimer !== null) clearInterval(this.clickTimer);
    this.clickTimer = null;
  }

  get clicking(): boolean {
    return this.clickTimer !== null;
  }

  /** A short shaped blip: sharp enough that two of them are obviously two. */
  private click(at: number, accent: boolean): void {
    const osc = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    osc.frequency.value = accent ? 1760 : 1174;
    osc.connect(g);
    g.connect(this.gain);
    g.gain.setValueAtTime(0.0001, at);
    g.gain.exponentialRampToValueAtTime(accent ? 0.5 : 0.28, at + 0.001);
    g.gain.exponentialRampToValueAtTime(0.0001, at + 0.045);
    osc.start(at);
    osc.stop(at + 0.06);
  }

  /** Seconds of audio elapsed at context time `c`, integrating rate changes. */
  private elapsedAt(c: number): number {
    return this.intElapsed + (c - this.intCtx) * this.rate;
  }

  private currentPosition(): number {
    if (this.state !== "playing" && this.state !== "scheduled") return this.offsetInTrack;
    return this.offsetInTrack + Math.max(0, this.elapsedAt(this.ctxForHeard(this.clock.now())));
  }

  private startTicker(): void {
    this.stopTicker();
    this.ticker = setInterval(this.tick, DRIFT_TICK_MS);
  }

  private stopTicker(): void {
    if (this.ticker !== null) clearInterval(this.ticker);
    this.ticker = null;
  }

  /**
   * Hold the line. Device crystals differ by 10-100 ppm, so two phones drift
   * apart by ~1 ms every 10-100 s: correct enough at the start, wrong by the
   * second chorus. Every constant -- output latency, device offset -- cancels
   * here, because both sides of the comparison run through the same frozen
   * mapping. What is left is genuine clock drift.
   */
  private tick = (): void => {
    if (!this.source || this.state === "idle") return;
    const room = this.clock.now();

    if (this.state === "scheduled") {
      if (room < this.startAt) return;
      this.state = "playing";
    }

    const c = this.ctxForHeard(room);
    const audioElapsed = this.elapsedAt(c);
    const roomElapsed = (room - this.startAt) / 1000;
    const err = audioElapsed - roomElapsed;
    this.driftMs = err * 1000;

    // Positive error means we are ahead of the room, so slow down slightly.
    const next = driftRate(err);
    if (next === null) {
      this.reseek();
      return;
    }
    this.intElapsed = audioElapsed;
    this.intCtx = c;
    this.rate = next;
    if (this.source) this.source.playbackRate.value = next;
    this.emit();
  };

  /**
   * Re-derive the schedule from the room clock and restart at the right sample.
   * The original anchor is reused deliberately: it is in the past, so
   * `schedule()` clamps to "now" and computes the correct in-track position
   * from the room clock, which is exactly the correction we want.
   */
  private reseek(): void {
    if (!this.trackId || !this.buffers.has(this.trackId)) return;
    this.schedule(this.trackId, this.startAt, this.offsetInTrack);
  }
}

/* ==================================================================== live */

/**
 * Live playback: a continuous stream from a Downbeat CLI instead of a file.
 *
 * Each packet arrives already carrying the instant it must be heard, computed
 * by the source from its own capture anchor. A receiver therefore never infers
 * timing from arrival, which is what makes a packet that shows up late an
 * obvious, droppable event rather than audio played at the wrong moment.
 */
export interface LiveConfig {
  sampleRate: number;
  channels: number;
  frameSize: number;
  bufferMs: number;
}

export interface LiveStats {
  decoded: number;
  /** Packets that arrived after their instant had passed. */
  late: number;
  /** How far ahead packets are arriving, ms -- the safety margin in hand. */
  marginMs: number;
  /** Output frames the ring could not fill, i.e. audible holes. */
  underruns: number;
  /** Audio sitting ahead of the play head, ms. */
  aheadMs: number;
  /** How far the fixed anchor has drifted from the room clock, ms. */
  anchorErrorMs: number;
  /** Times the anchor had to be reset -- each one is a single discontinuity. */
  reanchors: number;
  /** Playback rate the drift controller is currently applying. */
  rate: number;
  /** Packets skipped while waiting for the clock to converge. */
  waiting: number;
}

/**
 * Opus decoding, however this browser can manage it.
 *
 * WebCodecs `AudioDecoder` is the fast native path, but Firefox -- and
 * therefore Tor Browser -- does not ship it for audio, and a guest who scanned
 * a QR code should not be told their browser is unsupported. libopus compiled
 * to WebAssembly covers everyone else at ~200 KB, loaded only when needed.
 */
class OpusSource {
  private webcodec: AudioDecoder | null = null;
  private wasm: { decodeFrame(p: Uint8Array): { channelData: Float32Array[] } } | null = null;

  private constructor(
    readonly kind: "webcodecs" | "wasm",
    private readonly onDecoded: (planes: Float32Array[], sampleIndex: number) => void,
    private readonly onError: (err: unknown) => void,
  ) {}

  static async create(
    config: LiveConfig,
    onDecoded: (planes: Float32Array[], sampleIndex: number) => void,
    onError: (err: unknown) => void,
  ): Promise<OpusSource> {
    if (typeof AudioDecoder !== "undefined") {
      const source = new OpusSource("webcodecs", onDecoded, onError);
      const decoder = new AudioDecoder({
        output: (data) => {
          try {
            const planes: Float32Array[] = [];
            for (let c = 0; c < data.numberOfChannels; c++) {
              const plane = new Float32Array(data.numberOfFrames);
              data.copyTo(plane, { planeIndex: c, format: "f32-planar" });
              planes.push(plane);
            }
            onDecoded(planes, data.timestamp);
          } finally {
            data.close();
          }
        },
        error: onError,
      });
      decoder.configure({
        codec: "opus",
        sampleRate: config.sampleRate,
        numberOfChannels: config.channels,
      });
      source.webcodec = decoder;
      return source;
    }

    const { OpusDecoder } = await import("opus-decoder");
    const decoder = new OpusDecoder({ channels: config.channels });
    await decoder.ready;
    const source = new OpusSource("wasm", onDecoded, onError);
    source.wasm = decoder as unknown as { decodeFrame(p: Uint8Array): { channelData: Float32Array[] } };
    return source;
  }

  get usable(): boolean {
    if (this.webcodec) return this.webcodec.state === "configured";
    return this.wasm !== null;
  }

  decode(packet: Uint8Array, sampleIndex: number): void {
    if (this.webcodec) {
      this.webcodec.decode(
        new EncodedAudioChunk({
          type: "key", // every Opus packet stands alone
          timestamp: sampleIndex, // carried straight through to the sink
          data: packet,
        }),
      );
      return;
    }
    if (!this.wasm) return;
    try {
      // Synchronous, so a slow frame stalls the socket handler rather than
      // silently queueing -- which is the behaviour we want, since a device
      // that cannot keep up should show underruns, not unbounded latency.
      const out = this.wasm.decodeFrame(packet);
      if (out.channelData?.length) this.onDecoded(out.channelData, sampleIndex);
    } catch (err) {
      this.onError(err);
    }
  }

  close(): void {
    try {
      this.webcodec?.close();
    } catch {
      /* already closed */
    }
    this.webcodec = null;
    this.wasm = null;
  }
}

export class LivePlayer {
  private source: OpusSource | null = null;
  private node: AudioWorkletNode | null = null;
  private config: LiveConfig | null = null;
  private moduleLoaded = false;

  /**
   * The room<->context mapping collapses to one scalar: ctx = room/1000 + k.
   * It decides where in the ring a packet lands, so it is smoothed hard: a
   * jittery k would scatter contiguous packets across the ring and tear holes
   * between them.
   */
  private k = 0;
  private kInit = false;

  /**
   * Ring position of stream sample 0. Established once from the room clock and
   * then held, so packet placement is exactly contiguous.
   */
  private frameOffset = 0;
  private anchored = false;
  /** The anchor packet, so the wanted position can be derived at any instant. */
  private anchorPlayAt = 0;
  private anchorSample = 0;
  /** Steering error reported back by the worklet, ms. */
  private anchorErrorMs = 0;
  private appliedRate = 1;
  private resyncs = 0;

  private stats: LiveStats = {
    decoded: 0, late: 0, marginMs: 0, underruns: 0, aheadMs: 0,
    anchorErrorMs: 0, reanchors: 0, rate: 1, waiting: 0,
  };

  constructor(
    private readonly ctx: AudioContext,
    private readonly clock: SyncedClock,
    private readonly out: AudioNode,
    private readonly deviceOffsetMs: () => number,
  ) {}

  /** Every browser we serve can decode: native where possible, WASM otherwise. */
  static get supported(): boolean {
    return true;
  }

  get running(): boolean {
    return this.source !== null;
  }

  get liveConfig(): LiveConfig | null {
    return this.config;
  }

  /** Which decoder actually got used, for the diagnostics line. */
  get decoderKind(): string | null {
    return this.source?.kind ?? null;
  }

  getStats(): LiveStats {
    return {
      ...this.stats,
      anchorErrorMs: this.anchorErrorMs,
      rate: this.appliedRate,
      reanchors: this.resyncs,
    };
  }

  /**
   * Total room-clock-to-speaker compensation this device applies, in ms.
   *
   * This is the number that says whether two devices agree with EACH OTHER.
   * Their internal control error reads near zero on both even when they are
   * audibly apart, because each is steering towards its own belief about where
   * its speaker is. A device reporting 0 here on hardware that plainly has
   * latency is the smoking gun for that class of fault.
   */
  get playoutMs(): number {
    return outputLatency(this.ctx) * 1000 + this.anchorErrorMs;
  }

  async start(config: LiveConfig): Promise<void> {
    this.stop();
    this.config = config;
    this.stats = {
      decoded: 0, late: 0, marginMs: 0, underruns: 0, aheadMs: 0,
      anchorErrorMs: 0, reanchors: 0, rate: 1, waiting: 0,
    };
    this.kInit = false;
    this.anchored = false;
    this.resyncs = 0;

    if (!this.moduleLoaded) {
      // Fingerprinted so a cached copy from an earlier deploy can never be
      // used against newer application code.
      await this.ctx.audioWorklet.addModule(`/live-processor.js?v=${WORKLET_VERSION}`);
      this.moduleLoaded = true;
    }

    const node = new AudioWorkletNode(this.ctx, "downbeat-live", {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [config.channels],
      processorOptions: { channels: config.channels },
    });
    node.port.onmessage = (event) => {
      const data = event.data as {
        type: string;
        underruns: number;
        ahead: number;
        errFrames: number;
        rate: number;
        resyncs: number;
      };
      if (data.type !== "stats") return;
      this.stats.underruns = data.underruns;
      this.stats.aheadMs = (data.ahead / this.ctx.sampleRate) * 1000;
      this.anchorErrorMs = (data.errFrames / this.ctx.sampleRate) * 1000;
      this.appliedRate = data.rate;
      this.resyncs = data.resyncs;
    };
    node.connect(this.out);
    this.node = node;

    this.source = await OpusSource.create(
      config,
      (planes, sampleIndex) => this.render(planes, sampleIndex),
      (err) => {
        this.stats.late++;
        console.warn("[downbeat] decoder", err);
      },
    );
  }

  stop(): void {
    this.source?.close();
    this.source = null;
    if (this.node) {
      this.node.port.onmessage = null;
      this.node.disconnect();
    }
    this.node = null;
    this.config = null;
  }

  /** Feed one wire frame: play instant, sample index, then the Opus packet. */
  push(frame: ArrayBuffer): void {
    const source = this.source;
    if (!source?.usable) return;
    if (frame.byteLength <= LIVE_HEADER_BYTES) return;

    const view = new DataView(frame);
    const playAt = view.getFloat64(0, true);
    const sampleIndex = view.getFloat64(8, true);
    this.trackMapping();

    const margin = playAt - this.clock.now();
    this.stats.marginMs = this.stats.marginMs * 0.95 + margin * 0.05;
    if (margin < -200) {
      // Far past its moment. Writing it would only stamp on newer audio.
      this.stats.late++;
      return;
    }

    // Do not anchor on a clock that has not converged. The first probes land
    // over the opening second, and anchoring before then fixes the stream to a
    // position that can be hundreds of milliseconds wrong -- which only a hard
    // resync would ever recover, and which is exactly what a device joining
    // mid-song would experience. Waiting costs a moment of silence; not
    // waiting costs being audibly out of step with the room.
    if (!this.anchored && !this.clock.synced) {
      this.stats.waiting++;
      return;
    }

    // Where the room clock says this sample belongs, right now.
    const wanted = Math.round(
      (playAt / 1000 + this.k - this.deviceOffsetMs() / 1000) * this.ctx.sampleRate,
    );
    if (!this.anchored) {
      this.frameOffset = wanted - sampleIndex;
      this.anchorPlayAt = playAt;
      this.anchorSample = sampleIndex;
      this.anchored = true;
    }

    // Tell the worklet where its read head should be. It steers itself from
    // there every render quantum; nothing here ever moves audio, so the
    // placement of packets stays exactly contiguous.
    this.postSyncPoint();

    source.decode(new Uint8Array(frame, LIVE_HEADER_BYTES), sampleIndex);
  }

  /**
   * Publish "at output frame F, ring index W must be heard".
   *
   * W comes from the room clock, so every device in the room is aiming at the
   * same sample at the same instant -- which is what makes them agree with each
   * other, rather than merely each being internally smooth.
   */
  private postSyncPoint(): void {
    const node = this.node;
    if (!node || !this.anchored) return;
    const rate = this.ctx.sampleRate;
    // Read the clock ONCE. The pair below is only meaningful if both halves
    // describe the same instant; two reads can straddle a render quantum and
    // inject 2.7 ms of pure noise into the controller's target.
    const now = this.ctx.currentTime;

    // Room time at which the sample now leaving the graph will be heard.
    const heardNowMs = (now - this.k) * 1000;
    const wantedSample =
      this.anchorSample + ((heardNowMs - this.anchorPlayAt) / 1000) * rate;

    node.port.postMessage({
      type: "sync",
      frame: Math.round(now * rate),
      ring: wantedSample + this.frameOffset,
    });
  }

  /** Keep `k` tracking the real relationship between the two clocks. */
  private trackMapping(): void {
    const ts = this.ctx.getOutputTimestamp?.();
    const tsCtx = ts?.contextTime;
    const tsPerf = ts?.performanceTime;
    let sample: number;
    if (typeof tsCtx === "number" && typeof tsPerf === "number" && tsCtx > 0 && tsPerf > 0) {
      sample = tsCtx - this.clock.toRoom(tsPerf) / 1000;
    } else {
      sample = this.ctx.currentTime - (this.clock.now() + outputLatency(this.ctx) * 1000) / 1000;
    }
    if (!this.kInit) {
      this.k = sample;
      this.kInit = true;
      return;
    }
    // Deliberately sluggish. k only needs to track real clock drift, which is
    // measured in parts per million; anything faster is measurement noise being
    // written into the audio timeline.
    this.k += clamp(sample - this.k, -0.0002, 0.0002);
  }

  private render(planes: Float32Array[], sampleIndex: number): void {
    const node = this.node;
    if (!node || !planes.length) return;

    // Contiguous by construction: consecutive packets differ by exactly their
    // own length, so no rounding can open a hole between them.
    node.port.postMessage(
      { type: "audio", startFrame: sampleIndex + this.frameOffset, planes },
      planes.map((p) => p.buffer),
    );
    this.stats.decoded++;
  }
}
