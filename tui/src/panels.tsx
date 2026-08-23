import React from "react";
import { Box, Text } from "ink";
import { C, G, clamp, num, padEnd, padStart, truncate } from "./theme.js";
import type { Member } from "./events.js";

/**
 * A section heading: a label, a rule to the width of the column, and an
 * optional reading pinned to the right.
 *
 * Panels are separated by these rather than by boxes. Two border rows per
 * section is four rows of the eight a device list gets on an 80x24 terminal,
 * and a labelled rule reads as deliberate at every size where a box would have
 * to be dropped.
 */
export function Rule({
  title,
  right,
  rightColor = C.muted,
  width,
}: {
  title: string;
  right?: string;
  rightColor?: string;
  width: number;
}) {
  const label = title.toUpperCase();
  const tail = right ?? "";
  const fill = width - label.length - tail.length - (tail ? 2 : 1);
  return (
    <Text wrap="truncate-end">
      <Text color={C.ink} bold>
        {label}
      </Text>
      <Text color={C.rule}>
        {" " + G.ruleH.repeat(Math.max(1, fill)) + (tail ? " " : "")}
      </Text>
      {tail ? <Text color={rightColor}>{tail}</Text> : null}
    </Text>
  );
}

export interface DeviceState {
  glyph: string;
  label: string;
  color: string;
  bad: boolean;
}

/**
 * How a single speaker is doing.
 *
 * `rtt` and `sync` both sitting at zero means the client has connected but has
 * not sent telemetry yet, which is a normal first second and not a fault.
 */
export function deviceState(m: Member): DeviceState {
  if (m.startError !== null && Math.abs(m.startError) > 20)
    return { glyph: G.warnMark, label: "Start " + m.startError.toFixed(0) + " ms", color: C.alarm, bad: true };
  if (m.rtt === 0 && m.sync === 0)
    return { glyph: G.idle, label: "verbindet", color: C.dim, bad: false };
  if (m.sync > 25 || m.rtt > 400)
    return { glyph: G.warnMark, label: "Sync schlecht", color: C.alarm, bad: true };
  if (m.sync > 12 || m.rtt > 200)
    return { glyph: G.warnMark, label: "Sync schwach", color: C.warn, bad: true };
  if (m.readyFor) return { glyph: G.locked, label: "geladen", color: C.lock, bad: false };
  return { glyph: G.locked, label: "bereit", color: C.lock, bad: false };
}

/**
 * One row per speaker.
 *
 * Columns are dropped from the least useful inwards as the panel narrows, so
 * the name and the sync verdict survive down to a 26-column list rather than
 * every column being squeezed into something unreadable.
 */
export function Devices({
  members,
  width,
  rows,
}: {
  members: Member[];
  width: number;
  rows: number;
}) {
  const tier = width >= 52 ? 3 : width >= 40 ? 2 : width >= 26 ? 1 : 0;
  const W_ID = 8;
  const W_RTT = 7;
  const W_SYNC = 9;
  const W_STATE = tier >= 3 ? 15 : 14;

  const fixed =
    (tier >= 3 ? W_ID + 1 : 0) +
    (tier >= 2 ? W_RTT + 1 : 0) +
    (tier >= 1 ? W_SYNC + 1 : 0) +
    (tier >= 1 ? W_STATE + 1 : 2);
  const nameW = Math.max(6, width - fixed);

  const header = (
    <Text wrap="truncate-end">
      <Text color={C.dim}>{padEnd("GERÄT", nameW)} </Text>
      {tier >= 3 ? <Text color={C.dim}>{padEnd("ID", W_ID)} </Text> : null}
      {tier >= 2 ? <Text color={C.dim}>{padStart("RTT", W_RTT)} </Text> : null}
      {tier >= 1 ? <Text color={C.dim}>{padStart("SYNC", W_SYNC)} </Text> : null}
      {tier >= 1 ? <Text color={C.dim}>{padEnd("STATUS", W_STATE)}</Text> : null}
    </Text>
  );

  const body: React.ReactNode[] = [];

  if (!members.length) {
    body.push(
      <Text key="empty" color={C.dim} wrap="truncate-end">
        {G.idle + "  warte auf Scans"}
      </Text>,
    );
    if (rows > 1) {
      body.push(
        <Text key="hint" color={C.rule} wrap="truncate-end">
          {"   QR scannen oder " + G.arrow + " Code eingeben"}
        </Text>,
      );
    }
  } else {
    // The core forwards the room's member list in whatever order the sockets
    // happen to sit in, which changes between snapshots; sorting by id keeps a
    // row from moving out from under the reader's eye.
    const sorted = members.slice().sort((a, b) => a.id.localeCompare(b.id));
    const room = sorted.length > rows ? rows - 1 : rows;
    for (const m of sorted.slice(0, room)) {
      const state = deviceState(m);
      body.push(
        <Text key={m.id} wrap="truncate-end">
          <Text color={state.bad ? C.warn : C.ink}>{padEnd(m.name, nameW)} </Text>
          {tier >= 3 ? <Text color={C.dim}>{padEnd(m.id.slice(0, W_ID), W_ID)} </Text> : null}
          {tier >= 2 ? (
            <Text color={C.muted}>{padStart(m.rtt ? `${Math.round(m.rtt)} ms` : "—", W_RTT)} </Text>
          ) : null}
          {tier >= 1 ? (
            <Text color={state.bad ? C.warn : C.muted}>
              {padStart(m.sync ? `±${m.sync.toFixed(1)} ms` : "—", W_SYNC)}{" "}
            </Text>
          ) : null}
          <Text color={state.color}>
            {tier >= 1 ? padEnd(`${state.glyph} ${state.label}`, W_STATE) : state.glyph}
          </Text>
        </Text>,
      );
    }
    if (sorted.length > rows) {
      body.push(
        <Text key="more" color={C.dim} wrap="truncate-end">
          {`+ ${sorted.length - room} weitere`}
        </Text>,
      );
    }
  }

  // The section was handed an exact number of rows; short-changing them would
  // let the next section slide up and the whole column drift.
  while (body.length < rows) body.push(<Text key={`pad-${body.length}`}> </Text>);

  return (
    <Box flexDirection="column">
      {header}
      {body.slice(0, rows)}
    </Box>
  );
}

