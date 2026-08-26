import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Box, Text, useApp, useInput, useStdin, useStdout } from "ink";
import { QrCode } from "./QrCode.js";
import { BigCode } from "./BigCode.js";
import { Scope } from "./Scope.js";
import {
  Devices,
  Field,
  LogView,
  Rule,
  Telemetry,
  deviceState,
  ms,
  type LogLine,
  type Stat,
} from "./panels.js";
import { GUTTER, planLayout, type Layout } from "./layout.js";
import { C, G, clockTime, duration, group, num, truncate } from "./theme.js";
import type {
  ConfigEvent,
  CoreEvent,
  Member,
  RoomEvent,
  SourcesEvent,
  StatusEvent,
} from "./events.js";

/** Commands the UI can send back to the capture engine. */
export type Command = Record<string, unknown>;

export interface AppProps {
  subscribe: (listener: (event: CoreEvent) => void) => () => void;
  onQuit: () => void;
  coreExited: { code: number | null; reason: string } | null;
  /** Send a runtime command to the engine; no-op once it has exited. */
  send: (command: Command) => void;
}

/** Log lines kept in memory; the panel shows as many as it has rows for. */
const LOG_MEMORY = 200;
/** Columns the waveform advances per status event, i.e. per 200 ms. */
const COLS_PER_TICK = 6;
/** Longest waveform history worth keeping, in columns. */
const SCOPE_MEMORY = 768;
/** Buffer priming legitimately starves the player; past this it is a fault. */
const PRIMED_SEC = 2.5;
/** How long a starve or a re-anchor keeps the session marked as degraded. */
const ALERT_MS = 4000;

