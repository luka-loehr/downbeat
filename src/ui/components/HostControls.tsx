import { useRef, useState } from "react";
import type { RoomState, Track } from "../../shared/protocol";
import type { RoomConnection } from "../../audio/room";
import { QR } from "./QR";

export function HostControls({
  conn,
  state,
  code,
  hostToken,
}: {
  conn: RoomConnection;
  state: RoomState;
  code: string;
  hostToken: string;
}) {
  const [uploading, setUploading] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const joinUrl = `${location.origin}/r/${code}`;

  async function addFiles(files: FileList | null) {
    if (!files?.length) return;
    setError(null);
    const added: Track[] = [];
    for (const file of Array.from(files)) {
      setUploading(file.name);
      try {
        const res = await fetch(
          `/api/upload?code=${code}&hostToken=${encodeURIComponent(hostToken)}`,
          {
            method: "POST",
            headers: {
              "content-type": file.type || "audio/mpeg",
              "X-Track-Title": encodeTitle(file.name),
            },
            body: file,
          },
        );
        const data = (await res.json()) as { track?: Track; error?: string };
        if (!res.ok || !data.track) throw new Error(data.error ?? "upload failed");
        added.push(data.track);
      } catch (err) {
        setError(`${file.name}: ${err instanceof Error ? err.message : "upload failed"}`);
      }
    }
    setUploading(null);
    if (added.length) conn.command({ c: "addTracks", tracks: added });
    if (fileRef.current) fileRef.current.value = "";
  }

  const playing = state.mode === "playing" || state.mode === "scheduled" || state.mode === "arming";
  const ready = state.members.filter((m) => m.readyFor === state.queue[state.current]?.id).length;

  return (
    <div className="space-y-4">
      {/* transport */}
      <div className="panel p-5">
        <div className="flex items-center gap-2">
          <button
            onClick={() => conn.command({ c: "prev" })}
            disabled={state.current <= 0}
            className="rounded-lg border border-line bg-raised px-4 py-3 text-sm text-muted transition-colors hover:text-ink disabled:opacity-25"
          >
            ‹‹
          </button>
          <button
            onClick={() =>
              playing ? conn.command({ c: "pause" }) : conn.command({ c: "play" })
            }
            disabled={state.current < 0}
            className="flex-1 rounded-lg bg-pulse px-6 py-3 text-[11px] font-bold uppercase tracking-[0.2em] text-void transition-opacity disabled:opacity-25"
          >
            {playing ? "Stop" : "Play together"}
          </button>
          <button
            onClick={() => conn.command({ c: "next" })}
            disabled={state.current >= state.queue.length - 1}
            className="rounded-lg border border-line bg-raised px-4 py-3 text-sm text-muted transition-colors hover:text-ink disabled:opacity-25"
          >
            ››
          </button>
        </div>

        {state.mode === "arming" && (
          <div className="mt-4">
            <div className="flex justify-between text-[10px] uppercase tracking-[0.22em] text-muted">
              <span>Buffering on every device</span>
              <span className="num">
                {ready}/{state.members.length}
              </span>
            </div>
            <div className="sweep mt-2 h-0.5 rounded-full bg-line" />
            <button
              onClick={() => conn.command({ c: "forceStart" })}
              className="mt-3 w-full text-[10px] uppercase tracking-[0.24em] text-dim transition-colors hover:text-pulse"
            >
              Start without the stragglers
            </button>
          </div>
        )}
      </div>

      {/* queue */}
      <div className="panel p-5">
        <div className="flex items-baseline justify-between">
          <h3 className="text-[11px] uppercase tracking-[0.28em] text-muted">Queue</h3>
          <span className="num text-[11px] text-dim">{state.queue.length}</span>
        </div>

        <ul className="mt-4 space-y-1">
          {state.queue.map((t, i) => (
            <li key={t.id}>
              <button
                onClick={() => conn.command({ c: "play", index: i, offsetInTrack: 0 })}
                className={`flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left transition-colors ${
                  i === state.current ? "bg-pulse/12 text-ink" : "text-muted hover:bg-raised"
                }`}
              >
                <span
                  className={`num text-[10px] ${i === state.current ? "text-pulse" : "text-dim"}`}
                >
                  {String(i + 1).padStart(2, "0")}
                </span>
                <span className="min-w-0 flex-1 truncate text-sm">{t.title}</span>
                <span className="num text-[10px] text-dim">
                  {(t.size / 1048576).toFixed(1)}M
                </span>
              </button>
            </li>
          ))}
          {!state.queue.length && (
            <li className="score py-3 text-center text-lg text-dim">nothing queued yet</li>
          )}
        </ul>

        <input
          ref={fileRef}
          type="file"
          accept="audio/*"
          multiple
          onChange={(e) => void addFiles(e.target.files)}
          className="hidden"
        />
        <button
          onClick={() => fileRef.current?.click()}
          disabled={!!uploading}
          className="mt-4 w-full rounded-lg border border-dashed border-line px-4 py-4 text-[11px] font-bold uppercase tracking-[0.2em] text-muted transition-colors hover:border-pulse hover:text-pulse disabled:opacity-40"
        >
          {uploading ? `Uploading ${uploading}…` : "+ Add audio files"}
        </button>
        {error && <p className="mt-3 text-xs text-pulse">{error}</p>}
      </div>

      {/* invite */}
      <div className="panel flex flex-col items-center gap-4 p-6">
        <h3 className="text-[11px] uppercase tracking-[0.28em] text-muted">Point a camera here</h3>
        <QR value={joinUrl} />
        <div className="num text-center text-3xl tracking-[0.32em] text-ink">{code}</div>
        <div className="text-[10px] uppercase tracking-[0.2em] text-dim">
          {location.host}/r/{code}
        </div>
      </div>
    </div>
  );
}

/** HTTP headers are latin-1 only; song titles very much are not. */
function encodeTitle(name: string): string {
  return encodeURIComponent(name.replace(/\.[^.]+$/, ""));
}
