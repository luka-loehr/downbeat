import { useEffect, useRef, useState } from "react";
import type { PlayMode } from "../../shared/protocol";
import type { EngineStatus } from "../../audio/engine";

interface Props {
  mode: PlayMode;
  startAt: number;
  now: () => number;
  engine: EngineStatus;
  duration: number;
}

/**
 * The signature element: a ring that closes as the deadline approaches and
 * snaps outward on the downbeat itself. It is the only moving thing on the
 * listener screen, because it is the only thing that matters.
 */
export function DownbeatRing({ mode, startAt, now, engine, duration }: Props) {
  const [countdown, setCountdown] = useState(0);
  const [strikes, setStrikes] = useState<number[]>([]);
  const fired = useRef(0);

  useEffect(() => {
    let raf = 0;
    const loop = () => {
      const left = startAt - now();
      setCountdown(left);
      // Fire the strike exactly once per scheduled start.
      if (mode === "scheduled" && left <= 0 && fired.current !== startAt) {
        fired.current = startAt;
        setStrikes((s) => [...s.slice(-2), Date.now()]);
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [mode, startAt, now]);

  const arming = mode === "arming";
  const counting = mode === "scheduled" && countdown > 0;
  const playing = mode === "playing" || (mode === "scheduled" && countdown <= 0);

  // While counting down, the ring closes from 1.35x to 1x over the last 3 s.
  const closing = counting ? Math.min(1, Math.max(0, countdown / 3000)) : 0;
  const progress = duration > 0 ? Math.min(1, engine.position / duration) : 0;

  return (
    <div className="relative grid h-64 w-64 place-items-center sm:h-72 sm:w-72">
      {/* progress arc */}
      <svg viewBox="0 0 100 100" className="absolute inset-0 -rotate-90">
        <circle cx="50" cy="50" r="46" fill="none" stroke="var(--color-line)" strokeWidth="1" />
        {playing && (
          <circle
            cx="50"
            cy="50"
            r="46"
            fill="none"
            stroke="var(--color-pulse)"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeDasharray={`${progress * 289.03} 289.03`}
            className="transition-[stroke-dasharray] duration-300 ease-linear"
          />
        )}
      </svg>

      {/* strike rings */}
      {strikes.map((k) => (
        <span
          key={k}
          className="strike pointer-events-none absolute h-52 w-52 rounded-full border-pulse sm:h-60 sm:w-60"
          style={{ borderStyle: "solid" }}
        />
      ))}

      {/* the closing ring */}
      <div
        className="absolute h-52 w-52 rounded-full border transition-transform duration-100 ease-linear sm:h-60 sm:w-60"
        style={{
          transform: `scale(${1 + closing * 0.35})`,
          borderColor: counting ? "var(--color-pulse)" : "var(--color-line)",
          borderWidth: counting ? 2 : 1,
          opacity: counting ? 0.35 + (1 - closing) * 0.65 : 1,
        }}
      />

      <div className="relative grid place-items-center text-center">
        {arming && (
          <>
            <div className="num text-5xl font-medium tabular-nums text-ink">
              {Math.round(engine.loadProgress * 100)}
              <span className="text-xl text-dim">%</span>
            </div>
            <div className="mt-2 text-[11px] uppercase tracking-[0.3em] text-muted">Buffering</div>
          </>
        )}
        {counting && (
          <>
            <div className="num text-7xl font-medium tabular-nums leading-none text-pulse">
              {(countdown / 1000).toFixed(1)}
            </div>
            <div className="mt-2 text-[11px] uppercase tracking-[0.3em] text-muted">
              On the downbeat
            </div>
          </>
        )}
        {playing && (
          <>
            <div className="num text-5xl font-medium tabular-nums leading-none text-ink">
              {fmt(engine.position)}
            </div>
            <div className="mt-2 text-[11px] uppercase tracking-[0.3em] text-muted">
              {duration ? fmt(duration) : "Playing"}
            </div>
          </>
        )}
        {!arming && !counting && !playing && (
          <>
            <div className="score text-4xl text-dim">tacet</div>
            <div className="mt-2 text-[11px] uppercase tracking-[0.3em] text-dim">Waiting</div>
          </>
        )}
      </div>
    </div>
  );
}

function fmt(s: number): string {
  const m = Math.floor(s / 60);
  const r = Math.floor(s % 60);
  return `${m}:${String(r).padStart(2, "0")}`;
}
