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
const REPORT_EVERY = 24000; // ~0.5 s

class LiveProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.channels = Math.max(1, options?.processorOptions?.channels ?? 2);
    this.ring = [];
    for (let c = 0; c < this.channels; c++) this.ring.push(new Float32Array(RING_FRAMES));

    /** Absolute output frame range currently holding real audio. */
    this.from = 0;
    this.upTo = -1;

    this.underruns = 0;
    this.played = 0;
    this.sinceReport = 0;

    this.port.onmessage = (event) => this.onMessage(event.data);
  }

  onMessage(msg) {
    if (msg.type === "reset") {
      this.from = 0;
      this.upTo = -1;
      this.underruns = 0;
      this.played = 0;
      return;
    }
    if (msg.type !== "audio") return;

    const { startFrame, planes } = msg;
    const frames = planes[0].length;

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
    for (let c = 0; c < this.channels; c++) {
      const ring = this.ring[c];
      for (let f = fromFrame; f < toFrame; f++) ring[f & MASK] = 0;
    }
  }

  process(_inputs, outputs) {
    const out = outputs[0];
    if (!out || out.length === 0) return true;
    const frames = out[0].length;
    const base = currentFrame;

    let missing = 0;
    for (let c = 0; c < out.length; c++) {
      const dst = out[c];
      const ring = this.ring[Math.min(c, this.channels - 1)];
      for (let i = 0; i < frames; i++) {
        const f = base + i;
        if (f >= this.from && f < this.upTo) {
          dst[i] = ring[f & MASK];
        } else {
          dst[i] = 0;
          if (c === 0) missing++;
        }
      }
    }

    this.underruns += missing;
    this.played += frames - missing;
    this.sinceReport += frames;
    if (this.sinceReport >= REPORT_EVERY) {
      this.sinceReport = 0;
      // How much audio is sitting ahead of the play head, in frames.
      const ahead = this.upTo > base ? this.upTo - base : 0;
      this.port.postMessage({
        type: "stats",
        underruns: this.underruns,
        played: this.played,
        ahead,
      });
    }
    return true;
  }
}

registerProcessor("downbeat-live", LiveProcessor);
