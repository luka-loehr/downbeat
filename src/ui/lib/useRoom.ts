import { useCallback, useEffect, useRef, useState } from "react";
import { RoomConnection, type RoomSnapshot } from "../../audio/room";

/**
 * Owns a RoomConnection for the lifetime of a screen.
 *
 * `join` must be invoked from a real user gesture: iOS refuses to start an
 * AudioContext otherwise, and the whole app is an AudioContext.
 */
export function useRoom(code: string, hostToken: string | null) {
  const ref = useRef<RoomConnection | null>(null);
  const [snap, setSnap] = useState<RoomSnapshot | null>(null);
  const [joining, setJoining] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const join = useCallback(
    async (name: string) => {
      if (ref.current) return;
      setJoining(true);
      setFailure(null);
      try {
        const conn = new RoomConnection(code, name, hostToken);
        conn.subscribe(setSnap);
        await conn.start();
        ref.current = conn;
      } catch (err) {
        setFailure(err instanceof Error ? err.message : "could not join");
      } finally {
        setJoining(false);
      }
    },
    [code, hostToken],
  );

  useEffect(() => {
    return () => {
      ref.current?.stop();
      ref.current = null;
    };
  }, []);

  return { conn: ref.current, snap, join, joining, failure, joined: !!snap };
}

/** Keeps the screen awake; a locked phone is a silent phone. */
export function useWakeLock(active: boolean) {
  useEffect(() => {
    if (!active) return;
    let lock: { release: () => Promise<void> } | null = null;
    let cancelled = false;

    const request = async () => {
      try {
        const nav = navigator as Navigator & {
          wakeLock?: { request: (t: "screen") => Promise<{ release: () => Promise<void> }> };
        };
        if (!nav.wakeLock) return;
        const l = await nav.wakeLock.request("screen");
        if (cancelled) void l.release();
        else lock = l;
      } catch {
        /* denied or unsupported */
      }
    };

    void request();
    const onVisible = () => {
      if (document.visibilityState === "visible") void request();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", onVisible);
      void lock?.release();
    };
  }, [active]);
}
