/**
 * Downbeat live playback ring.
 *
 * Audio is written into a ring indexed by ABSOLUTE OUTPUT FRAME, and the
 * processor simply reads the frames belonging to the moment it is rendering.
 *
 * The alternative -- scheduling each 20 ms packet as its own source node -- puts
 * the room-to-context mapping in the path 50 times a second, and every scrap of
 * jitter in that mapping becomes a gap or an overlap between two packets. That
 * is audible as a stutter. Here the mapping is applied once per packet to decide
 * *where in the ring* audio lands, and the output itself is unconditionally
 * continuous: whatever is in the ring at the current frame is what comes out.
 */

const RING_FRAMES = 1 << 19; // ~10.9 s at 48 kHz
const MASK = RING_FRAMES - 1;
const REPORT_EVERY = 4800; // ~100 ms

/**
 * Closed-loop drift control.
 *
 * A phone's DAC crystal and the host's capture clock differ by tens of parts
 * per million. Left uncorrected that is ~3 ms per minute, ~180 ms per hour --
 * the read head walks away from where the room clock says it should be, and
 * snapping it back periodically is both audible and leaves devices tens of
 * milliseconds apart in between.
 *
 * So the read head advances at a rate, not in whole frames, and that rate is
 * steered every render quantum -- 128 frames, i.e. every 2.7 ms at 48 kHz --
 * to drive the error to zero. The correction is bounded well below audibility,
 * which is possible precisely because it never has to catch up much.
 */
/**
 * Proportional gain, as a time constant: the error is erased over ~1.5 s.
 */
const TAU_SECONDS = 1.5;
/**
 * Integral gain, and the reason transients can be tight at all.
 *
 * A proportional-only controller CANNOT drive a constant disturbance to zero
 * -- it needs a standing error to produce the very correction that cancels it.
 * A crystal offset is exactly such a disturbance, so every device settled at a
 * small but different residue, and a sharp beat exposed the difference between
 * them even while each looked converged. The integral term accumulates that
 * residue and removes it: the steady-state error goes to zero rather than to
 * "small", and the rate converges on the true crystal ratio.
 */
const TAU_INTEGRAL_SECONDS = 8;

/**
 * Two correction ceilings.
 *
 * In steady state the error is a fraction of a millisecond -- a 100 ppm crystal
 * settles around 0.3 ms -- so the correction is tiny and must stay inaudible:
 * 0.2 % is about 3.5 cents. But after a real dislocation, a phone waking from
 * a locked screen, the error can be tens of milliseconds, and at 0.2 % that
 * would take the better part of a minute to walk off. Being audibly out of
 * step for a minute is far worse than a couple of seconds of 17-cent pitch
 * bend nobody will identify, so recovery is allowed to pull harder.
 */
/**
 * 0.3 % is ~5 cents -- still inaudible on music, and the extra authority is
 * the point: the budget must cover crystal offset (±0.01 %), receiver clock
 * slew (±0.2 %) and the source's 0.1 % budget trim SIMULTANEOUSLY. The old
 * 0.2 % ceiling was exactly consumed by a 2 ms/s trim alone, so every device
 * saturated, ratcheted to the recovery threshold and warbled between the two
 * ceilings -- audible, and each device lagged by its own excess.
 */
const MAX_RATE_DEVIATION = 0.003;
const RECOVERY_RATE_DEVIATION = 0.01;
const RECOVERY_THRESHOLD_S = 0.02;
const HARD_RESYNC_S = 0.5; // beyond this, steering is hopeless

class LiveProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.channels = Math.max(1, options?.processorOptions?.channels ?? 2);
    /**
     * Everything positional -- ring indices, sync targets, thresholds -- is
     * in STREAM samples. If the context refused 48 kHz, counting positions
     * in output frames would tear the target away from the data at
     * |streamRate − sampleRate| frames per second: a hard resync every few
     * seconds plus a pitch shift, silently. The read head instead advances
     * `ratio` stream samples per output frame, which the fractional
     * interpolator handles for free.
     */
    this.streamRate = options?.processorOptions?.streamRate ?? sampleRate;
    this.ratio = this.streamRate / sampleRate;
    this.recoveryFrames = this.streamRate * RECOVERY_THRESHOLD_S;
    this.hardFrames = this.streamRate * HARD_RESYNC_S;
    this.ring = [];
    for (let c = 0; c < this.channels; c++) this.ring.push(new Float32Array(RING_FRAMES));

    /** Absolute output frame range currently holding real audio. */
    this.from = 0;
    this.upTo = -1;

    this.underruns = 0;
    this.played = 0;
    this.sinceReport = 0;

    /** Fractional read position in ring-index space, and its current rate. */
    this.readPos = 0;
    this.rate = 1;
    /** Accumulated error, in frame-seconds. See TAU_INTEGRAL_SECONDS. */
    this.integral = 0;
    this.started = false;
    this.resyncs = 0;
    /** Latest sync point from the main thread: at output frame F, play ring W. */
    this.syncF = 0;
    this.syncW = 0;
    this.haveSync = false;
    this.errFrames = 0;
    /** One-shot: snap to the target instead of steering toward it. */
    this.jump = false;
    /** Worst ring-ahead seen since the last stats report, stream frames. */
    this.minAhead = Infinity;

    this.port.onmessage = (event) => this.onMessage(event.data);
  }

  onMessage(msg) {
    if (msg.type === "reset") {
      this.from = 0;
      this.upTo = -1;
      this.underruns = 0;
      this.played = 0;
      this.started = false;
      this.haveSync = false;
      this.rate = 1;
      return;
    }
    if (msg.type === "sync") {
      // "At output frame F, the sample that must be heard is ring index W."
      this.syncF = msg.frame;
      this.syncW = msg.ring;
      this.haveSync = true;
      return;
    }
    if (msg.type === "jump") {
      // A deliberate re-lock after a dislocation (device slept, clock
      // stepped, route changed). Walking a known-correct target off at the
      // recovery ceiling would be tens of seconds of pitch bend; one clean
      // discontinuity is the lesser evil.
      this.jump = true;
      return;
    }
    if (msg.type !== "audio") return;

    const { startFrame, planes } = msg;
    const frames = planes[0].length;
    // A packet from more than a ring rotation ago must not stamp on audio
    // sitting near the read head. Unreachable through the current push path,
    // which drops far-late packets before decode -- this keeps it true.
    if (this.started && startFrame + frames < this.readPos) return;

    // A hole means packets were lost or arrived too late. Zero it rather than
    // leaving whatever the ring held a rotation ago -- stale audio at full
    // volume is far worse than a short silence.
    if (this.upTo >= 0 && startFrame > this.upTo) {
      this.zero(this.upTo, Math.min(startFrame, this.upTo + RING_FRAMES));
    }

    for (let c = 0; c < this.channels; c++) {
      const src = planes[Math.min(c, planes.length - 1)];
      const ring = this.ring[c];
      let offset = startFrame & MASK;
      let i = 0;
      let remaining = frames;
      while (remaining > 0) {
        const chunk = Math.min(remaining, RING_FRAMES - offset);
        ring.set(src.subarray(i, i + chunk), offset);
        i += chunk;
        offset = (offset + chunk) & MASK;
        remaining -= chunk;
      }
    }

    if (this.upTo < 0) this.from = startFrame;
    if (startFrame + frames > this.upTo) this.upTo = startFrame + frames;
    // Never claim more history than the ring physically holds.
    this.from = Math.max(this.from, this.upTo - RING_FRAMES);
  }

  zero(fromFrame, toFrame) {
    // This runs on the render thread, so it must be cheap even when the hole
    // is huge -- a listener whose network was gone for minutes hands us one.
    if (toFrame - fromFrame >= RING_FRAMES) {
      for (let c = 0; c < this.channels; c++) this.ring[c].fill(0);
      return;
    }
    let offset = fromFrame & MASK;
    let remaining = toFrame - fromFrame;
    while (remaining > 0) {
      const chunk = Math.min(remaining, RING_FRAMES - offset);
      for (let c = 0; c < this.channels; c++) this.ring[c].fill(0, offset, offset + chunk);
      offset = (offset + chunk) & MASK;
      remaining -= chunk;
    }
  }

  /** Where the read head should be at output frame `f`, in stream samples. */
  target(f) {
    return this.syncW + (f - this.syncF) * this.ratio;
  }

  /**
   * One frame from channel `c` at a fractional ring position, Catmull-Rom.
   *
   * Linear interpolation is a lowpass filter whose corner depends on the
   * fractional offset, so two devices sitting at different offsets round a
   * sharp transient differently -- a rimshot arrives with subtly different
   * attack on each, which the ear reads as looseness even when the timing is
   * right. A four-point cubic keeps the top octave intact for a few extra
   * multiplies per sample.
   */
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

    if (this.upTo < 0 || !this.haveSync) {
      for (let c = 0; c < out.length; c++) out[c].fill(0);
      this.underruns += frames;
      return true;
    }

    if (!this.started || this.jump) {
      this.readPos = this.target(base);
      this.rate = 1;
      this.integral = 0;
      if (this.started && this.jump) this.resyncs++;
      this.started = true;
      this.jump = false;
    }

    // Steer, do not jump. The error is measured against the room clock's own
    // idea of position, so every device converges on the same sample -- which
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
      // A rate deviation of e moves the read head e * streamRate stream
      // samples per second, so the gains are expressed in the stream domain.
      const proportional = -err / (TAU_SECONDS * this.streamRate);
      // Anti-windup: an integrator allowed to grow past what the rate limit
      // can express would keep pushing long after the error was gone, and
      // overshoot. Bound it to exactly the authority available.
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
    // The number that predicts crackle: the LEAST audio between the read
    // head and the freshest write. A mean hides the dips; the min is what
    // the source's delay budget must keep healthy.
    const nowAhead = this.upTo - this.readPos;
    if (nowAhead < this.minAhead) this.minAhead = nowAhead;

    this.underruns += missing;
    this.played += frames - missing;
    this.sinceReport += frames;
    if (this.sinceReport >= REPORT_EVERY) {
      this.sinceReport = 0;
      const ahead = this.upTo - this.readPos;
      this.port.postMessage({
        type: "stats",
        underruns: this.underruns,
        played: this.played,
        ahead: ahead > 0 ? ahead : 0,
        minAhead: Number.isFinite(this.minAhead) ? Math.max(0, this.minAhead) : null,
        errFrames: this.errFrames,
        rate: this.rate,
        resyncs: this.resyncs,
      });
      this.minAhead = Infinity;
    }
    return true;
  }
}

registerProcessor("downbeat-live", LiveProcessor);
