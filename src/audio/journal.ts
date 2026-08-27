/**
 * The device's own flight recorder.
 *
 * Every client keeps a local journal of the events that decide whether audio
 * is clean — context interruptions, reconnects, re-anchors, underruns — and
 * streams it up the room websocket in small batches. The RoomDO writes each
 * entry into the deployment's quality journal, so the operator's logs show
 * not just THAT a device stuttered but what that device saw around the
 * moment: the app backgrounded, the audio context suspended, the network
 * flapped. Phones cannot be shelled into at a party; this is the shell.
 *
 * Deliberately tiny and lossy: a bounded buffer, batched sends, and if the
 * socket is down events wait — or fall off the front. Telemetry numbers ride
 * the existing `telemetry` message; this journal is for EVENTS.
 */

export interface JournalEvent {
  e: string;
  at: number;
  [k: string]: unknown;
}

const MAX_BUFFERED = 60;
const BATCH_AT = 20;
const FLUSH_MS = 3000;

type Sink = (events: JournalEvent[]) => boolean;

class Journal {
  private buf: JournalEvent[] = [];
  private sink: Sink | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;

  log(e: string, fields?: Record<string, unknown>): void {
    this.buf.push({ e, at: Date.now(), ...fields });
    if (this.buf.length > MAX_BUFFERED) this.buf.splice(0, this.buf.length - MAX_BUFFERED);
    if (this.buf.length >= BATCH_AT) this.flush();
  }

  /** The room connection owns the pipe; it re-registers on every reconnect. */
  setSink(sink: Sink | null): void {
    this.sink = sink;
    if (sink) {
      this.flush();
      if (this.timer === null) {
        this.timer = setInterval(() => this.flush(), FLUSH_MS);
      }
    } else if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private flush(): void {
    if (!this.sink || this.buf.length === 0) return;
    if (this.sink(this.buf)) this.buf = [];
  }
}

export const journal = new Journal();

// Ambient signals every device should report regardless of what the app is
// doing: backgrounding is the #1 cause of a phone going quiet, and network
// flaps explain most of the rest.
if (typeof document !== "undefined") {
  document.addEventListener("visibilitychange", () => {
    journal.log("visibility", { state: document.visibilityState });
  });
  addEventListener("online", () => journal.log("net-online"));
  addEventListener("offline", () => journal.log("net-offline"));
  addEventListener("pagehide", () => journal.log("pagehide"));
}
