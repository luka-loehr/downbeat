import { useEffect, useRef, useState } from "react";
import type { RoomState, ServerMessage } from "../../shared/protocol";

/**
 * A read-only seat in the room, for the host console.
 *
 * The dashboard needs the member list and transport state but must never be a
 * speaker: no AudioContext, no engine, no tap-to-start. So instead of a
 * RoomConnection it holds a bare websocket, consumes state broadcasts, and
 * reconnects quietly for as long as the screen is open.
 */
export function useObserver(code: string | null, hostToken: string | null) {
  const [state, setState] = useState<RoomState | null>(null);
  const [you, setYou] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const attempt = useRef(0);

  useEffect(() => {
    if (!code || !hostToken) return;
    let ws: WebSocket | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let closed = false;

    const connect = () => {
      const url = new URL("/api/ws", location.origin);
      url.protocol = url.protocol.replace("http", "ws");
      url.searchParams.set("code", code);
      url.searchParams.set("role", "host");
      url.searchParams.set("name", "Console");
      url.searchParams.set("hostToken", hostToken);
      ws = new WebSocket(url);

      ws.onopen = () => {
        attempt.current = 0;
        setConnected(true);
      };
      ws.onmessage = (ev) => {
        if (typeof ev.data !== "string") return;
        const msg = JSON.parse(ev.data) as ServerMessage;
        if (msg.t === "welcome") {
          setYou(msg.you);
          setState(msg.state);
        } else if (msg.t === "state") {
          setState(msg.state);
        }
      };
      ws.onclose = () => {
        setConnected(false);
        if (closed) return;
        attempt.current += 1;
        timer = setTimeout(connect, Math.min(500 * 2 ** attempt.current, 8000));
      };
    };

    connect();
    return () => {
      closed = true;
      if (timer) clearTimeout(timer);
      ws?.close();
    };
  }, [code, hostToken]);

  return { state, you, connected };
}
