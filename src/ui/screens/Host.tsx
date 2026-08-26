import { useCallback, useEffect, useMemo, useState } from "react";
import type { Member } from "../../shared/protocol";
import { QR } from "../components/QR";
import { useObserver } from "../lib/useObserver";

/**
 * The host console — where the night is run from.
 *
 * One column, four acts, in the order a night actually unfolds: unlock,
 * connect Spotify, open the room, start the source. Everything after that is
 * glanceable state — who is in the room and how tightly they agree — because
 * during the party this page is a wall display, not a control surface.
 */

interface SpotifyState {
  connected: boolean;
  /** False while the deployment's Spotify secrets are not set yet. */
  configured?: boolean;
  displayName?: string | null;
  product?: string | null;
}

interface SourceState {
  running: boolean;
  wanted?: boolean;
  warming?: boolean;
  spotify?: string;
  room?: string;
  packets?: number;
  uptimeSec?: number;
}

interface HostRoom {
  code: string;
  hostToken: string;
}

const PASS_KEY = "downbeat.pass";
const ROOM_KEY = "downbeat.hostroom";

async function api<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(data.error ?? `request failed (${res.status})`);
  return data;
}

/** What the Spotify OAuth callback appended to the URL, consumed once. */
function takeCallbackNote(): string | null {
  const flag = new URLSearchParams(location.search).get("spotify");
  if (!flag) return null;
  history.replaceState(null, "", "/host");
  const notes: Record<string, string> = {
    connected: "Spotify connected.",
    free: "Connected — but this account is not Premium, and Spotify Connect needs Premium to play.",
    denied: "Spotify said no — the login was cancelled.",
    expired: "That login attempt expired. Try again.",
    scope: "Spotify granted no streaming permission. Check the app settings and reconnect.",
    error: "Spotify login failed. Try again.",
  };
  return notes[flag] ?? null;
}

export function Host() {
  const [pass, setPass] = useState<string | null>(() => sessionStorage.getItem(PASS_KEY));
  const [note, setNote] = useState<string | null>(takeCallbackNote);

  if (!pass) return <Gate onUnlocked={setPass} />;
  return <Console pass={pass} note={note} clearNote={() => setNote(null)} />;
}

/* --------------------------------------------------------------------- gate */

function Gate({ onUnlocked }: { onUnlocked: (pass: string) => void }) {
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function unlock(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      // Any passphrase-gated endpoint doubles as the verifier.
      await api("/api/spotify/status", { passphrase: value });
      sessionStorage.setItem(PASS_KEY, value);
      onUnlocked(value);
    } catch (err) {
      setError(err instanceof Error ? err.message : "could not unlock");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="mx-auto flex min-h-full w-full max-w-md flex-col justify-center px-6 py-14">
      <header className="rise">
        <h1 className="wordmark text-4xl text-ink">HOST</h1>
        <p className="score mt-3 text-xl text-pulse">your night, your key</p>
      </header>
      <div className="staff my-8 rise" style={{ animationDelay: "120ms" }} />
      <form onSubmit={unlock} className="rise" style={{ animationDelay: "200ms" }}>
        <label className="mb-3 block text-[11px] uppercase tracking-[0.32em] text-muted">
          Operator passphrase
        </label>
        <input
          value={value}
          onChange={(e) => setValue(e.target.value)}
          type="password"
          autoFocus
          placeholder="•••••••••"
          className="w-full rounded-xl border border-line bg-panel px-5 py-4 text-lg text-ink outline-none transition-colors placeholder:text-dim focus:border-pulse"
        />
        <button
          type="submit"
          disabled={busy || !value}
          className="mt-4 w-full rounded-xl bg-pulse px-6 py-4 text-sm font-bold uppercase tracking-[0.2em] text-void transition-opacity disabled:opacity-25"
        >
          {busy ? "Checking…" : "Unlock the console"}
        </button>
        {error && (
          <p className="mt-5 rounded-lg border border-pulse/40 bg-pulse/10 px-4 py-3 text-sm text-pulse">
            {error}
          </p>
        )}
      </form>
      <a
        href="/"
        className="mt-8 text-center text-[11px] uppercase tracking-[0.28em] text-dim transition-colors hover:text-muted"
      >
        Back to the door
      </a>
    </main>
  );
}

/* ------------------------------------------------------------------ console */

