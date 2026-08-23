import { useState } from "react";
import { CODE_LENGTH } from "../../shared/protocol";
import { lastRoom } from "../lib/device";
import { normalizeCode } from "../../shared/code";

export function Landing({ onEnter }: { onEnter: (code: string, hostToken: string | null) => void }) {
  const [code, setCode] = useState("");
  // A phone that was in a room today should get back in with one tap.
  const [previous] = useState(lastRoom);
  const [pass, setPass] = useState("");
  const [hosting, setHosting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function createRoom(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/rooms", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ passphrase: pass }),
      });
      const data = (await res.json()) as { code?: string; hostToken?: string; error?: string };
      if (!res.ok || !data.code || !data.hostToken) throw new Error(data.error ?? "could not create room");
      sessionStorage.setItem(`downbeat.host.${data.code}`, data.hostToken);
      onEnter(data.code, data.hostToken);
    } catch (err) {
      setError(err instanceof Error ? err.message : "could not create room");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="mx-auto flex min-h-full w-full max-w-lg flex-col justify-center px-6 py-14">
      <header className="rise" style={{ animationDelay: "40ms" }}>
        <h1 className="wordmark text-[clamp(3.4rem,17vw,5.5rem)] text-ink">
          DOWN
          <br />
          BEAT
        </h1>
        <p className="score mt-4 text-2xl text-pulse">everybody on the one</p>
        <p className="mt-3 max-w-sm text-sm leading-relaxed text-muted">
          One song, every phone, the same millisecond. The audio is on your device
          before the deadline exists — all that travels at playback time is a
          timestamp.
        </p>
      </header>

      <div className="staff my-9 rise" style={{ animationDelay: "140ms" }} />

      {!hosting ? (
        <div className="rise" style={{ animationDelay: "220ms" }}>
          {previous && (
            <button
              onClick={() => onEnter(previous.code, null)}
              className="mb-6 w-full rounded-xl border border-pulse/40 bg-pulse/10 px-5 py-4 text-left transition-colors hover:bg-pulse/15"
            >
              <span className="block text-[10px] uppercase tracking-[0.28em] text-muted">
                Zurück in den Raum
              </span>
              <span className="num mt-1 block text-2xl tracking-[0.3em] text-pulse">
                {previous.code}
              </span>
            </button>
          )}
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (code.length === CODE_LENGTH) onEnter(code, null);
            }}
          >
            <label className="mb-3 block text-[11px] uppercase tracking-[0.32em] text-muted">
              Room code
            </label>
            <input
              value={code}
              onChange={(e) =>
                setCode(
                  normalizeCode(e.target.value)
                    .replace(/[^0-9A-HJKMNP-TV-Z]/g, "")
                    .slice(0, CODE_LENGTH),
                )
              }
              inputMode="text"
              autoCapitalize="characters"
              autoCorrect="off"
              spellCheck={false}
              placeholder="——————"
              className="num w-full rounded-xl border border-line bg-panel px-5 py-5 text-center text-[2rem] tracking-[0.42em] text-ink outline-none transition-colors placeholder:text-dim focus:border-pulse"
            />
            <button
              type="submit"
              disabled={code.length !== CODE_LENGTH}
              className="mt-4 w-full rounded-xl bg-pulse px-6 py-4 text-sm font-bold uppercase tracking-[0.2em] text-void transition-opacity disabled:opacity-25"
            >
              Join the room
            </button>
          </form>

          <button
            onClick={() => setHosting(true)}
            className="mt-7 w-full text-center text-[11px] uppercase tracking-[0.28em] text-dim transition-colors hover:text-muted"
          >
            Start a room instead
          </button>
        </div>
      ) : (
        <form onSubmit={createRoom} className="rise">
          <label className="mb-3 block text-[11px] uppercase tracking-[0.32em] text-muted">
            Host passphrase
          </label>
          <input
            value={pass}
            onChange={(e) => setPass(e.target.value)}
            type="password"
            autoFocus
            placeholder="•••••••••"
            className="w-full rounded-xl border border-line bg-panel px-5 py-4 text-lg text-ink outline-none transition-colors placeholder:text-dim focus:border-pulse"
          />
          <button
            type="submit"
            disabled={busy || !pass}
            className="mt-4 w-full rounded-xl bg-ink px-6 py-4 text-sm font-bold uppercase tracking-[0.2em] text-void transition-opacity disabled:opacity-25"
          >
            {busy ? "Opening…" : "Open the room"}
          </button>
          <button
            type="button"
            onClick={() => setHosting(false)}
            className="mt-7 w-full text-center text-[11px] uppercase tracking-[0.28em] text-dim transition-colors hover:text-muted"
          >
            I have a code
          </button>
        </form>
      )}

      {error && (
        <p className="mt-5 rounded-lg border border-pulse/40 bg-pulse/10 px-4 py-3 text-sm text-pulse">
          {error}
        </p>
      )}
    </main>
  );
}
