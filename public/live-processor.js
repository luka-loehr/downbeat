/**
 * Downbeat live playback ring — shared memory edition.
 *
 * Audio lives in a SharedArrayBuffer ring indexed by ABSOLUTE STREAM SAMPLE,
 * written by the decoder on the main thread and read directly here on the
 * realtime audio thread. Nothing crosses a message port at runtime: sync
 * targets, writer progress and stats all travel through small seqlock-guarded
 * blocks in a shared control buffer. The render path allocates nothing,
 * copies nothing, and cannot be stalled by a janky main thread — the worst a
 * frozen page can do is stop writing, which the cushion absorbs and the
 * stats expose.
 *
 * The alternative — posting each decoded packet to the worklet — put a
 * structured clone and a port hop in the signal path fifty times a second,
 * and main-thread jank rode along with every one of them.
 *
 * Control-buffer layout (mirrored in src/audio/engine.ts — keep in step):
 *   Int32  [0] sync seqlock    guards f64[0..1]: syncFrame (ctx), syncRing (stream)
 *   Int32  [1] writer seqlock  guards f64[2..3]: upTo, from (stream samples)
 *   Int32  [2] stats seqlock   guards f64[4..9]: underruns, minAhead,
 *                              errFrames, rate, resyncs, publish counter
 *   Int32  [3] jump counter    main increments; we snap once per change
 *   Int32  [4] stats ack       main increments after reading; resets minAhead
 *   Float64 block starts at byte 64.
 */

const RING_FRAMES = 1 << 19; // ~10.9 s at 48 kHz
const MASK = RING_FRAMES - 1;
const REPORT_EVERY = 4800; // ~100 ms

const TAU_SECONDS = 1.5;
const TAU_INTEGRAL_SECONDS = 8;
/**
 * 0.3 % is ~5 cents — inaudible on music, and the extra authority is the
 * point: crystal offset, receiver clock slew and the source's budget trim
 * must all fit under the ceiling SIMULTANEOUSLY, or the controller saturates,
 * ratchets to the recovery threshold and warbles.
 */
const MAX_RATE_DEVIATION = 0.003;
const RECOVERY_RATE_DEVIATION = 0.01;
const RECOVERY_THRESHOLD_S = 0.02;
const HARD_RESYNC_S = 0.5; // beyond this, steering is hopeless

const SEQ_SYNC = 0;
const SEQ_WRITE = 1;
const SEQ_STATS = 2;
const CTL_JUMP = 3;
const CTL_ACK = 4;
const F64_BASE = 64;

class LiveProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const opts = options?.processorOptions ?? {};
    this.channels = Math.max(1, opts.channels ?? 2);
    /**
     * Positions are STREAM samples throughout. If the context refused
     * 48 kHz, counting in output frames would tear the target away from the
     * data at |streamRate − sampleRate| frames per second; instead the read
     * head advances `ratio` stream samples per output frame and the
     * fractional interpolator absorbs the difference.
     */
    this.streamRate = opts.streamRate ?? sampleRate;
    this.ratio = this.streamRate / sampleRate;
    this.recoveryFrames = this.streamRate * RECOVERY_THRESHOLD_S;
    this.hardFrames = this.streamRate * HARD_RESYNC_S;

    this.ctl = new Int32Array(opts.control);
    this.f64 = new Float64Array(opts.control, F64_BASE);
    this.ring = [];
    for (let c = 0; c < this.channels; c++) {
      this.ring.push(new Float32Array(opts.audio, c * RING_FRAMES * 4, RING_FRAMES));
    }

    /** Fractional read position in stream-sample space, and its rate. */
    this.readPos = 0;
    this.rate = 1;
    this.integral = 0;
    this.started = false;
    this.resyncs = 0;
    this.underruns = 0;
    this.published = 0;
    this.sinceReport = 0;
    this.minAhead = Infinity;
    this.lastJump = 0;
    this.lastAck = 0;
    /** Last coherent reads, kept when a seqlock retry budget runs out. */
    this.syncF = 0;
    this.syncW = 0;
    this.haveSync = false;
    this.upTo = -1;
    this.from = 0;
    this.errFrames = 0;
  }

  /** Read two Float64 slots under their seqlock; false = keep the old pair. */
  readPair(seqIndex, slot, out) {
    for (let tries = 0; tries < 3; tries++) {
      const s1 = Atomics.load(this.ctl, seqIndex);
      if (s1 & 1) continue;
      const a = this.f64[slot];
      const b = this.f64[slot + 1];
      if (Atomics.load(this.ctl, seqIndex) === s1) {
        out[0] = a;
        out[1] = b;
        return s1 > 0;
      }
    }
    return false;
  }

  /** Where the read head should be at output frame `f`, in stream samples. */
  target(f) {
    return this.syncW + (f - this.syncF) * this.ratio;
  }

  /** One frame from channel `c` at a fractional ring position, Catmull-Rom. */
  sample(c, pos) {
    const base = Math.floor(pos);
    const t = pos - base;
    const ring = this.ring[c];
    const p0 = ring[(base - 1) & MASK];
    const p1 = ring[base & MASK];
    const p2 = ring[(base + 1) & MASK];
    const p3 = ring[(base + 2) & MASK];
    const a = 2 * p1;
    const b = p2 - p0;
    const d = 2 * p0 - 5 * p1 + 4 * p2 - p3;
    const e = -p0 + 3 * p1 - 3 * p2 + p3;
    return 0.5 * (a + b * t + d * t * t + e * t * t * t);
  }

  process(_inputs, outputs) {
    const out = outputs[0];
    if (!out || out.length === 0) return true;
    const frames = out[0].length;
    const base = currentFrame;

    const pair = this.scratchPair ?? (this.scratchPair = [0, 0]);
    if (this.readPair(SEQ_SYNC, 0, pair)) {
      this.syncF = pair[0];
      this.syncW = pair[1];
      this.haveSync = true;
    }
    if (this.readPair(SEQ_WRITE, 2, pair)) {
      this.upTo = pair[0];
      this.from = pair[1];
    }

    if (this.upTo < 0 || !this.haveSync) {
      for (let c = 0; c < out.length; c++) out[c].fill(0);
      this.underruns += frames;
      return true;
    }

    const jump = Atomics.load(this.ctl, CTL_JUMP);
    if (!this.started || jump !== this.lastJump) {
      this.readPos = this.target(base);
      this.rate = 1;
      this.integral = 0;
      if (this.started && jump !== this.lastJump) this.resyncs++;
      this.started = true;
      this.lastJump = jump;
    }

    // Steer, do not jump. The error is measured against the room clock's own
    // idea of position, so every device converges on the same sample — which
    // is what keeps them in step with each other, not merely gap-free.
    const err = this.readPos - this.target(base);
    this.errFrames = err;
    if (Math.abs(err) > this.hardFrames) {
      this.readPos = this.target(base);
      this.rate = 1;
      this.integral = 0;
      this.resyncs++;
    } else {
      const ceiling =
        Math.abs(err) > this.recoveryFrames
          ? RECOVERY_RATE_DEVIATION
          : MAX_RATE_DEVIATION;

      const dt = frames / sampleRate;
      // A rate deviation of e moves the head e * streamRate samples/second.
      const proportional = -err / (TAU_SECONDS * this.streamRate);
      // Anti-windup: bound the integrator to exactly the authority available.
      const integralLimit = ceiling * TAU_INTEGRAL_SECONDS * this.streamRate;
      this.integral = Math.max(
        -integralLimit,
        Math.min(integralLimit, this.integral - err * dt),
      );
      const integral = this.integral / (TAU_INTEGRAL_SECONDS * this.streamRate);

      this.rate = 1 + Math.max(-ceiling, Math.min(ceiling, proportional + integral));
    }

    let missing = 0;
    let pos = this.readPos;
    const step = this.rate * this.ratio;
    for (let i = 0; i < frames; i++) {
      // Cubic needs one sample either side of the pair it interpolates.
      const inWindow = pos - 1 >= this.from && pos + 2 < this.upTo;
      for (let c = 0; c < out.length; c++) {
        const ch = Math.min(c, this.channels - 1);
        out[c][i] = inWindow ? this.sample(ch, pos) : 0;
      }
      if (!inWindow) missing++;
      pos += step;
    }
    this.readPos = pos;
    this.underruns += missing;

    // The number that predicts crackle: the LEAST audio between the read
    // head and the freshest write. Reset whenever the main thread has
    // consumed a report, so each poll sees the worst dip of its own window.
    const ack = Atomics.load(this.ctl, CTL_ACK);
    if (ack !== this.lastAck) {
      this.lastAck = ack;
      this.minAhead = Infinity;
    }
    const nowAhead = this.upTo - this.readPos;
    if (nowAhead < this.minAhead) this.minAhead = nowAhead;

    this.sinceReport += frames;
    if (this.sinceReport >= REPORT_EVERY) {
      this.sinceReport = 0;
      this.published++;
      Atomics.add(this.ctl, SEQ_STATS, 1);
      this.f64[4] = this.underruns;
      this.f64[5] = Number.isFinite(this.minAhead) ? Math.max(0, this.minAhead) : -1;
      this.f64[6] = this.errFrames;
      this.f64[7] = this.rate;
      this.f64[8] = this.resyncs;
      this.f64[9] = this.published;
      Atomics.add(this.ctl, SEQ_STATS, 1);
    }
    return true;
  }
}

registerProcessor("downbeat-live", LiveProcessor);