function Console({
  pass,
  note,
  clearNote,
}: {
  pass: string;
  note: string | null;
  clearNote: () => void;
}) {
  const [spotify, setSpotify] = useState<SpotifyState | null>(null);
  const [room, setRoom] = useState<HostRoom | null>(() => {
    try {
      return JSON.parse(sessionStorage.getItem(ROOM_KEY) ?? "null") as HostRoom | null;
    } catch {
      return null;
    }
  });
  const [source, setSource] = useState<SourceState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { state, you, connected } = useObserver(room?.code ?? null, room?.hostToken ?? null);

  const fail = (err: unknown) =>
    setError(err instanceof Error ? err.message : "something went wrong");

  /* -- spotify ------------------------------------------------------------ */

  const refreshSpotify = useCallback(async () => {
    try {
      setSpotify(await api<SpotifyState>("/api/spotify/status", { passphrase: pass }));
    } catch (err) {
      fail(err);
    }
  }, [pass]);

  useEffect(() => void refreshSpotify(), [refreshSpotify]);

  async function connectSpotify() {
    try {
      const { url } = await api<{ url: string }>("/api/spotify/login", { passphrase: pass });
      location.href = url;
    } catch (err) {
      fail(err);
    }
  }

  async function disconnectSpotify() {
    try {
      await api("/api/spotify/logout", { passphrase: pass });
      await refreshSpotify();
    } catch (err) {
      fail(err);
    }
  }

  /* -- room --------------------------------------------------------------- */

  async function openRoom(takeover = false) {
    setError(null);
    try {
      const data = await api<{ code: string; hostToken: string; error?: string }>("/api/rooms", {
        passphrase: pass,
        takeover,
      });
      const next = { code: data.code, hostToken: data.hostToken };
      sessionStorage.setItem(ROOM_KEY, JSON.stringify(next));
      sessionStorage.setItem(`downbeat.host.${data.code}`, data.hostToken);
      setRoom(next);
      setSource(null);
    } catch (err) {
      fail(err);
    }
  }

  async function endRoom() {
    if (!room) return;
    try {
      await api("/api/rooms/end", { code: room.code, hostToken: room.hostToken });
    } catch {
      /* already gone is fine */
    }
    sessionStorage.removeItem(ROOM_KEY);
    setRoom(null);
    setSource(null);
  }

  /* -- source ------------------------------------------------------------- */

  const pollSource = useCallback(async () => {
    if (!room) return;
    try {
      const res = await fetch(
        `/api/source/status?code=${room.code}&hostToken=${encodeURIComponent(room.hostToken)}`,
      );
      if (res.ok) setSource((await res.json()) as SourceState);
    } catch {
      /* transient; next poll wins */
    }
  }, [room]);

  useEffect(() => {
    if (!room) return;
    void pollSource();
    const t = setInterval(() => void pollSource(), 4000);
    return () => clearInterval(t);
  }, [room, pollSource]);

  async function startSource() {
    if (!room) return;
    setError(null);
    try {
      await api("/api/source/start", { code: room.code, hostToken: room.hostToken });
      await pollSource();
    } catch (err) {
      fail(err);
    }
  }

  async function stopSource() {
    if (!room) return;
    try {
      await api("/api/source/stop", { code: room.code, hostToken: room.hostToken });
      await pollSource();
    } catch (err) {
      fail(err);
    }
  }

  /* -- derived ------------------------------------------------------------ */

  const members = useMemo(
    () => (state?.members ?? []).filter((m) => m.id !== you),
    [state, you],
  );
  const spread = useMemo(() => {
    const p = members.map((m) => m.playoutMs).filter((v): v is number => v != null);
    return p.length >= 2 ? Math.max(...p) - Math.min(...p) : null;
  }, [members]);

  const joinUrl = room ? `${location.origin}/r/${room.code}` : null;

  return (
    <main className="mx-auto w-full max-w-2xl px-5 pb-16 pt-8">
      <header className="flex items-center justify-between rise">
        <div>
          <h1 className="wordmark text-2xl text-ink">DOWNBEAT</h1>
          <p className="score mt-1 text-lg text-pulse">host console</p>
        </div>
        <div className="flex items-center gap-2.5">
          <span
            className={`h-1.5 w-1.5 rounded-full ${room ? (connected ? "bg-lock" : "breathe bg-warn") : "bg-dim"}`}
          />
          <span className="num text-[11px] tracking-[0.16em] text-muted">
            {room ? room.code : "NO ROOM"}
          </span>
        </div>
      </header>

      {note && (
        <button
          onClick={clearNote}
          className="mt-6 w-full rounded-lg border border-lock/40 bg-lock/10 px-4 py-3 text-left text-sm text-lock"
        >
          {note}
        </button>
      )}
      {error && (
        <button
          onClick={() => setError(null)}
          className="mt-6 w-full rounded-lg border border-pulse/40 bg-pulse/10 px-4 py-3 text-left text-sm text-pulse"
        >
          {error}
        </button>
      )}

      {/* -- 1 · Spotify ---------------------------------------------------- */}
      <Section n="1" title="Spotify" delay={80}>
        {spotify === null ? (
          <Row label="Checking" value="…" />
        ) : spotify.configured === false ? (
          <>
            <p className="text-sm leading-relaxed text-muted">
              This deployment has no Spotify app yet. Create one at{" "}
              <span className="num text-ink">developer.spotify.com/dashboard</span>, then set the
              secrets:
            </p>
            <pre className="num mt-3 overflow-x-auto rounded-lg border border-line bg-panel px-4 py-3 text-[11px] leading-relaxed text-muted">
              {"npx wrangler secret put SPOTIFY_CLIENT_ID\nnpx wrangler secret put SPOTIFY_CLIENT_SECRET\nopenssl rand -base64 32 | npx wrangler secret put TOKEN_KEY"}
            </pre>
          </>
        ) : spotify.connected ? (
          <>
            <Row label="Account" value={spotify.displayName ?? "connected"} good />
            {spotify.product !== "premium" && (
              <p className="mt-3 text-sm text-warn">
                This account is not Premium — Spotify Connect cannot play on it.
              </p>
            )}
            <button onClick={disconnectSpotify} className="mt-4 text-[11px] uppercase tracking-[0.24em] text-dim transition-colors hover:text-muted">
              Disconnect
            </button>
          </>
        ) : (
          <>
            <p className="text-sm leading-relaxed text-muted">
              Connect the Spotify account this deployment plays from. Once — the
              connection survives restarts.
            </p>
            <button
              onClick={connectSpotify}
              className="mt-4 w-full rounded-xl bg-[#1db954] px-6 py-3.5 text-sm font-bold uppercase tracking-[0.2em] text-void transition-opacity hover:opacity-90"
            >
              Connect Spotify
            </button>
          </>
        )}
      </Section>

      {/* -- 2 · Room -------------------------------------------------------- */}
      <Section n="2" title="Room" delay={160}>
        {!room ? (
          <>
            <p className="text-sm leading-relaxed text-muted">
              A room is a code and a QR. Phones scan, tap once, and become
              speakers.
            </p>
            <button
              onClick={() => openRoom()}
              className="mt-4 w-full rounded-xl bg-pulse px-6 py-3.5 text-sm font-bold uppercase tracking-[0.2em] text-void transition-opacity hover:opacity-90"
            >
              Open a room
            </button>
          </>
        ) : (
          <div className="flex flex-col items-center gap-5 sm:flex-row sm:items-start">
            {joinUrl && <QR value={joinUrl} size={164} />}
            <div className="min-w-0 flex-1 text-center sm:text-left">
              <div className="num text-4xl tracking-[0.3em] text-ink">{room.code}</div>
              <button
                onClick={() => joinUrl && void navigator.clipboard?.writeText(joinUrl)}
                className="num mt-2 block w-full truncate text-left text-[11px] tracking-[0.06em] text-muted transition-colors hover:text-ink sm:w-auto"
                title="Copy link"
              >
                {joinUrl}
              </button>
              <p className="mt-3 text-xs leading-relaxed text-dim">
                Scan or share. Tap the link to copy.
              </p>
              <button
                onClick={endRoom}
                className="mt-4 text-[11px] uppercase tracking-[0.24em] text-dim transition-colors hover:text-pulse"
              >
                End the room
              </button>
            </div>
          </div>
        )}
      </Section>

      {/* -- 3 · Source ------------------------------------------------------ */}
      <Section n="3" title="Sound" delay={240}>
        {!room || !spotify?.connected ? (
          <p className="text-sm text-dim">
            {!spotify?.connected ? "Connect Spotify first." : "Open a room first."}
          </p>
        ) : !source?.running && !source?.wanted ? (
          <>
            <p className="text-sm leading-relaxed text-muted">
              Starts a player in the cloud that appears as{" "}
              <span className="text-ink">“Downbeat”</span> under Devices in your
              Spotify app. Whatever you play on it, the whole room plays.
            </p>
            <button
              onClick={startSource}
              className="mt-4 w-full rounded-xl bg-ink px-6 py-3.5 text-sm font-bold uppercase tracking-[0.2em] text-void transition-opacity hover:opacity-90"
            >
              Start streaming
            </button>
          </>
        ) : (
          <>
            <Row
              label="Player"
              value={
                !source?.running
                  ? "restarting…"
                  : source.warming
                    ? "booting…"
                    : (source.spotify ?? "starting")
              }
              good={source?.spotify === "connected"}
            />
            <Row
              label="Room link"
              value={source?.room ?? "—"}
              good={source?.room === "connected"}
            />
            <Row label="Packets" value={source?.packets != null ? String(source.packets) : "—"} />
            {source?.spotify === "connected" && (
              <p className="mt-3 text-sm leading-relaxed text-muted">
                Open Spotify on any device → <span className="text-ink">Devices</span> →{" "}
                <span className="text-ink">Downbeat</span> → press play.
              </p>
            )}
            <button
              onClick={stopSource}
              className="mt-4 text-[11px] uppercase tracking-[0.24em] text-dim transition-colors hover:text-pulse"
            >
              Stop the player
            </button>
          </>
        )}
      </Section>

      {/* -- 4 · Devices ------------------------------------------------------ */}
      <Section n="4" title="Devices" delay={320}>
        {members.length === 0 ? (
          <p className="text-sm text-dim">No one yet. The QR above is the way in.</p>
        ) : (
          <>
            <div className="num mb-4 flex items-center gap-4 text-[10px] tracking-[0.18em] text-muted">
              <span>{members.filter((m) => m.role !== "source").length} LISTENING</span>
              {spread != null && (
                <>
                  <span className="text-line">·</span>
                  <span className={spread < 15 ? "text-lock" : "text-warn"}>
                    SPREAD {spread.toFixed(1)}MS
                  </span>
                </>
              )}
            </div>
            <ul className="divide-y divide-line/60">
              {members.map((m) => (
                <Device key={m.id} m={m} />
              ))}
            </ul>
          </>
        )}
      </Section>
    </main>
  );
}

