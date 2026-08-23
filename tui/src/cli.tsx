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
    "downbeat: downbeat-core nicht gefunden.\n" +
      "  Bauen mit:  cd cli && swift build -c release\n" +
      "  oder DOWNBEAT_CORE auf den Pfad setzen.\n",
  );
  process.exit(1);
}

/** Subcommands that are plain, interactive, or both -- run them as themselves. */
const PASSTHROUGH = new Set(["login", "logout", "selftest", "selftest-qr"]);

const VERSION = "0.1.0";

const HELP = `
  \x1b[1mdownbeat\x1b[0m — ein Song, jedes Handy, dieselbe Millisekunde

  \x1b[1mBEFEHLE\x1b[0m
    downbeat host [Optionen]     Raum öffnen und diesen Mac übertragen
    downbeat login               Host-Passphrase im Schlüsselbund hinterlegen
    downbeat logout              hinterlegte Passphrase löschen
    downbeat help                diese Hilfe
    downbeat version             Version

  \x1b[1mOPTIONEN FÜR host\x1b[0m
    --code <ABC123>              fester Raumcode statt zufällig
                                 6 Zeichen aus 0-9 A-Z, ohne I L O U
    --takeover                   laufende Session dieses Codes übernehmen
    --buffer <ms>                Verzögerung bis zur Wiedergabe (Standard 2000)
    --source <app|system|pid>    Quelle (Standard: spotify)
    --no-mute                    Quelle lokal NICHT stummschalten
    --no-local                   auf diesem Mac nicht mitspielen
    --offline                    nur lokal, kein Raum
    --passphrase <wort>          Passphrase direkt (sonst Schlüsselbund)
    --url <https://...>          anderer Server

  \x1b[1mDIAGNOSE\x1b[0m
    downbeat selftest            Opus-Encoder gegen echte Aufnahme prüfen
    downbeat selftest-qr         QR rendern und zurückdekodieren

  \x1b[1mBEISPIELE\x1b[0m
    downbeat host
    downbeat host --code PARTY7
    downbeat host --code PARTY7 --takeover
    downbeat host --buffer 3000            bei schwachem WLAN
    downbeat host --source system          alles, was der Mac abspielt

  \x1b[1mUMGEBUNG\x1b[0m
    DOWNBEAT_URL                 Server-Adresse
    DOWNBEAT_PASSPHRASE          Passphrase (überschreibt Schlüsselbund)
    DOWNBEAT_CORE                Pfad zur Engine

  Beim Start wird \x1b[1mSpotify lokal stummgeschaltet\x1b[0m und der Ton kommt
  \x1b[1m--buffer\x1b[0m Millisekunden später gemeinsam auf allen Geräten zurück.
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
    `downbeat: unbekannter Befehl "${command}"\n` +
      `Bekannt: host, login, logout, help, version\n` +
      `"downbeat help" zeigt alle Optionen.\n`,
  );
  process.exit(1);
}

function startUI(hostArgs: string[]) {
  const child = spawn(core!, ["host", ...hostArgs, "--json"], {
    stdio: ["ignore", "pipe", "pipe"],
  });

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
      process.stderr.write(`downbeat-core beendet (${exited.reason})\n`);
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
