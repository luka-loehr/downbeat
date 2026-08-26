#!/usr/bin/env node
import { render } from "ink";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { App } from "./App.js";
import { createParser, type CoreEvent } from "./events.js";

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Locate the Swift capture engine.
 *
 * Capture has to be native (Core Audio process taps) and the UI has to be Node
 * (React Ink), so they are two binaries. The user should never have to know
 * that, hence the search rather than a hardcoded path.
 */
function findCore(): string | null {
  const candidates = [
    process.env.DOWNBEAT_CORE,
    join(here, "downbeat-core"),
    join(here, "..", "..", "cli", ".build", "release", "downbeat-core"),
    join(homedir(), ".local", "bin", "downbeat-core"),
    "/usr/local/bin/downbeat-core",
    "/opt/homebrew/bin/downbeat-core",
  ].filter(Boolean) as string[];
  return candidates.find((p) => existsSync(p)) ?? null;
}

const core = findCore();
if (!core) {
  process.stderr.write(
    "downbeat: downbeat-core not found.\n" +
      "  Build it with:  cd cli && swift build -c release\n" +
      "  or point DOWNBEAT_CORE at it.\n",
  );
  process.exit(1);
}

/** Subcommands that are plain, interactive, or both -- run them as themselves. */
const PASSTHROUGH = new Set(["login", "logout", "selftest", "selftest-qr"]);

const VERSION = "0.3.1";

const HELP = `
  \x1b[1mdownbeat\x1b[0m — one song, every phone, the same millisecond

  \x1b[1mCOMMANDS\x1b[0m
    downbeat host [options]      open a room and stream this Mac
    downbeat login               store the host passphrase
    downbeat logout              forget the stored passphrase
    downbeat help                this help
    downbeat version             version

  \x1b[1mOPTIONS FOR host\x1b[0m
    --code <ABC123>              fixed room code instead of a random one
                                 6 chars from 0-9 A-Z; O, I and L are read
                                 as 0, 1 and 1, and U is not used
    --takeover                   take over a room already being hosted
    --buffer <ms>                starting delay budget (default 2000); the
                                 host then adapts it toward the smallest
                                 value the room's listeners can carry
    --min-buffer <ms>            the adaptive budget's floor (default 350)
    --no-adapt                   pin the budget at --buffer
    --source <app|system|pid>    app name (Spotify, Music, …), "system"
                                 for everything, or a process id
    --no-mute                    do NOT mute the source locally
    --no-local                   do not play on this Mac
    --offline                    local only, no room
    --passphrase <word>          pass it directly instead of using the store
    --url <https://...>          a different server

  \x1b[1mKEYS WHILE HOSTING\x1b[0m
    m                            mute / unmute this Mac
    + / -                        this Mac's level
    s                            switch source (then 1-8, a = everything, esc)
    q                            quit

  \x1b[1mDIAGNOSTICS\x1b[0m
    downbeat selftest            check the Opus encoder against live capture
    downbeat selftest-qr         render a QR and decode it back

  \x1b[1mENVIRONMENT\x1b[0m
    DOWNBEAT_URL                 server address
    DOWNBEAT_PASSPHRASE          passphrase (overrides the stored one)
    DOWNBEAT_CORE                path to the capture engine

  On start, \x1b[1mthe source is muted locally\x1b[0m and its audio comes back
  \x1b[1m--buffer\x1b[0m milliseconds later, together, on every device.
`;

const args = process.argv.slice(2);
const command = args[0];

// A bare `downbeat` explains itself rather than silently doing something.
if (!command || command === "help" || command === "-h" || command === "--help") {
  process.stdout.write(HELP.replace(/^\n/, "") + "\n");
  process.exit(0);
}

if (command === "version" || command === "-v" || command === "--version") {
  process.stdout.write(`downbeat ${VERSION}\n`);
  process.exit(0);
}

if (PASSTHROUGH.has(command)) {
  const child = spawn(core, args, { stdio: "inherit" });
  child.on("exit", (code) => process.exit(code ?? 0));
} else if (command === "host") {
  startUI(args.slice(1));
} else {
  process.stderr.write(
    `downbeat: unknown command "${command}"\n` +
      `Known: host, login, logout, help, version\n` +
      `Run "downbeat help" for all options.\n`,
  );
  process.exit(1);
}