export interface Stat {
  label: string;
  value: string;
  color?: string;
}

/** Label/value pairs laid into as many columns as the width honestly allows. */
export function Telemetry({
  stats,
  width,
  columns,
  rows,
}: {
  stats: Stat[];
  width: number;
  columns: number;
  rows: number;
}) {
  const cols = clamp(columns, 1, 3);
  const cellW = Math.floor(width / cols);
  const labelW = Math.min(11, Math.max(6, Math.floor(cellW * 0.5)));
  const valueW = cellW - labelW - 2;

  const lines: Stat[][] = [];
  for (let r = 0; r < rows; r++) lines.push(stats.slice(r * cols, r * cols + cols));

  return (
    <Box flexDirection="column">
      {lines.map((line, r) => (
        <Text key={r} wrap="truncate-end">
          {line.length ? null : " "}
          {line.map((s, i) => (
            <Text key={i}>
              <Text color={C.dim}>{padEnd(s.label, labelW)}</Text>
              <Text color={s.color ?? C.ink}>{padStart(truncate(s.value, valueW), valueW)}</Text>
              <Text>{"  "}</Text>
            </Text>
          ))}
        </Text>
      ))}
    </Box>
  );
}

export interface LogLine {
  id: number;
  level: string;
  msg: string;
  at: string;
}

export function LogView({ lines, width, rows }: { lines: LogLine[]; width: number; rows: number }) {
  const shown = lines.slice(-rows);
  const blanks = Math.max(0, rows - shown.length);
  return (
    <Box flexDirection="column">
      {Array.from({ length: blanks }, (_, i) => (
        <Text key={`blank-${i}`}> </Text>
      ))}
      {shown.map((line) => (
        <Text key={line.id} wrap="truncate-end">
          <Text color={C.dim}>{line.at} </Text>
          <Text color={levelColor(line.level)}>{truncate(line.msg, Math.max(4, width - 9))}</Text>
        </Text>
      ))}
    </Box>
  );
}

function levelColor(level: string): string {
  return level === "error" ? C.alarm : level === "warn" ? C.warn : C.muted;
}

/** A short label/value line for the join card's capture settings. */
export function Field({
  label,
  value,
  width,
  color = C.ink,
}: {
  label: string;
  value: string;
  width: number;
  color?: string;
}) {
  const labelW = 9;
  return (
    <Text wrap="truncate-end">
      <Text color={C.dim}>{padEnd(label, labelW)}</Text>
      <Text color={color}>{truncate(value, Math.max(4, width - labelW))}</Text>
    </Text>
  );
}

/** Fixed-width millisecond reading; the decimal point never moves. */
export function ms(value: number, width = 5): string {
  return num(value, width, 1) + " ms";
}
