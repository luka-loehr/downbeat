import { useCallback, useEffect, useState } from "react";
import { Landing } from "./screens/Landing";
import { Room } from "./screens/Room";
import { isValidCode } from "../shared/code";

/** Room URLs are `/r/CODE`; everything else is the landing screen. */
function readPath(): string | null {
  const m = /^\/r\/([^/]+)/.exec(location.pathname);
  if (!m) return null;
  const code = decodeURIComponent(m[1]).toUpperCase();
  return isValidCode(code) ? code : null;
}

export function App() {
  const [code, setCode] = useState<string | null>(readPath);

  useEffect(() => {
    const onPop = () => setCode(readPath());
    addEventListener("popstate", onPop);
    return () => removeEventListener("popstate", onPop);
  }, []);

  const enter = useCallback((next: string, token: string | null) => {
    if (token) sessionStorage.setItem(`downbeat.host.${next}`, token);
    history.pushState(null, "", `/r/${next}`);
    setCode(next);
  }, []);

  if (!code) return <Landing onEnter={enter} />;

  const hostToken = sessionStorage.getItem(`downbeat.host.${code}`);
  return <Room key={code} code={code} hostToken={hostToken} />;
}
