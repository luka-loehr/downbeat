import type {
  ClientMessage,
  HostCommand,
  RoomState,
  ServerMessage,
  Role,
} from "../shared/protocol";
import { PROTOCOL_VERSION } from "../shared/protocol";
import { SyncedClock, type ClockStats } from "./clock";
import { PlaybackEngine, LivePlayer, type EngineStatus, type LiveStats } from "./engine";
import { unlockAudio } from "./latency";

export interface RoomSnapshot {
  connected: boolean;
  you: string | null;
  role: Role;
  state: RoomState | null;
  clock: ClockStats;
  engine: EngineStatus;
  live: LiveStats | null;
  error: string | null;
}

type Listener = (s: RoomSnapshot) => void;

const TELEMETRY_MS = 2000;
const RECONNECT_BASE_MS = 500;
const RECONNECT_MAX_MS = 8000;

export class RoomConnection {
  private ws: WebSocket | null = null;
  private clock: SyncedClock;
  private engine: PlaybackEngine | null = null;
  private ctx: AudioContext | null = null;
  private live: LivePlayer | null = null;

  private you: string | null = null;
  private role: Role = "listener";
  private state: RoomState | null = null;
  private error: string | null = null;
  private connected = false;
  private closedByUs = false;
  private attempt = 0;

  private telemetryTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private listeners = new Set<Listener>();
  /** Guards against sending `ready` twice for the same arm. */
  private armedSeq = -1;

  constructor(
    private readonly code: string,
    private readonly name: string,
    private readonly hostToken: string | null,
  ) {
    this.clock = new SyncedClock((t0) => this.send({ t: "ping", t0 }));
  }

  /* ------------------------------------------------------------------ lifecycle */

  /** Must be called from a user gesture: iOS will not start audio otherwise. */
  async start(): Promise<void> {
    if (!this.ctx) {
      const Ctor =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      // `interactive` asks for the smallest buffer the device will give us,
      // which keeps the browser's own latency estimate small and stable.
      //
      // 48 kHz is requested explicitly because live playback indexes its ring
      // in output frames: if the context ran at 44.1 kHz while the stream is
      // 48 kHz, every packet would land in the wrong place. Not every device
      // honours the request, so fall back rather than fail to start at all.
      try {
        this.ctx = new Ctor({ latencyHint: "interactive", sampleRate: 48000 });
      } catch {
        this.ctx = new Ctor({ latencyHint: "interactive" });
      }
      await unlockAudio(this.ctx);
      this.engine = new PlaybackEngine(this.ctx, this.clock);
      this.engine.subscribe(() => this.emit());
      this.live = new LivePlayer(
        this.ctx,
        this.clock,
        this.engine.output,
        () => this.engine?.deviceOffsetMs ?? 0,
      );
    }
    this.closedByUs = false;
    this.open();
  }

  stop(): void {
    this.closedByUs = true;
    this.clock.stop();
    this.live?.stop();
    this.engine?.pause();
    if (this.telemetryTimer !== null) clearInterval(this.telemetryTimer);
    if (this.reconnectTimer !== null) clearTimeout(this.reconnectTimer);
    this.telemetryTimer = null;
    this.reconnectTimer = null;
    this.ws?.close();
    this.ws = null;
    this.connected = false;
    this.emit();
  }

