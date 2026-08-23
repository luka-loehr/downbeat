import { useRef } from "react";
import { Box, Text } from "ink";
import { C, clamp } from "./theme.js";

/**
 * The capture level, scrolling right to left.
 *
 * The core hands out one peak per ~10 ms of audio, which is far finer than a
 * terminal can usefully scroll, so the App folds each 200 ms status event into
 * a fixed handful of columns before they land here. Drawing them mirrored
 * around a centre line with half-blocks gives two sub-rows per terminal row --
 * sixteen steps in an eight-row panel -- which is enough resolution that music
 * reads as a waveform rather than a bar chart.
 *
 * Height is linear amplitude against a slow automatic gain, the way any
 * waveform overview is drawn: mastered music sits inside a three-decibel band
 * around -11 dBFS, and any absolute dB scale paints that as one solid block.
 * Loudness is not lost -- it is in the colour, which stays on an absolute
 * scale, and in the peak reading above the panel.
 */

/** Below this a column is silence and is not drawn. */
const FLOOR_DB = -72;
/** Ceiling on the automatic gain, so quiet material still reads as quiet. */
const MAX_GAIN = 8;
/** How fast the gain recovers after a transient scrolls off the left edge. */
const RELEASE = 0.1;
/**
 * Slight expansion after the gain.
 *
 * Mastered music spends its life within three decibels of its own peak; a
 * straight normalisation draws that as a slab with frayed edges. Raising the
 * normalised amplitude to this power spreads the top of the range back out
 * without touching where silence sits.
 */
const SHAPE = 1.6;

/** Old to new, so the eye lands on the right edge without extra chrome. */
const TRAIL = ["#6d2d10", "#8f3a14", "#b14719", "#d3541d", "#f05a1e", C.pulse];

/**
 * Deliberately not memoised: `values` is the App's history ref, appended to in
 * place, so its identity never changes and a shallow prop comparison would
 * freeze the waveform on whatever it held at mount.
 */
export function Scope({
  values,
  width,
  height,
}: {
  values: number[];
  width: number;
  height: number;
}) {
  const gain = useRef(1);
  if (width < 1 || height < 1) return null;

  const cols: Array<{ db: number; linear: number }> = [];
  // Newest at the right edge. A history shorter than the panel is padded on
  // the old side, so the first seconds grow out of the left instead of sliding
  // in from it once the buffer finally fills.
  for (let i = values.length - width; i < values.length; i++) {
    const db = i < 0 ? -120 : values[i];
    cols.push({ db, linear: db <= FLOOR_DB ? 0 : Math.pow(10, db / 20) });
  }

  let peak = 0;
  for (const c of cols) if (c.linear > peak) peak = c.linear;
  const target = peak > 0 ? clamp(1 / peak, 1, MAX_GAIN) : 1;
  // Fast down, slow up: a loud passage must not clip the display for a frame,
  // but the panel must not visibly breathe every time one scrolls away.
  gain.current = target < gain.current ? target : gain.current + (target - gain.current) * RELEASE;

  const centre = height;
  const lines: Array<Array<{ text: string; color: string }>> = [];

  for (let row = 0; row < height; row++) {
    const segments: Array<{ text: string; color: string }> = [];
    for (let x = 0; x < width; x++) {
      const { db, linear } = cols[x];
      // Always at least half a sub-row, so silence reads as a centre axis
      // rather than as an empty panel.
      const extent = Math.max(0.5, Math.pow(clamp(linear * gain.current, 0, 1), SHAPE) * height);
      const upper = Math.abs(row * 2 + 0.5 - centre) <= extent;
      const lower = Math.abs(row * 2 + 1.5 - centre) <= extent;
      const char = upper && lower ? "█" : upper ? "▀" : lower ? "▄" : " ";
      const color = char === " " ? C.rule : tone(db, x / Math.max(1, width - 1));
      const last = segments[segments.length - 1];
      if (last && last.color === color && last.text[0] === char) last.text += char;
      else segments.push({ text: char, color });
    }
    lines.push(segments);
  }

  return (
    <Box flexDirection="column">
      {lines.map((segments, y) => (
        <Text key={y}>
          {segments.map((s, i) => (
            <Text key={i} color={s.color}>
              {s.text}
            </Text>
          ))}
        </Text>
      ))}
    </Box>
  );
}

/** Colour stays absolute: this is the part that says how hot the source is. */
function tone(db: number, age: number): string {
  if (db > -1.5) return C.alarm;
  if (db > -6) return C.warn;
  if (db <= FLOOR_DB + 2) return C.rule;
  return TRAIL[Math.min(TRAIL.length - 1, Math.floor(age * TRAIL.length))];
}
