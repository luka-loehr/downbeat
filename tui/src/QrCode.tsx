import React, { useMemo } from "react";
import { Box, Text } from "ink";
import { C } from "./theme.js";

/**
 * A QR code drawn with half-blocks, black on white, always.
 *
 * Two details decide whether a phone can read it off a laptop screen. Each
 * character carries two module rows via "▀" -- the foreground paints the upper
 * half, the background the lower -- because a code drawn one terminal row per
 * module comes out twice as tall as it is wide and scans poorly. And the
 * colours are written as hex triplets instead of the named ANSI black and
 * white: named colours are whatever the user's theme says they are, and a code
 * rendered in slate on cream is one most scanners refuse.
 *
 * The white quiet zone is part of the code, not padding around it -- a QR with
 * a dark terminal touching its edge is a QR that does not decode.
 */
export const QrCode = React.memo(function QrCode({
  rows,
  quiet,
}: {
  rows: string[];
  quiet: number;
}) {
  const lines = useMemo(() => build(rows, quiet), [rows, quiet]);
  if (!lines.length) return null;

  return (
    <Box flexDirection="column">
      {lines.map((segments, y) => (
        <Text key={y}>
          {segments.map((s, i) => (
            <Text
              key={i}
              color={s.top ? C.black : C.white}
              backgroundColor={s.bottom ? C.black : C.white}
            >
              {"▀".repeat(s.run)}
            </Text>
          ))}
        </Text>
      ))}
    </Box>
  );
});

interface Run {
  top: boolean;
  bottom: boolean;
  run: number;
}

function build(rows: string[], quiet: number): Run[][] {
  if (!rows.length) return [];
  const width = rows[0].length + quiet * 2;
  const blank = "0".repeat(width);
  const pad = "0".repeat(quiet);
  const grid = [
    ...Array.from({ length: quiet }, () => blank),
    ...rows.map((r) => pad + r + pad),
    ...Array.from({ length: quiet }, () => blank),
  ];
  // An odd number of module rows would leave the last half-block half-drawn;
  // one more row of quiet zone is both the fix and an improvement.
  if (grid.length % 2 === 1) grid.push(blank);

  const out: Run[][] = [];
  for (let y = 0; y < grid.length; y += 2) {
    const segments: Run[] = [];
    for (let x = 0; x < width; x++) {
      const top = grid[y][x] === "1";
      const bottom = grid[y + 1][x] === "1";
      const last = segments[segments.length - 1];
      // Runs, not one element per module: a 43-wide code is 946 cells, and Ink
      // reconciles every one of them on each render otherwise.
      if (last && last.top === top && last.bottom === bottom) last.run++;
      else segments.push({ top, bottom, run: 1 });
    }
    out.push(segments);
  }
  return out;
}