export function App({ subscribe, onQuit, coreExited, send }: AppProps) {
  const { exit } = useApp();
  const size = useTerminalSize();
  const { isRawModeSupported } = useStdin();

  const [config, setConfig] = useState<ConfigEvent | null>(null);
  const [room, setRoom] = useState<RoomEvent | null>(null);
  const [status, setStatus] = useState<StatusEvent | null>(null);
  const [members, setMembers] = useState<Member[]>([]);
  const [logs, setLogs] = useState<LogLine[]>([]);
  const [stopping, setStopping] = useState(false);
  const [sources, setSources] = useState<SourcesEvent["list"]>([]);
  const [picking, setPicking] = useState(false);

  // The waveform is appended to, never rebuilt: at five events a second a new
  // array per frame would be the most expensive thing the UI does, and React
  // has no reason to diff it -- the <Scope> reads it straight through.
  const levels = useRef<number[]>([]);
  const alerts = useRef({ starvedAt: 0, reanchorAt: 0, lastStarved: -1, lastReanchors: -1 });

  useEffect(() => {
    let id = 0;
    return subscribe((event) => {
      switch (event.t) {
        case "config":
          setConfig(event);
          break;
        case "room":
          setRoom(event);
          break;
        case "members":
          setMembers(event.list ?? []);
          break;
        case "listeners":
          break;
        case "sources":
          setSources(event.list ?? []);
          break;
        case "status": {
          pushLevels(levels.current, event.levels);
          const a = alerts.current;
          const primed = event.capturedSec > PRIMED_SEC;
          if (primed && a.lastStarved >= 0 && event.starved > a.lastStarved) a.starvedAt = Date.now();
          if (a.lastReanchors >= 0 && event.reanchors > a.lastReanchors) a.reanchorAt = Date.now();
          a.lastStarved = event.starved;
          a.lastReanchors = event.reanchors;
          setStatus(event);
          break;
        }
        case "log":
          setLogs((prev) => {
            const next = prev.length >= LOG_MEMORY ? prev.slice(1) : prev.slice();
            next.push({ id: id++, level: event.level, msg: event.msg, at: clockTime() });
            return next;
          });
          break;
      }
    });
  }, [subscribe]);

  useInput(
    (input, key) => {
      const k = input.toLowerCase();

      if (k === "q" || (key.ctrl && input === "c")) {
        setStopping(true);
        onQuit();
        return;
      }

      // Muting the host is a listening decision, not a transport one: the
      // capture, the encode and every phone carry on untouched.
      if (k === "m") {
        const next = (status?.localGain ?? 1) > 0 ? 0 : 1;
        send({ c: "localGain", v: next });
        return;
      }
      if (input === "+" || input === "=") {
        send({ c: "localGain", v: Math.min(1, (status?.localGain ?? 1) + 0.1) });
        return;
      }
      if (input === "-" || input === "_") {
        send({ c: "localGain", v: Math.max(0, (status?.localGain ?? 1) - 0.1) });
        return;
      }

      // Source picking. `s` opens the list; a digit chooses; escape closes.
      if (k === "s") {
        send({ c: "sources" });
        setPicking((p) => !p);
        return;
      }
      if (picking) {
        if (key.escape) {
          setPicking(false);
          return;
        }
        if (k === "a") {
          send({ c: "source", mode: "system" });
          setPicking(false);
          return;
        }
        const index = Number.parseInt(input, 10);
        if (Number.isInteger(index) && index >= 1 && index <= sources.length) {
          const chosen = sources[index - 1];
          send({ c: "source", pid: chosen.pid, label: chosen.name });
          setPicking(false);
        }
      }
    },
    { isActive: Boolean(isRawModeSupported) },
  );

  useEffect(() => {
    if (coreExited) {
      const timer = setTimeout(() => exit(), 900);
      return () => clearTimeout(timer);
    }
    return undefined;
  }, [coreExited, exit]);

  const modules = room?.qr.length ?? 0;
  const layout = useMemo(
    () => planLayout(size.cols, size.rows, modules, members.length),
    [size.cols, size.rows, modules, members.length],
  );

  const phase = derivePhase({ config, room, status, members, alerts: alerts.current, coreExited, stopping });

  return (
    <Box flexDirection="column" width={size.cols} height={size.rows} overflow="hidden">
      <Header layout={layout} config={config} phase={phase} status={status} members={members} />
      <Box paddingX={1} height={layout.contentH} overflow="hidden">
        {layout.stacked ? (
          <Stacked layout={layout} room={room} config={config} status={status} members={members} logs={logs} levels={levels.current} phase={phase} picking={picking} sources={sources} />
        ) : (
          <Wide layout={layout} room={room} config={config} status={status} members={members} logs={logs} levels={levels.current} phase={phase} picking={picking} sources={sources} />
        )}
      </Box>
      <Footer
        layout={layout}
        phase={phase}
        room={room}
        stopping={stopping}
        coreExited={coreExited}
        muted={(status?.localGain ?? 1) === 0}
        gain={status?.localGain ?? 1}
        source={status?.source ?? config?.source ?? null}
      />
    </Box>
  );
}

// ---------------------------------------------------------------- structure

interface BodyProps {
  layout: Layout;
  room: RoomEvent | null;
  config: ConfigEvent | null;
  status: StatusEvent | null;
  members: Member[];
  logs: LogLine[];
  levels: number[];
  phase: Phase;
  /** True while the source picker has borrowed the log panel. */
  picking: boolean;
  sources: SourcesEvent["list"];
}

function Wide(props: BodyProps) {
  const { layout } = props;
  return (
    <Box flexDirection="row" width={layout.bodyW} height={layout.contentH}>
      <Box
        flexDirection="column"
        width={layout.leftW}
        height={layout.contentH}
        overflow="hidden"
        // On a tall terminal the capture settings sit on the floor of the card
        // rather than leaving a block of dead space beneath them.
        justifyContent={
          layout.join.config && layout.contentH - layout.join.height >= 2
            ? "space-between"
            : "flex-start"
        }
      >
        <JoinCard {...props} width={layout.leftW} />
      </Box>
      <Box width={GUTTER} />
      <Box flexDirection="column" width={layout.rightW} height={layout.contentH} overflow="hidden">
        {sections(props, layout.rightW)}
      </Box>
    </Box>
  );
}