  private open(): void {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const params = new URLSearchParams({ code: this.code, name: this.name });
    if (this.hostToken) params.set("hostToken", this.hostToken);
    const ws = new WebSocket(`${proto}://${location.host}/api/ws?${params}`);
    // Live audio arrives as binary frames, not text.
    ws.binaryType = "arraybuffer";
    this.ws = ws;

    ws.onopen = () => {
      this.connected = true;
      this.attempt = 0;
      this.error = null;
      this.clock.reset();
      this.clock.start();
      this.send({
        t: "hello",
        role: this.hostToken ? "host" : "listener",
        name: this.name,
        hostToken: this.hostToken ?? undefined,
        v: PROTOCOL_VERSION,
      });
      if (this.telemetryTimer === null) {
        this.telemetryTimer = setInterval(() => this.sendTelemetry(), TELEMETRY_MS);
      }
      this.emit();
    };

    ws.onmessage = (ev) => {
      if (ev.data instanceof ArrayBuffer) {
        this.live?.push(ev.data);
        return;
      }
      if (typeof ev.data !== "string") return;
      let msg: ServerMessage;
      try {
        msg = JSON.parse(ev.data) as ServerMessage;
      } catch {
        return;
      }
      void this.handle(msg);
    };

    ws.onclose = () => {
      this.connected = false;
      this.clock.stop();
      this.emit();
      if (!this.closedByUs) this.scheduleReconnect();
    };

    ws.onerror = () => {
      this.error = "connection problem";
      this.emit();
    };
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer !== null) return;
    const delay = Math.min(RECONNECT_BASE_MS * 2 ** this.attempt, RECONNECT_MAX_MS);
    this.attempt++;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.closedByUs) this.open();
    }, delay);
  }

  /* ------------------------------------------------------------------ messages */

  private async handle(msg: ServerMessage): Promise<void> {
    switch (msg.t) {
      case "pong":
        this.clock.onPong(msg.t0, msg.t1);
        this.emit();
        return;

      case "welcome":
        this.you = msg.you;
        this.role = msg.role;
        this.state = msg.state;
        this.emit();
        await this.reconcile();
        return;

      case "state":
        this.state = msg.state;
        this.emit();
        await this.reconcile();
        return;

      case "play":
        if (!this.engine) return;
        if (!this.engine.has(msg.trackId)) {
          // Should not happen -- the barrier waits for `ready` -- but if it
          // does, load and let schedule() clamp and report the start error.
          await this.engine.load(msg.trackId, `/audio/${msg.trackId}`).catch(() => {});
        }
        if (this.engine.has(msg.trackId)) {
          this.engine.schedule(msg.trackId, msg.startAt, msg.offsetInTrack);
        }
        return;

      case "pause":
        this.engine?.pause();
        return;

      case "live":
        await this.applyLive(msg.live);
        return;

      case "error":
        this.error = msg.message;
        this.emit();
        return;
    }
  }

  /**
   * React to room state: while the room is arming, fetch and decode the track,
   * then report `ready`. Nobody gets a deadline until everyone has done this.
   */
  private async reconcile(): Promise<void> {
    const st = this.state;
    const engine = this.engine;
    if (!st || !engine) return;

    // A live stream owns the room; the file barrier does not apply.
    if (st.live?.active) {
      if (!this.live?.running) await this.applyLive(st.live);
      return;
    }
    if (this.live?.running && !st.live) this.live.stop();

    const track = st.queue[st.current];
    if (!track) return;

    if (st.mode === "arming") {
      if (this.armedSeq === st.seq) return;
      this.armedSeq = st.seq;
      try {
        await engine.load(track.id, `/audio/${track.id}`);
        this.send({ t: "ready", trackId: track.id, seq: st.seq });
      } catch (err) {
        this.error = err instanceof Error ? err.message : "could not load track";
        this.emit();
      }
    }
  }

  /** Start or stop live playback to match what the room says is happening. */
  private async applyLive(live: import("../shared/protocol").LiveState | null): Promise<void> {
    if (!this.live) return;
    if (live?.active) {
      this.engine?.pause();
      try {
        await this.live.start({
          sampleRate: live.sampleRate,
          channels: live.channels,
          frameSize: live.frameSize,
          bufferMs: live.bufferMs,
        });
      } catch (err) {
        this.error = err instanceof Error ? err.message : "Live-Wiedergabe nicht möglich";
      }
    } else {
      this.live.stop();
    }
    this.emit();
  }

  liveStats(): LiveStats | null {
    return this.live?.running ? this.live.getStats() : null;
  }

  private sendTelemetry(): void {
    const stats = this.clock.stats();
    this.send({
      t: "telemetry",
      rtt: Math.round(stats.rtt),
      sync: Math.round(stats.uncertainty * 10) / 10,
      startError: this.engine?.status().startErrorMs ?? null,
    });
  }

  private send(msg: ClientMessage): void {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify(msg));
  }

  /* ------------------------------------------------------------------ host API */

  command(cmd: HostCommand): void {
    this.send({ t: "cmd", cmd });
  }

  getEngine(): PlaybackEngine | null {
    return this.engine;
  }

  getClock(): SyncedClock {
    return this.clock;
  }

  /* ------------------------------------------------------------------ observers */

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    fn(this.snapshot());
    return () => this.listeners.delete(fn);
  }

  snapshot(): RoomSnapshot {
    return {
      connected: this.connected,
      you: this.you,
      role: this.role,
      state: this.state,
      clock: this.clock.stats(),
      engine:
        this.engine?.status() ?? {
          state: "idle",
          trackId: null,
          position: 0,
          driftMs: 0,
          rate: 1,
          startErrorMs: null,
          loadProgress: 0,
        },
      live: this.liveStats(),
      error: this.error,
    };
  }

  private emit(): void {
    const s = this.snapshot();
    for (const fn of this.listeners) fn(s);
  }
}
