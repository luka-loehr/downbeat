import type {
  ClientMessage,
  HostCommand,
  LiveState,
  Member,
  PlayMode,
  RoomState,
  ServerMessage,
  Role,
  Track,
} from "../shared/protocol";
import { MIN_LEAD_MS, MAX_LEAD_MS, PROTOCOL_VERSION } from "../shared/protocol";

interface Persisted {
  code: string;
  queue: Track[];
  current: number;
  mode: PlayMode;
  startAt: number;
  offsetInTrack: number;
  seq: number;
  live: LiveState | null;
}

/** Per-socket data. Survives hibernation via `serializeAttachment`. */
interface Attach {
  id: string;
  name: string;
  role: Role;
  rtt: number;
  sync: number;
  readyFor: string | null;
  startError: number | null;
  playoutMs: number | null;
  marginMs: number | null;
  cushionMs: number | null;
  underruns: number | null;
}

const EMPTY: Persisted = {
  code: "",
  queue: [],
  current: -1,
  mode: "idle",
  startAt: 0,
  offsetInTrack: 0,
  seq: 0,
  live: null,
};

/**
 * Telemetry and joins/leaves only need to reach the room eventually; at most
 * one full-state broadcast per this window keeps a big room's chatter linear
 * instead of quadratic. Transport changes still broadcast immediately.
 */
const STATE_COALESCE_MS = 750;

export class RoomDO implements DurableObject {
  private p: Persisted = { ...EMPTY };
  private stateTimer: ReturnType<typeof setTimeout> | null = null;
  private lastStateAt = 0;

  constructor(
    private readonly ctx: DurableObjectState,
    _env: Env,
  ) {
    this.ctx.blockConcurrencyWhile(async () => {
      const stored = await this.ctx.storage.get<Persisted>("room");
      if (stored) this.p = stored;
    });
  }

