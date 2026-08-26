/**
 * SourceContainer — one Durable Object per room, supervising the librespot
 * container that feeds that room.
 *
 * The raw `ctx.container` runtime API is used directly rather than the
 * `@cloudflare/containers` helper: the whole lifecycle here is three verbs
 * (start, stop, status) plus a crash supervisor, and owning those ~100 lines
 * outright beats configuring a library around them.
 *
 * The container's desired state lives in DO storage, so it survives DO
 * eviction: as long as a `desired` record exists, an exited container is
 * restarted (with backoff, via the alarm); deleting the record is the one and
 * only way a container stays down.
 */

import { DurableObject } from "cloudflare:workers";
import { json } from "./auth";

/** Env vars the Worker hands the container at start. */
export type SourceEnv = {
  ROOM_CODE: string;
  HOST_TOKEN: string;
  WORKER_URL: string;
  SPOTIFY_CLIENT_ID: string;
  DEVICE_NAME: string;
  BUFFER_MS: string;
};

interface Desired {
  env: SourceEnv;
  startedAt: number;
  restarts: number;
}

/** The health/status port the Rust binary listens on. */
const PORT = 8080;

/**
 * A room session lives 24 h; a container must not outlive the credentials it
 * was born with. And a container that keeps dying has something structurally
 * wrong (revoked session, bad secrets) — restarting it forever would only
 * turn a bug into a bill.
 */
const MAX_LIFETIME_MS = 24 * 60 * 60 * 1000;
const MAX_RESTARTS = 40;

export class SourceContainer extends DurableObject<Env> {
  private monitorArmed = false;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // Woken with the container still running (a status poll after eviction):
    // re-arm the supervisor so a later crash is still noticed.
    if (ctx.container?.running) this.armMonitor();
  }

  async fetch(request: Request): Promise<Response> {
    const { pathname } = new URL(request.url);
    const container = this.ctx.container;
    if (!container) {
      return json({ error: "containers are not enabled on this deployment" }, 503);
    }

    if (request.method === "POST" && pathname === "/start") {
      const envVars = (await request.json()) as SourceEnv;
      await this.ctx.storage.put<Desired>("desired", {
        env: envVars,
        startedAt: Date.now(),
        restarts: 0,
      });
      if (!container.running) {
        container.start({ env: { ...envVars }, enableInternet: true });
        this.armMonitor();
      }
      return json({ ok: true, running: true });
    }

    if (request.method === "POST" && pathname === "/stop") {
      await this.ctx.storage.delete("desired");
      await this.ctx.storage.deleteAlarm();
      if (container.running) await container.destroy();
      return json({ ok: true, running: false });
    }

    if (request.method === "GET" && pathname === "/status") {
      const desired = await this.ctx.storage.get<Desired>("desired");
      if (!container.running) {
        return json({ running: false, wanted: !!desired });
      }
      // The binary's health port reports the interesting part: whether the
      // Connect device is online and packets are flowing.
      try {
        const resp = await container
          .getTcpPort(PORT)
          .fetch("http://source/", { signal: AbortSignal.timeout(3000) });
        const body = (await resp.json()) as Record<string, unknown>;
        return json({ running: true, startedAt: desired?.startedAt, ...body });
      } catch {
        // Port not open yet: the image is still booting.
        return json({ running: true, warming: true, startedAt: desired?.startedAt });
      }
    }

    return json({ error: "not found" }, 404);
  }

  /** Crash restarts, spaced out so a fast-failing container cannot spin. */
  async alarm(): Promise<void> {
    const container = this.ctx.container;
    const desired = await this.ctx.storage.get<Desired>("desired");
    if (!container || !desired || container.running) return;
    if (this.expired(desired)) {
      await this.ctx.storage.delete("desired");
      return;
    }
    container.start({ env: { ...desired.env }, enableInternet: true });
    this.armMonitor();
  }

  private expired(desired: Desired): boolean {
    return (
      Date.now() - desired.startedAt > MAX_LIFETIME_MS || desired.restarts > MAX_RESTARTS
    );
  }

  private armMonitor(): void {
    const container = this.ctx.container;
    if (!container || this.monitorArmed) return;
    this.monitorArmed = true;
    container
      .monitor()
      .catch(() => {})
      .finally(() => void this.onExit());
  }

  private async onExit(): Promise<void> {
    this.monitorArmed = false;
    const desired = await this.ctx.storage.get<Desired>("desired");
    if (!desired) return; // stopped on purpose
    desired.restarts += 1;
    await this.ctx.storage.put("desired", desired);
    // 5s, 10s, 20s, ... capped at 2 min. The host token inside `desired`
    // outlives any crash (it is good for the whole session), so a restart
    // hours in still authenticates.
    const backoffMs = Math.min(5000 * 2 ** (desired.restarts - 1), 120_000);
    await this.ctx.storage.setAlarm(Date.now() + backoffMs);
  }
}