function Stacked(props: BodyProps) {
  const { layout } = props;
  return (
    <Box flexDirection="column" width={layout.bodyW} height={layout.contentH} overflow="hidden">
      <Box flexDirection="column" alignItems="center" width={layout.bodyW}>
        <Box flexDirection="column" width={layout.join.width}>
          <JoinCard {...props} width={layout.join.width} />
        </Box>
      </Box>
      <Text> </Text>
      {sections(props, layout.bodyW)}
    </Box>
  );
}

/**
 * Scope, devices, telemetry and log, with exactly one blank row between the
 * sections that survived the layout's budget.
 */
function sections(props: BodyProps, width: number): ReactNode {
  const { layout, status, members, logs, levels, phase, picking, sources } = props;
  const blocks: ReactNode[] = [];

  if (layout.scope > 0) {
    const peak = status ? `${num(status.peakDb, 6, 1)} dBFS` : "     — dBFS";
    blocks.push(
      <Box flexDirection="column" key="scope">
        <Rule title="Level" right={peak} rightColor={peakColor(status?.peakDb)} width={width} />
        <Scope values={levels} width={width} height={layout.scope} />
      </Box>,
    );
  }

  if (layout.devices > 0) {
    const count = members.length;
    blocks.push(
      <Box flexDirection="column" key="devices">
        <Rule
          title="Speakers"
          right={count === 0 ? "none" : count === 1 ? "1 connected" : `${count} connected`}
          rightColor={count === 0 ? C.dim : C.lock}
          width={width}
        />
        <Devices members={members} width={width} rows={layout.devices} />
      </Box>,
    );
  }

  if (layout.telemetry > 0) {
    blocks.push(
      <Box flexDirection="column" key="telemetry">
        <Rule title="Telemetry" right={phase.offline ? "offline" : undefined} width={width} />
        <Telemetry stats={telemetryStats(props)} width={width} columns={layout.statColumns} rows={layout.telemetry} />
      </Box>,
    );
  }

  if (layout.log > 0) {
    blocks.push(
      <Box flexDirection="column" key="log">
        <Rule title={picking ? "Source" : "Log"} width={width} />
        {picking ? (
          <SourcePicker sources={sources} current={status?.source ?? null} width={width} />
        ) : (
          <LogView lines={logs} width={width} rows={layout.log} />
        )}
      </Box>,
    );
  }

  const out: ReactNode[] = [];
  blocks.forEach((block, i) => {
    if (i > 0) out.push(<Text key={`gap-${i}`}> </Text>);
    out.push(block);
  });
  return out;
}

/** QR, room code, address and what is being captured. */
function JoinCard({ layout, room, config, width }: BodyProps & { width: number }) {
  const plan = layout.join;
  const code = room?.code ?? "······";
  const host = room?.host ?? (config?.offline ? "offline — this Mac only" : "…");

  return (
    <>
      <Box flexDirection="column">
      {plan.rule ? <Rule title="Join" width={width} /> : null}
      {plan.qr && room ? <QrCode rows={room.qr} quiet={plan.qr.quiet} /> : null}
      {plan.gap ? <Text> </Text> : null}
      {plan.big ? (
        <BigCode text={code} scale={plan.bigScale} />
      ) : (
        <Text wrap="truncate-end">
          <Text color={C.pulse} bold>
            {code}
          </Text>
          {plan.combined ? (
            <>
              <Text color={C.rule}>{"  " + G.dot + "  "}</Text>
              <Text color={C.muted}>{truncate(host, Math.max(0, width - code.length - 5))}</Text>
            </>
          ) : null}
        </Text>
      )}
      {!plan.combined ? (
        <Text color={C.muted} wrap="truncate-end">
          {truncate(host, width)}
        </Text>
      ) : null}
      </Box>
      {plan.config ? (
        <Box flexDirection="column">
          <Text> </Text>
          <Rule title="Source" width={width} />
          <Field
            label="Capturing"
            value={config ? `${config.source}` : "—"}
            width={width}
            color={C.ink}
          />
          <Field
            label="Format"
            value={config ? `${Math.round(config.sampleRate / 1000)} kHz ${G.dot} ${config.channels === 2 ? "Stereo" : `${config.channels} channels`}` : "—"}
            width={width}
            color={C.muted}
          />
          <Field
            label="Monitor"
            value={
              config
                ? `${config.muted ? "muted" : "audible"}${config.local ? ` ${G.dot} playing along` : ""}`
                : "—"
            }
            width={width}
            color={C.muted}
          />
        </Box>
      ) : null}
    </>
  );
}

