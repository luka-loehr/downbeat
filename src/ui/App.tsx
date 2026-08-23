import { useCallback, useEffect, useState } from "react";
import { Landing } from "./screens/Landing";
import { Room } from "./screens/Room";
import { isValidCode, normalizeCode } from "../shared/code";
import { watchForNewBuild } from "./lib/version";

/** Room URLs are `/r/CODE`; everything else is the landing screen. */
function readPath(): string | null {
  const m = /^\/r\/([^/]+)/.exec(location.pathname);
  if (!m) return null;
  const code = normalizeCode(decodeURIComponent(m[1]));
  return isValidCode(code) ? code : null;
}

export function App() {
  const [code, setCode] = useState<string | null>(readPath);

  useEffect(() => {
    const onPop = () => setCode(readPath());
    addEventListener("popstate", onPop);
    return () => removeEventListener("popstate", onPop);
  }, []);

  // Never reload while audio is running: a reload mid-song would be a much
  // more obvious fault than the stale code it is fixing.
  useEffect(() => watchForNewBuild(() => document.body.dataset.playing === "1"), []);

  const enter = useCallback((next: string, token: string | null) => {
    if (token) sessionStorage.setItem(`downbeat.host.${next}`, token);
    history.pushState(null, "", `/r/${next}`);
    setCode(next);
  }, []);

  if (!code) return <Landing onEnter={enter} />;

  const hostToken = sessionStorage.getItem(`downbeat.host.${code}`);
  return <Room key={code} code={code} hostToken={hostToken} />;
}
