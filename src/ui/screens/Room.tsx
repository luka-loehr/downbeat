import { useEffect, useState } from "react";
import { useRoom, useWakeLock } from "../lib/useRoom";
import { rememberRoom, saveName, savedName, suggestedName } from "../lib/device";
import { DownbeatRing } from "../components/DownbeatRing";
import { HostControls } from "../components/HostControls";

/**
 * A joined phone is a speaker, not a remote control.
 *
 * There are deliberately no transport buttons, no volume, and no latency
 * slider here: every one of those is a way for one device to end up out of
 * step with the others, and the timing is the engine's job, not the guest's.
 * The only tap in the whole flow is the one browsers force on us to start
 * audio at all.
 */
export function Room({ code, hostToken }: { code: string; hostToken: string | null }) {
  const { conn, snap, join, joining, failure } = useRoom(code, hostToken);
  useWakeLock(!!snap);

  // Name once, ever. A returning device goes straight to a single tap.
  const [name, setName] = useState(() => savedName() ?? suggestedName());
  const [naming, setNaming] = useState(() => savedName() === null);

  useEffect(() => {
    if (snap) rememberRoom(code);
  }, [snap, code]);

  /* ---------------------------------------------------------------- gate */
  if (!snap) {
    const start = () => {
      const chosen = name.trim() || suggestedName();
      saveName(chosen);
      void join(chosen);
    };

    return (
      <main className="mx-auto flex min-h-full w-full max-w-md flex-col justify-center px-6 py-14 text-center">
        <div className="rise">
          <div className="wordmark text-3xl text-ink">DOWNBEAT</div>
          <p className="score mt-3 text-xl text-pulse">everybody on the one</p>
        </div>

        <div className="staff my-10 rise" style={{ animationDelay: "120ms" }} />

        <div className="rise" style={{ animationDelay: "200ms" }}>
          {naming ? (
            <>
              <label className="mb-3 block text-[11px] uppercase tracking-[0.3em] text-muted">
                What should we call this speaker?
              </label>
              <input
                value={name}
                onChange={(e) => setName(e.target.value.slice(0, 24))}
                onKeyDown={(e) => e.key === "Enter" && start()}
                autoFocus
                autoCapitalize="words"
                autoCorrect="off"
                className="w-full rounded-xl border border-line bg-panel px-5 py-4 text-center text-lg text-ink outline-none transition-colors focus:border-pulse"
              />
              <p className="mt-3 text-[11px] text-dim">Once only — your device remembers from now on.</p>
            </>
          ) : (
            <button
              onClick={() => setNaming(true)}
              className="num mb-5 w-full text-[11px] uppercase tracking-[0.24em] text-dim transition-colors hover:text-muted"
            >
              {name} · rename
            </button>
          )}

          <button
            onClick={start}
            disabled={joining}
            className="mt-4 w-full rounded-2xl bg-pulse px-6 py-8 text-base font-bold uppercase tracking-[0.24em] text-void transition-opacity active:opacity-80 disabled:opacity-40"
          >
            {joining ? "Connecting…" : "Tap to play"}
          </button>
          <p className="mt-6 text-xs leading-relaxed text-dim">
            One tap starts the audio — browsers allow it no other way.
            <br />
            Turn the volume up now.
          </p>
          <p className="num mt-5 text-[10px] tracking-[0.22em] text-dim">ROOM {code}</p>
          {failure && <p className="mt-4 text-sm text-pulse">{failure}</p>}
        </div>
      </main>
    );
  }

  /* ---------------------------------------------------------------- player */
  const st = snap.state;
  const track = st && st.current >= 0 ? st.queue[st.current] : null;
  const engine = conn?.getEngine() ?? null;
  const clock = conn?.getClock();
  const duration = track && engine ? engine.duration(track.id) : 0;
  const locked = snap.clock.synced && snap.connected;
  const live = st?.live?.active ? st.live : null;
  const isHost = snap.role === "host";

  // Tells the version watcher to hold off; see watchForNewBuild.
  document.body.dataset.playing =
    live || st?.mode === "playing" || st?.mode === "scheduled" ? "1" : "0";

  return (
    <main className="mx-auto flex min-h-full w-full max-w-md flex-col px-5 pb-10 pt-6 sm:max-w-xl">
      <header className="flex items-center justify-between">
        <div className="wordmark text-base tracking-[-0.04em] text-ink">DOWNBEAT</div>
        <div className="flex items-center gap-2.5">
          <span className={`h-1.5 w-1.5 rounded-full ${locked ? "bg-lock" : "breathe bg-warn"}`} />
          <span className="num text-[11px] tracking-[0.16em] text-muted">{code}</span>
        </div>
      </header>

      <div className="flex flex-1 flex-col items-center justify-center py-8">
        {live ? (
          <>
            <div className="relative grid h-64 w-64 place-items-center sm:h-72 sm:w-72">
              <div className="absolute h-52 w-52 rounded-full border border-line sm:h-60 sm:w-60" />
              <div
                className="breathe absolute h-52 w-52 rounded-full border-2 sm:h-60 sm:w-60"
                style={{ borderColor: "var(--color-pulse)" }}
              />
              <div className="relative text-center">
                <div className="wordmark text-5xl text-pulse">LIVE</div>
                <div className="mt-2 text-[11px] uppercase tracking-[0.3em] text-muted">
                  {live.sourceLabel}
                </div>
              </div>
            </div>
            <p className="score mt-5 text-lg text-dim">straight off the host</p>
          </>
        ) : (
          <>
            <DownbeatRing
              mode={st?.mode ?? "idle"}
              startAt={st?.startAt ?? 0}
              now={() => clock?.now() ?? 0}
              engine={snap.engine}
              duration={duration}
            />
            <h2 className="mt-5 max-w-full truncate text-center text-lg text-ink">
              {track?.title ?? "—"}
            </h2>
            <p className="score mt-1 text-lg text-dim">
              {st?.mode === "playing" || st?.mode === "scheduled"
                ? "in unison"
                : st?.mode === "arming"
                  ? "loading everyone"
                  : "silent"}
            </p>
          </>
        )}
      </div>

      {/* Status, not controls. Enough to diagnose a bad night, nothing to press. */}
      <footer className="num flex items-center justify-center gap-3 text-[10px] tracking-[0.18em] text-dim">
        <span className={locked ? "text-lock" : "text-warn"}>
          {locked ? `±${snap.clock.uncertainty.toFixed(1)}MS` : "SYNC…"}
        </span>
        <span className="text-line">·</span>
        <span>{snap.clock.rtt.toFixed(0)}MS</span>
        {live && snap.live && (
          <>
            <span className="text-line">·</span>
            <span className={snap.live.underruns > 0 ? "text-warn" : ""}>
              {snap.live.aheadMs.toFixed(0)}MS BUF
            </span>
            {snap.live.underruns > 0 && <span className="text-warn">{snap.live.underruns} GAPS</span>}
          </>
        )}
      </footer>

      {/* The web host keeps file transport; the CLI host does not need it. */}
      {isHost && st && conn && hostToken && !live && (
        <section className="mt-8">
          <div className="staff mb-5" />
          <HostControls conn={conn} state={st} code={code} hostToken={hostToken} />
        </section>
      )}

      {snap.error && (
        <p className="mt-6 rounded-lg border border-pulse/40 bg-pulse/10 px-4 py-3 text-center text-sm text-pulse">
          {snap.error}
        </p>
      )}
    </main>
  );
}
