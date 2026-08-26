import { useCallback, useEffect, useState } from "react";
import { Landing } from "./screens/Landing";
import { Room } from "./screens/Room";
import { Host } from "./screens/Host";
import { isValidCode, normalizeCode } from "../shared/code";
import { watchForNewBuild } from "./lib/version";

type Route = { screen: "landing" } | { screen: "host" } | { screen: "room"; code: string };

/** `/host` is the console, `/r/CODE` a room; everything else is the door. */
function readPath(): Route {
  if (location.pathname === "/host") return { screen: "host" };
  const m = /^\/r\/([^/]+)/.exec(location.pathname);
  if (m) {
    const code = normalizeCode(decodeURIComponent(m[1]));
    if (isValidCode(code)) return { screen: "room", code };
  }
  return { screen: "landing" };
}

export function App() {
  const [route, setRoute] = useState<Route>(readPath);

  useEffect(() => {
    const onPop = () => setRoute(readPath());
    addEventListener("popstate", onPop);
    return () => removeEventListener("popstate", onPop);
  }, []);

  // Never reload while audio is running: a reload mid-song would be a much
  // more obvious fault than the stale code it is fixing.
  useEffect(() => watchForNewBuild(() => document.body.dataset.playing === "1"), []);

  const enter = useCallback((next: string) => {
    history.pushState(null, "", `/r/${next}`);
    setRoute({ screen: "room", code: next });
  }, []);

  if (route.screen === "host") return <Host />;
  if (route.screen === "landing") return <Landing onEnter={enter} />;

  const hostToken = sessionStorage.getItem(`downbeat.host.${route.code}`);
  return <Room key={route.code} code={route.code} hostToken={hostToken} />;
}