  /* ------------------------------------------------------------------ upgrade */

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("expected websocket", { status: 426 });
    }

    const code = url.searchParams.get("code") ?? "";
    if (!this.p.code && code) {
      this.p.code = code;
      await this.save();
    }

    // The Worker has already verified the host token before setting this.
    const raw = url.searchParams.get("role");
    const role: Role = raw === "host" || raw === "source" ? raw : "listener";
    const name = this.uniqueName(
      (url.searchParams.get("name") ?? "").slice(0, 24) || defaultName(role),
    );

    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];

    // Hibernation: the DO can be evicted between messages and revived on the
    // next one without dropping sockets, so an idle room costs nothing.
    //
    // The tags matter for live audio: at 50 packets a second, deserialising
    // every socket's attachment just to find out who to forward to would be
    // the most expensive thing this object does. Tagging at accept time makes
    // the relay a single indexed lookup.
    this.ctx.acceptWebSocket(server, [role, role === "source" ? "tx" : "rx"]);

    const attach: Attach = {
      id: crypto.randomUUID().slice(0, 8),
      name,
      role,
      rtt: 0,
      sync: 0,
      readyFor: null,
      startError: null,
      playoutMs: null,
      marginMs: null,
      cushionMs: null,
      underruns: null,
    };
    server.serializeAttachment(attach);

    this.send(server, {
      t: "welcome",
      you: attach.id,
      role,
      state: this.snapshot(),
      v: PROTOCOL_VERSION,
    });
    // The joiner already has the state in its welcome; the rest of the room
    // only needs the membership change eventually, even during a join wave.
    this.broadcastStateSoon();

    return new Response(null, { status: 101, webSocket: client });
  }

  /* ------------------------------------------------------------------ messages */

  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    // FIRST STATEMENT, DELIBERATELY. In Workers `Date.now()` is frozen between
    // I/O as a Spectre mitigation and only advances when I/O occurs. The socket
    // read that delivered this message IS that I/O, so the clock is fresh right
    // now. Any work done before this line would be invisible to the timestamp
    // and would silently bias every client's offset estimate.
    const t1 = Date.now();

    // Live audio: forward untouched to every listener. No parsing, no state,
    // no persistence -- this path runs 50 times a second and must stay cheap.
    if (typeof raw !== "string") {
      // Only a verified source may inject audio. The tag was assigned at
      // accept time, after the Worker checked the host token -- without this,
      // any listener could stream into the room.
      if (!this.ctx.getTags(ws).includes("tx")) return;
      for (const peer of this.ctx.getWebSockets("rx")) {
        try {
          peer.send(raw);
        } catch {
          /* dropped; close handler cleans up */
        }
      }
      return;
    }
    let msg: ClientMessage;
    try {
      msg = JSON.parse(raw) as ClientMessage;
    } catch {
      return;
    }

    // Time probes are the hot path: answer and return before touching state.
    if (msg.t === "ping") {
      this.send(ws, { t: "pong", t0: msg.t0, t1 });
      return;
    }

    const a = ws.deserializeAttachment() as Attach | null;
    if (!a) return;

    switch (msg.t) {
      case "telemetry":
        a.rtt = msg.rtt;
        a.sync = msg.sync;
        a.startError = msg.startError;
        a.playoutMs = msg.playoutMs ?? null;
        a.marginMs = msg.marginMs ?? null;
        a.cushionMs = msg.cushionMs ?? null;
        a.underruns = msg.underruns ?? null;
        ws.serializeAttachment(a);
        this.broadcastStateSoon();
        return;

      case "ready":
        if (msg.seq !== this.p.seq) return; // stale arm, ignore
        a.readyFor = msg.trackId;
        ws.serializeAttachment(a);
        this.broadcastStateSoon();
        await this.maybeArm(t1);
        return;

      case "cmd":
        if (a.role !== "host" && a.role !== "source") {
          this.send(ws, { t: "error", message: "not the host", fatal: false });
          return;
        }
        await this.command(msg.cmd, t1);
        return;

      default:
        return;
    }
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    const attach = ws.deserializeAttachment() as Attach | null;
    try {
      ws.close();
    } catch {
      /* already closed */
    }
    if (attach?.role === "source" && this.p.live) {
      // Only the LAST source socket takes the stream down. On a reconnect the
      // replacement is often connected before the dead socket's close event
      // arrives, and letting the corpse kill the live state would stop every
      // listener while a healthy source is still streaming.
      const remaining = this.ctx.getWebSockets("tx").filter((s) => s !== ws);
      if (remaining.length === 0) {
        this.p.live = null;
        await this.save();
        this.broadcast({ t: "live", live: null });
      }
    }
    this.broadcastStateSoon();
  }

  async webSocketError(): Promise<void> {
    this.broadcastStateSoon();
  }

  /** Arm timeout: start without the stragglers rather than hanging forever. */
  async alarm(): Promise<void> {
    if (this.p.mode === "arming") await this.arm(Date.now(), true);
  }

  /* ------------------------------------------------------------------ commands */

  private async command(cmd: HostCommand, now: number): Promise<void> {
    switch (cmd.c) {
      case "addTracks":
        this.p.queue = [...this.p.queue, ...cmd.tracks].slice(0, 200);
        if (this.p.current < 0 && this.p.queue.length) this.p.current = 0;
        break;

      case "removeTrack": {
        const i = this.p.queue.findIndex((t) => t.id === cmd.id);
        if (i >= 0) {
          this.p.queue.splice(i, 1);
          if (this.p.current >= this.p.queue.length) this.p.current = this.p.queue.length - 1;
        }
        break;
      }

      case "play":
        if (typeof cmd.index === "number") this.p.current = cmd.index;
        if (this.p.current < 0 || !this.p.queue[this.p.current]) return;
        this.p.offsetInTrack = cmd.offsetInTrack ?? this.p.offsetInTrack;
        await this.beginArming(now);
        return;

      case "pause":
        if (this.p.mode === "playing" || this.p.mode === "scheduled") {
          this.p.offsetInTrack = this.elapsed(now);
        }
        this.p.mode = "paused";
        this.p.seq++;
        await this.save();
        this.broadcast({ t: "pause", seq: this.p.seq });
        this.broadcastState();
        return;

      case "seek":
        this.p.offsetInTrack = Math.max(0, cmd.offsetInTrack);
        if (this.p.mode === "playing" || this.p.mode === "scheduled") {
          await this.beginArming(now);
          return;
        }
        break;

      case "next":
        if (this.p.current + 1 < this.p.queue.length) {
          this.p.current++;
          this.p.offsetInTrack = 0;
          await this.beginArming(now);
          return;
        }
        break;

      case "prev":
        if (this.p.current > 0) {
          this.p.current--;
          this.p.offsetInTrack = 0;
          await this.beginArming(now);
          return;
        }
        break;

      case "forceStart":
        if (this.p.mode === "arming") await this.arm(now, true);
        return;

      case "liveStart":
        // Live audio replaces file playback rather than fighting with it.
        this.p.mode = "idle";
        this.p.startAt = 0;
        this.p.seq++;
        this.p.live = { ...cmd.live, active: true };
        await this.save();
        this.broadcast({ t: "live", live: this.p.live });
        this.broadcastState();
        return;

      case "liveStop":
        this.p.live = null;
        await this.save();
        this.broadcast({ t: "live", live: null });
        this.broadcastState();
        return;
    }
    await this.save();
    this.broadcastState();
  }

  /* ------------------------------------------------------------------ arm barrier */

  /**
   * Phase 1 of the barrier: announce the track and let every client fetch and
   * decode it. No deadline exists yet, so nobody can start early.
   */
  private async beginArming(now: number): Promise<void> {
    this.p.mode = "arming";
    this.p.startAt = 0;
    this.p.seq++;
    for (const ws of this.ctx.getWebSockets()) {
      const a = ws.deserializeAttachment() as Attach | null;
      if (!a) continue;
      a.readyFor = null;
      a.startError = null;
      ws.serializeAttachment(a);
    }
    await this.save();
    this.broadcastState();
    await this.ctx.storage.setAlarm(now + MAX_LEAD_MS);
    await this.maybeArm(now);
  }

  /** Phase 2: once everyone has buffered, commit to an instant. */
  private async maybeArm(now: number): Promise<void> {
    if (this.p.mode !== "arming") return;
    const track = this.p.queue[this.p.current];
    if (!track) return;
    const members = this.members();
    if (!members.length) return;
    const allReady = members.every((m) => m.readyFor === track.id);
    if (allReady) await this.arm(now, false);
  }

  private async arm(now: number, forced: boolean): Promise<void> {
    const track = this.p.queue[this.p.current];
    if (!track) return;
    void forced;
    this.p.startAt = now + MIN_LEAD_MS;
    this.p.mode = "scheduled";
    await this.save();
    await this.ctx.storage.deleteAlarm();
    this.broadcast({
      t: "play",
      trackId: track.id,
      startAt: this.p.startAt,
      offsetInTrack: this.p.offsetInTrack,
      seq: this.p.seq,
    });
    this.broadcastState();
  }

  /* ------------------------------------------------------------------ helpers */

  private elapsed(now: number): number {
    if (!this.p.startAt) return this.p.offsetInTrack;
    return this.p.offsetInTrack + Math.max(0, (now - this.p.startAt) / 1000);
  }

  private members(): Member[] {
    const out: Member[] = [];
    for (const ws of this.ctx.getWebSockets()) {
      const a = ws.deserializeAttachment() as Attach | null;
      if (a) out.push({ ...a });
    }
    return out;
  }

  private snapshot(): RoomState {
    return {
      code: this.p.code,
      mode: this.p.mode,
      queue: this.p.queue,
      current: this.p.current,
      startAt: this.p.startAt,
      offsetInTrack: this.p.offsetInTrack,
      seq: this.p.seq,
      members: this.members(),
      live: this.p.live,
    };
  }

  private uniqueName(base: string): string {
    const taken = new Set(this.members().map((m) => m.name));
    if (!taken.has(base)) return base;
    for (let n = 2; n < 100; n++) {
      const candidate = `${base} ${n}`;
      if (!taken.has(candidate)) return candidate;
    }
    return base;
  }

  private async save(): Promise<void> {
    await this.ctx.storage.put("room", this.p);
  }

  private send(ws: WebSocket, msg: ServerMessage): void {
    try {
      ws.send(JSON.stringify(msg));
    } catch {
      /* socket gone; close handler will clean up */
    }
  }

  private broadcast(msg: ServerMessage): void {
    const s = JSON.stringify(msg);
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(s);
      } catch {
        /* ignore */
      }
    }
  }

  private broadcastState(): void {
    this.lastStateAt = Date.now();
    if (this.stateTimer !== null) {
      clearTimeout(this.stateTimer);
      this.stateTimer = null;
    }
    this.broadcast({ t: "state", state: this.snapshot() });
  }

  /**
   * Coalesced state broadcast, for the chatty paths: with N devices each
   * reporting telemetry every two seconds, broadcasting the full member list
   * to all N on every report is N²/2 member-entries per second -- the thing
   * that actually caps how many devices a room can hold. A timer that is
   * lost to hibernation is fine: the next report re-schedules it.
   */
  private broadcastStateSoon(): void {
    if (this.stateTimer !== null) return;
    const since = Date.now() - this.lastStateAt;
    if (since >= STATE_COALESCE_MS) {
      this.broadcastState();
      return;
    }
    this.stateTimer = setTimeout(() => {
      this.stateTimer = null;
      this.broadcastState();
    }, STATE_COALESCE_MS - since);
  }
}

/**
 * Device-derived names are not unique -- a room full of iPhones would be a room
 * full of entries called "iPhone". Number the duplicates.
 */
function defaultName(role: Role): string {
  return role === "host" ? "Host" : "Speaker";
}