// -------------------------------------------------------------------- chrome

function Header({
  layout,
  config,
  phase,
  status,
  members,
}: {
  layout: Layout;
  config: ConfigEvent | null;
  phase: Phase;
  status: StatusEvent | null;
  members: Member[];
}) {
  const uptime = duration(status?.uptimeSec ?? 0);
  const count = members.length;
  const devices = count === 1 ? "1 DEVICE" : `${count} DEVICES`;
  const right = `${phase.glyph} ${phase.label}`;
  const rightWidth = right.length + 3 + devices.length + 3 + uptime.length;
  const brand = `${G.brand}DOWNBEAT`;
  const room = layout.cols - 2 - brand.length - rightWidth - 3;
  const source = config ? `${config.source}${config.offline ? " · offline" : ""}` : "startet…";

  return (
    <Box width={layout.cols} paddingX={1} justifyContent="space-between">
      <Text wrap="truncate-end">
        <Text color={C.pulse} bold>
          {brand}
        </Text>
        {room > 4 ? (
          <>
            <Text color={C.rule}>{"   "}</Text>
            <Text color={C.muted}>{truncate(source, room)}</Text>
          </>
        ) : null}
      </Text>
      <Text wrap="truncate-end">
        <Text color={phase.color} bold>
          {right}
        </Text>
        <Text color={C.rule}>{"   "}</Text>
        <Text color={count > 0 ? C.ink : C.dim}>{devices}</Text>
        <Text color={C.rule}>{"   "}</Text>
        <Text color={C.muted}>{uptime}</Text>
      </Text>
    </Box>
  );
}

function Footer({
  layout,
  phase,
  room,
  stopping,
  coreExited,
  muted,
  gain,
  source,
}: {
  layout: Layout;
  phase: Phase;
  room: RoomEvent | null;
  stopping: boolean;
  coreExited: { code: number | null; reason: string } | null;
  muted: boolean;
  gain: number;
  source: string | null;
}) {
  const note = coreExited
    ? `engine exited ${G.dot} ${coreExited.reason}`
    : stopping
      ? "stopping — the source becomes audible again…"
      : (phase.note ?? room?.url ?? "");

  // Keys first: they are the only thing here the reader can act on.
  const keys: Array<[string, string]> = [
    ["q", "quit"],
    ["m", muted ? "unmute" : "mute"],
    ["s", "source"],
    ["±", `${Math.round(gain * 100)}%`],
  ];
  const keyWidth = keys.reduce((n, [k, l]) => n + k.length + l.length + 3, 0);
  const space = layout.cols - 2 - keyWidth - 2;

  return (
    <Box width={layout.cols} paddingX={1} justifyContent="space-between">
      <Text wrap="truncate-end">
        {keys.map(([key, label], i) => (
          <Text key={key}>
            {i > 0 ? "  " : ""}
            <Text bold>{key}</Text>
            <Text dimColor>{" " + label}</Text>
          </Text>
        ))}
      </Text>
      <Text dimColor={!muted} bold={muted} wrap="truncate-end">
        {truncate(muted ? `${G.stop} host muted ${G.dot} ${note}` : (source ? `${source} ${G.dot} ${note}` : note),
                  Math.max(0, space))}
      </Text>
    </Box>
  );
}

