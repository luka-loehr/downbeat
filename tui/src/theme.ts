/**
 * The palette, lifted from the web app's tokens so the terminal and the phone
 * screen read as one product.
 *
 * Every colour is stated as a hex triplet rather than a named ANSI colour:
 * named colours are remapped by the user's terminal theme, and "black on
 * white" that turns out to be "slate on cream" is a QR code no phone will
 * read.
 */
/**
 * Monochrome, and deliberately so.
 *
 * Almost nothing here names a colour. A terminal's foreground is already
 * legible against its own background -- that is the one thing a user has
 * definitely configured -- so hierarchy is carried by weight and dimming
 * instead: bold for what matters, dim for chrome, inverse for a highlight.
 * The result reads correctly on a black terminal, a white one, and every
 * solarized variant in between, which no fixed palette can do.
 *
 * `undefined` means "whatever the terminal's foreground is". Ink omits the
 * escape entirely, which is exactly what adapts.
 */
/**
 * Monochrome, and deliberately so.
 *
 * Almost every entry here is `undefined`, which makes Ink omit the colour
 * escape entirely and leave the terminal's own foreground in place. That is
 * the one colour a user has definitely configured to be legible against their
 * own background, so it reads correctly on a black terminal, a white one, and
 * every solarized variant in between -- which no fixed palette can do.
 *
 * Meaning that used to be carried by hue is carried by weight instead: bold
 * for what matters, `dimColor` for chrome, inverse for a highlight, and the
 * glyphs in `G` for state.
 */
type Ink = string | undefined;

export const C = {
  ink: undefined as Ink,
  muted: undefined as Ink,
  dim: undefined as Ink,
  rule: undefined as Ink,
  panel: undefined as Ink,
  void: undefined as Ink,

  // Kept so call sites read meaningfully; all resolve to the terminal default.
  pulse: undefined as Ink,
  pulseLow: undefined as Ink,
  lock: undefined as Ink,
  lockLow: undefined as Ink,
  warn: undefined as Ink,
  alarm: undefined as Ink,

  /**
   * The two exceptions, and they are not decoration: a scanner needs real
   * black modules on a real white field. Named ANSI colours get remapped by
   * the user's theme -- "black on white" that resolves to slate on cream is a
   * code no phone will read -- so these are stated as hex.
   */
  black: "#000000",
  white: "#ffffff",
} as const;

/**
 * Box-drawing and geometric glyphs only -- every one of these is a single cell
 * wide in every terminal. Emoji are not: they render two cells wide in some
 * terminals and one in others, and a column that is sometimes one cell wider
 * than the layout believes tears the whole frame.
 */
export const G = {
  brand: "▌",
  ruleH: "─",
  dot: "·",
  locked: "◉",
  waiting: "◍",
  idle: "◌",
  warnMark: "▲",
  stop: "■",
  arrow: "›",
} as const;

/** Pad right to a fixed cell count, truncating rather than overflowing. */
export function padEnd(text: string, n: number): string {
  return text.length > n ? text.slice(0, n) : text + " ".repeat(n - text.length);
}

/** Pad left. Numbers are right-aligned so their digits stay in one column. */
export function padStart(text: string, n: number): string {
  return text.length > n ? text.slice(0, n) : " ".repeat(n - text.length) + text;
}

export function truncate(text: string, n: number): string {
  if (n <= 0) return "";
  return text.length <= n ? text : text.slice(0, Math.max(0, n - 1)) + "…";
}

/**
 * A number at a fixed width.
 *
 * Telemetry is redrawn five times a second; a value that changes width as it
 * crosses 9.9 or 999 shifts every column after it and the panel appears to
 * twitch. Fixing the width once costs nothing and the numbers sit still.
 */
export function num(value: number, width: number, decimals = 0): string {
  if (!Number.isFinite(value)) return padStart("—", width);
  return padStart(value.toFixed(decimals), width);
}

/** Thousands separated by a thin space, the way the rest of the product does. */
export function group(value: number): string {
  return Math.round(value).toLocaleString("de-DE").replace(/\./g, " ");
}

export function clockTime(): string {
  return new Date().toTimeString().slice(0, 8);
}

export function duration(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const mm = String(m).padStart(2, "0");
  const ss = String(sec).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

export function clamp(value: number, lo: number, hi: number): number {
  return value < lo ? lo : value > hi ? hi : value;
}