/* ---------------------------------------------------------------- fragments */

function Section({
  n,
  title,
  delay,
  children,
}: {
  n: string;
  title: string;
  delay: number;
  children: React.ReactNode;
}) {
  return (
    <section className="panel mt-6 p-5 rise" style={{ animationDelay: `${delay}ms` }}>
      <div className="mb-4 flex items-baseline gap-3">
        <span className="num text-[10px] tracking-[0.2em] text-dim">{n}</span>
        <h2 className="text-[11px] font-bold uppercase tracking-[0.3em] text-muted">{title}</h2>
      </div>
      {children}
    </section>
  );
}

function Row({ label, value, good }: { label: string; value: string; good?: boolean }) {
  return (
    <div className="flex items-center justify-between border-b border-line/40 py-2 last:border-0">
      <span className="text-[11px] uppercase tracking-[0.24em] text-dim">{label}</span>
      <span className={`num text-sm ${good ? "text-lock" : "text-ink"}`}>{value}</span>
    </div>
  );
}

function Device({ m }: { m: Member }) {
  const isSource = m.role === "source";
  return (
    <li className="flex items-center gap-3 py-2.5">
      <span
        className={`h-1.5 w-1.5 shrink-0 rounded-full ${
          isSource ? "bg-pulse" : (m.underruns ?? 0) > 0 ? "bg-warn" : "bg-lock"
        }`}
      />
      <span className="min-w-0 flex-1 truncate text-sm text-ink">
        {m.name}
        {isSource && <span className="ml-2 text-[10px] uppercase tracking-[0.2em] text-pulse">source</span>}
      </span>
      <span className="num shrink-0 text-[11px] text-muted">{m.rtt.toFixed(0)}ms</span>
      <span className="num shrink-0 text-[11px] text-muted">±{m.sync.toFixed(1)}</span>
      {!isSource && (
        <span className="num shrink-0 text-[11px] text-muted">
          {m.cushionMs != null ? `${m.cushionMs.toFixed(0)}ms` : "—"}
        </span>
      )}
      {(m.underruns ?? 0) > 0 && (
        <span className="num shrink-0 text-[11px] text-warn">{m.underruns}</span>
      )}
    </li>
  );
}