/**
 * The source picker, opened with `s`.
 *
 * Overlaid on the log rather than in a panel of its own: it is transient, and
 * a layout that reflows every time someone glances at the source list is worse
 * than one that briefly borrows a panel.
 */
function SourcePicker({
  sources,
  current,
  width,
}: {
  sources: SourcesEvent["list"];
  current: string | null;
  width: number;
}) {
  return (
    <Box flexDirection="column" width={width}>
      <Text bold>{"CHOOSE SOURCE"}</Text>
      <Text dimColor>{`a  everything this Mac plays${current ? `   (now: ${current})` : ""}`}</Text>
      {sources.length === 0 ? (
        <Text dimColor>{"  no app found — is anything playing?"}</Text>
      ) : (
        sources.slice(0, 8).map((src, i) => (
          <Text key={src.pid}>
            <Text bold>{String(i + 1)}</Text>
            <Text dimColor>{"  "}</Text>
            <Text bold={src.active}>{truncate(src.name, Math.max(8, width - 12))}</Text>
            <Text dimColor>{src.active ? "  playing" : ""}</Text>
          </Text>
        ))
      )}
      <Text dimColor>{"esc  cancel"}</Text>
    </Box>
  );
}

// --------------------------------------------------------------------- state

export interface Phase {
  key: "starting" | "waiting" | "connecting" | "synced" | "degraded" | "stopping" | "exited";
  label: string;
  glyph: string;
  color: string | undefined;
  note?: string;
  noteColor?: string | undefined;
  offline: boolean;
}

/**
 * The one line that says how the party is doing.
 *
 * `starved` climbs while the local player primes its buffer and that is not a
 * fault, so it only counts against the session once enough audio has been
 * captured for priming to be over -- and then only for a few seconds after it
 * last moved, so one hiccup does not brand the rest of the evening.
 */
function derivePhase(input: {
  config: ConfigEvent | null;
  room: RoomEvent | null;
  status: StatusEvent | null;
  members: Member[];
  alerts: { starvedAt: number; reanchorAt: number };
  coreExited: { code: number | null; reason: string } | null;
  stopping: boolean;
}): Phase {
  const { config, room, status, members, alerts, coreExited, stopping } = input;
  const offline = config?.offline ?? false;

  if (coreExited) {
    return {
      key: "exited",
      label: "EXITED",
      glyph: G.stop,
      color: C.alarm,
      note: `engine exited ${G.dot} ${coreExited.reason}`,
      noteColor: C.alarm,
      offline,
    };
  }
  if (stopping) {
    return { key: "stopping", label: "STOPPING", glyph: G.stop, color: C.warn, offline };
  }
  if (!config || !status || (!room && !offline)) {
    return { key: "starting", label: "STARTING", glyph: G.idle, color: C.dim, offline };
  }

  const now = Date.now();
  const primed = status.capturedSec > PRIMED_SEC;
  const starving = now - alerts.starvedAt < ALERT_MS;
  const reanchoring = now - alerts.reanchorAt < ALERT_MS;
  const badDevice = members.some((m) => deviceState(m).bad);

  if (primed && (starving || reanchoring || (!status.synced && !offline) || badDevice)) {
    const note = starving
      ? "buffer running dry — the source is not keeping up"
      : reanchoring
        ? "clock re-anchored — playback was pulled back into step"
        : !status.synced
          ? "no clock sync with the room"
          : "a speaker is out of step";
    return {
      key: "degraded",
      label: "DEGRADED",
      glyph: G.warnMark,
      color: C.warn,
      note,
      noteColor: C.warn,
      offline,
    };
  }

  if (offline) {
    return { key: "synced", label: "LOCAL", glyph: G.locked, color: C.pulse, note: "offline — this Mac only", offline };
  }
  if (!status.synced || !primed) {
    return { key: "connecting", label: "CONNECTING", glyph: G.waiting, color: C.warn, note: "measuring the clock…", offline };
  }
  if (!members.length) {
    return {
      key: "waiting",
      label: "READY",
      glyph: G.waiting,
      color: C.pulse,
      note: room?.url,
      noteColor: C.muted,
      offline,
    };
  }
  return { key: "synced", label: "IN SYNC", glyph: G.locked, color: C.lock, note: room?.url, noteColor: C.muted, offline };
}