function startUI(hostArgs: string[]) {
  // stdin carries runtime commands: a keystroke has to travel to the engine.
  const child = spawn(core!, ["host", ...hostArgs, "--json"], {
    stdio: ["pipe", "pipe", "pipe"],
  });

  const send = (command: Record<string, unknown>) => {
    if (!child.stdin.writable) return;
    try {
      child.stdin.write(JSON.stringify(command) + "\n");
    } catch {
      /* engine gone; the UI is about to unmount anyway */
    }
  };

  const listeners = new Set<(event: CoreEvent) => void>();
  /** Kept so a core that dies can explain itself after the screen is restored. */
  const complaints: string[] = [];
  const emit = (event: CoreEvent) => {
    if (event.t === "log" && event.level === "error") {
      complaints.push(event.msg);
      if (complaints.length > 8) complaints.shift();
    }
    listeners.forEach((fn) => fn(event));
  };
  const parse = createParser(emit);

  child.stdout.setEncoding("utf8");
  child.stdout.on("data", parse);
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    for (const line of chunk.split("\n")) {
      const msg = line.trim();
      if (msg) emit({ t: "log", level: "error", msg });
    }
  });

  let exited: { code: number | null; reason: string } | null = null;

  // The alternate screen keeps the UI from scrolling the user's history away,
  // and is restored however we leave: unmount, signal, crash or plain exit.
  let onAlt = false;
  const enterAlt = () => {
    onAlt = true;
    process.stdout.write("\x1b[?1049h\x1b[H\x1b[2J");
  };
  const leaveAlt = () => {
    if (!onAlt) return;
    onAlt = false;
    process.stdout.write("\x1b[?1049l\x1b[?25h");
  };
  enterAlt();

  let stopping = false;
  let force: NodeJS.Timeout | null = null;

  /**
   * Ask the core to stop and give it a moment.
   *
   * SIGINT is what unmutes the captured app again, so killing outright would
   * leave the user's Spotify silent. If it has not gone after two and a half
   * seconds something is wedged and the screen matters more.
   */
  const stopCore = () => {
    if (stopping) return;
    stopping = true;
    if (child.exitCode === null) child.kill("SIGINT");
    force = setTimeout(() => {
      if (child.exitCode === null) child.kill("SIGKILL");
      app.unmount();
    }, 2500);
  };

  const draw = () =>
    app.rerender(
      <App
        subscribe={(fn) => {
          listeners.add(fn);
          return () => listeners.delete(fn);
        }}
        onQuit={stopCore}
      send={send}
        coreExited={exited}
      />,
    );

  const app = render(
    <App
      subscribe={(fn) => {
        listeners.add(fn);
        return () => listeners.delete(fn);
      }}
      onQuit={stopCore}
      send={send}
      coreExited={exited}
    />,
    { exitOnCtrlC: false },
  );

  child.on("exit", (code, signal) => {
    if (force) clearTimeout(force);
    exited = { code, reason: signal ? `Signal ${signal}` : `Code ${code}` };
    // A core that died on its own gets a beat on screen to say so; one that
    // was asked to stop should not hold the terminal hostage.
    draw();
    setTimeout(() => app.unmount(), stopping ? 150 : 1200);
  });

  const finish = () => {
    if (force) clearTimeout(force);
    if (child.exitCode === null) child.kill("SIGINT");
    leaveAlt();
    // Whatever went wrong is worth more on the real screen than on one that is
    // about to be thrown away.
    if (exited && exited.code !== 0 && exited.code !== null) {
      process.stderr.write(`downbeat-core exited (${exited.reason})\n`);
      for (const line of complaints) process.stderr.write(`  ${line}\n`);
    }
  };

  app.waitUntilExit().then(finish, finish);
  process.on("SIGINT", stopCore);
  process.on("SIGTERM", stopCore);
  process.on("SIGHUP", () => {
    stopCore();
    leaveAlt();
  });
  process.on("exit", leaveAlt);
}
