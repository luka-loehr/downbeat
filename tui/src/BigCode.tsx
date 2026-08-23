import React from "react";
import { Box, Text } from "ink";
import { C } from "./theme.js";

/**
 * The room code as block letters.
 *
 * Six characters read out across a room deserve to be the largest thing on the
 * screen after the QR, and on a terminal too small for a QR they are the only
 * way in. A 4x5 bitmap is smaller and more predictable than a figlet
 * dependency, and it lets the glyphs be coloured and scaled to the exact width
 * the layout has left over.
 *
 * Codes come from an alphabet with I, L, O and U removed so nothing can be
 * misheard as a digit; those four are drawn anyway so a hand-typed code never
 * renders as blanks.
 */
const FONT: Record<string, string[]> = {
  "0": [".##.", "#..#", "#..#", "#..#", ".##."],
  "1": ["..#.", ".##.", "..#.", "..#.", ".###"],
  "2": ["###.", "...#", ".##.", "#...", "####"],
  "3": ["###.", "...#", ".##.", "...#", "###."],
  "4": ["#..#", "#..#", "####", "...#", "...#"],
  "5": ["####", "#...", "###.", "...#", "###."],
  "6": [".###", "#...", "###.", "#..#", ".##."],
  "7": ["####", "...#", "..#.", ".#..", ".#.."],
  "8": [".##.", "#..#", ".##.", "#..#", ".##."],
  "9": [".##.", "#..#", ".###", "...#", "###."],
  A: [".##.", "#..#", "####", "#..#", "#..#"],
  B: ["###.", "#..#", "###.", "#..#", "###."],
  C: [".###", "#...", "#...", "#...", ".###"],
  D: ["###.", "#..#", "#..#", "#..#", "###."],
  E: ["####", "#...", "###.", "#...", "####"],
  F: ["####", "#...", "###.", "#...", "#..."],
  G: [".###", "#...", "#.##", "#..#", ".###"],
  H: ["#..#", "#..#", "####", "#..#", "#..#"],
  I: ["###.", ".#..", ".#..", ".#..", "###."],
  J: ["..##", "...#", "...#", "#..#", ".##."],
  K: ["#..#", "#.#.", "##..", "#.#.", "#..#"],
  L: ["#...", "#...", "#...", "#...", "####"],
  M: ["#..#", "####", "#..#", "#..#", "#..#"],
  N: ["#..#", "##.#", "#.##", "#..#", "#..#"],
  O: [".##.", "#..#", "#..#", "#..#", ".##."],
  P: ["###.", "#..#", "###.", "#...", "#..."],
  Q: [".##.", "#..#", "#..#", "#.#.", ".#.#"],
  R: ["###.", "#..#", "###.", "#.#.", "#..#"],
  S: [".###", "#...", ".##.", "...#", "###."],
  T: ["####", ".#..", ".#..", ".#..", ".#.."],
  U: ["#..#", "#..#", "#..#", "#..#", ".##."],
  V: ["#..#", "#..#", "#..#", "#..#", ".##."],
  W: ["#..#", "#..#", "#..#", "####", "#..#"],
  X: ["#..#", "#..#", ".##.", "#..#", "#..#"],
  Y: ["#..#", "#..#", ".##.", ".#..", ".#.."],
  Z: ["####", "...#", ".##.", "#...", "####"],
  "-": ["....", "....", "####", "....", "...."],
  " ": ["....", "....", "....", "....", "...."],
};

export const BANNER_ROWS = 5;

export function bannerWidth(text: string, scale: number): number {
  return text.length * (4 * scale + scale) - scale;
}

export const BigCode = React.memo(function BigCode({
  text,
  scale = 1,
  color = C.pulse,
}: {
  text: string;
  scale?: number;
  color?: string;
}) {
  const chars = [...text.toUpperCase()].map((ch) => FONT[ch] ?? FONT["-"]);
  const lines: string[] = [];
  for (let row = 0; row < BANNER_ROWS; row++) {
    let line = "";
    for (let i = 0; i < chars.length; i++) {
      if (i > 0) line += " ".repeat(scale);
      for (const px of chars[i][row]) line += (px === "#" ? "█" : " ").repeat(scale);
    }
    lines.push(line);
  }
  return (
    <Box flexDirection="column">
      {lines.map((line, i) => (
        <Text key={i} color={color}>
          {line}
        </Text>
      ))}
    </Box>
  );
});
