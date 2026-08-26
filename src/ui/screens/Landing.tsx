import { useState } from "react";
import { CODE_LENGTH } from "../../shared/protocol";
import { lastRoom } from "../lib/device";
import { normalizeCode } from "../../shared/code";

/**
 * The door. Guests type a code or scan a QR and are in; the person running
 * the night goes to the console. Nothing else lives here — the fewer choices
 * at the door, the faster the room fills.
 */
export function Landing({ onEnter }: { onEnter: (code: string) => void }) {
  const [code, setCode] = useState("");
  // A phone that was in a room today should get back in with one tap.
  const [previous] = useState(lastRoom);

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
          One song, every phone, the same millisecond. Play from Spotify;
          every device that scans the code becomes a speaker.
        </p>
      </header>

      <div className="staff my-9 rise" style={{ animationDelay: "140ms" }} />

      <div className="rise" style={{ animationDelay: "220ms" }}>
        {previous && (
          <button
            onClick={() => onEnter(previous.code)}
            className="mb-6 w-full rounded-xl border border-pulse/40 bg-pulse/10 px-5 py-4 text-left transition-colors hover:bg-pulse/15"
          >
            <span className="block text-[10px] uppercase tracking-[0.28em] text-muted">
              Back to your room
            </span>
            <span className="num mt-1 block text-2xl tracking-[0.3em] text-pulse">
              {previous.code}
            </span>
          </button>
        )}
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (code.length === CODE_LENGTH) onEnter(code);
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

        <a
          href="/host"
          onClick={(e) => {
            e.preventDefault();
            history.pushState(null, "", "/host");
            dispatchEvent(new PopStateEvent("popstate"));
          }}
          className="mt-7 block w-full text-center text-[11px] uppercase tracking-[0.28em] text-dim transition-colors hover:text-muted"
        >
          Hosting tonight? Open the console
        </a>
      </div>
    </main>
  );
}