function telemetryStats({ status, config, phase }: BodyProps): Stat[] {
  const clockOk = status?.synced && !phase.offline;
  const stats: Stat[] = [
    {
      label: "CLOCK",
      value: status ? `±${ms(status.clockMs, 4).trim()}` : "—",
      color: phase.offline ? C.dim : clockOk ? C.lock : C.warn,
    },
    { label: "BITRATE", value: status ? `${num(status.kbits, 3)} kbit/s` : "—" },
    { label: "PACKETS", value: status ? group(status.packets) : "—" },
    { label: "CAPTURED", value: status ? `${num(status.capturedSec, 5, 1)} s` : "—" },
    {
      label: "BUFFER",
      value: status?.bufferMs !== undefined
        ? `${Math.round(status.bufferMs)} ms`
        : config
          ? `${config.bufferMs} ms`
          : "—",
      color: C.muted,
    },
    {
      label: "UNDERRUN",
      value: status ? group(status.starved) : "—",
      color: phase.key === "degraded" ? C.warn : C.muted,
    },
  ];
  if (status && status.reanchors > 0) {
    stats.splice(4, 0, { label: "RESYNC", value: group(status.reanchors), color: C.warn });
  }
  return stats;
}

function peakColor(db: number | undefined): string | undefined {
  if (db === undefined) return C.dim;
  if (db > -1.5) return C.alarm;
  if (db > -6) return C.warn;
  if (db < -55) return C.dim;
  return C.ink;
}

// --------------------------------------------------------------------- input

/**
 * The terminal's size, kept current across SIGWINCH.
 *
 * Ink re-measures its own layout on resize but does not re-render the React
 * tree, so a component that reads `stdout.columns` while rendering keeps
 * whatever the terminal was when it mounted. Turning the resize into state is
 * what actually makes the app reflow.
 */
function useTerminalSize(): { cols: number; rows: number } {
  const { stdout } = useStdout();
  const [size, setSize] = useState(() => ({
    cols: stdout?.columns ?? 80,
    rows: stdout?.rows ?? 24,
  }));

  useEffect(() => {
    if (!stdout) return undefined;
    const onResize = () => setSize({ cols: stdout.columns, rows: stdout.rows });
    onResize();
    stdout.on("resize", onResize);
    return () => {
      stdout.off("resize", onResize);
    };
  }, [stdout]);

  return size;
}

/**
 * Fold one status event's worth of 10 ms peaks into a fixed number of columns.
 *
 * The core sends whatever accumulated since the last tick -- around nineteen
 * values, but fifty on the first event while capture spins up. Appending them
 * raw makes the waveform lurch a third of the panel on one frame and crawl on
 * the next; reducing every tick to the same count makes it scroll at one
 * steady rate, and taking the peak of each group keeps transients visible.
 */
function pushLevels(history: number[], incoming: number[] | undefined) {
  const src = incoming?.length ? incoming : [-120];
  for (let i = 0; i < COLS_PER_TICK; i++) {
    const from = Math.floor((i * src.length) / COLS_PER_TICK);
    const to = Math.max(from + 1, Math.floor(((i + 1) * src.length) / COLS_PER_TICK));
    let peak = -120;
    for (let j = from; j < to && j < src.length; j++) {
      if (src[j] > peak) peak = src[j];
    }
    history.push(peak);
  }
  if (history.length > SCOPE_MEMORY) history.splice(0, history.length - SCOPE_MEMORY);
}
