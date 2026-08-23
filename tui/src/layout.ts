/**
 * Where everything goes, decided once per frame from the terminal's real size.
 *
 * The screen is never scrolled and never clipped: the plan below hands every
 * section an exact row count that adds up to the terminal height, and sections
 * are dropped -- least important first -- rather than allowed to overflow.
 * Ink will happily lay out a box taller than the screen, and the result on an
 * alternate screen is a torn frame that redraws over itself, so nothing here
 * is left to flexbox.
 */

import { clamp } from "./theme.js";

/** The one hard floor: below this the right-hand column stops being readable. */
const RIGHT_MIN = 34;
/** Columns between the join card and the telemetry column. */
export const GUTTER = 2;
/** Rows for the title bar and the key hint. */
const CHROME_ROWS = 2;

export interface QrPlan {
  quiet: number;
  /** Modules per side including the quiet zone. */
  w: number;
  /** Terminal rows, two module rows per row of half-blocks. */
  h: number;
}

export interface JoinPlan {
  qr: QrPlan | null;
  /** Room code as a block-letter banner rather than a single bold line. */
  big: boolean;
  /** Horizontal scale of the banner, in cells per bitmap pixel. */
  bigScale: 1 | 2;
  /** The section rule above the card. */
  rule: boolean;
  /** A blank row between the code image and the code text. */
  gap: boolean;
  /** Code and URL share one line instead of taking two. */
  combined: boolean;
  /** The source / buffer / monitoring block. */
  config: boolean;
  height: number;
  width: number;
}

export interface Layout {
  cols: number;
  rows: number;
  stacked: boolean;
  bodyW: number;
  contentH: number;
  leftW: number;
  rightW: number;
  join: JoinPlan;
  /** Body rows per section; 0 means the section is not drawn at all. */
  scope: number;
  devices: number;
  telemetry: number;
  log: number;
  /** Columns of the telemetry grid, 1--3 depending on width. */
  statColumns: number;
}

interface Spec {
  key: "scope" | "devices" | "telemetry" | "log";
  /** Rows the section costs before any body rows: rules, column headers. */
  chrome: number;
  min: number;
  cap: number;
  /** Body rows added per pass of the growth loop. */
  weight: number;
  /** Dropped first when the terminal is too short. Higher goes first. */
  dropOrder: number;
  /** Takes whatever is left once everything else has hit its cap. */
  grow?: boolean;
}

/**
 * Hand out `total` rows to `specs`.
 *
 * Sections are dropped whole rather than squeezed into two useless rows, then
 * what remains grows by weight so the scope stays the largest thing on screen
 * without starving the log on a tall terminal.
 */
function allocate(total: number, specs: Spec[]): Map<Spec["key"], number> {
  let active = specs.slice();
  const floor = (list: Spec[]) =>
    list.reduce((sum, s) => sum + s.chrome + s.min, 0) + Math.max(0, list.length - 1);

  while (active.length > 1 && floor(active) > total) {
    let worst = 0;
    for (let i = 1; i < active.length; i++) {
      if (active[i].dropOrder > active[worst].dropOrder) worst = i;
    }
    active.splice(worst, 1);
  }
  if (active.length === 1 && floor(active) > total) active = [];

  const out = new Map<Spec["key"], number>();
  for (const s of specs) out.set(s.key, 0);
  if (!active.length) return out;

  const body = new Map<Spec["key"], number>();
  for (const s of active) body.set(s.key, s.min);
  let left = total - floor(active);

  let moved = true;
  while (left > 0 && moved) {
    moved = false;
    for (const s of active) {
      for (let i = 0; i < s.weight && left > 0; i++) {
        const current = body.get(s.key)!;
        if (current >= s.cap) break;
        body.set(s.key, current + 1);
        left--;
        moved = true;
      }
    }
  }
  if (left > 0) {
    const sink = active.find((s) => s.grow) ?? active[0];
    body.set(sink.key, body.get(sink.key)! + left);
  }

  for (const s of active) out.set(s.key, body.get(s.key)!);
  return out;
}

/**
 * The join card: QR, room code, address, capture settings.
 *
 * Every combination of "how much white around the QR" and "how much text
 * underneath" is scored and the best one that fits is taken. Scannability wins
 * over decoration -- a four-module quiet zone is what the QR spec asks for and
 * outranks both the banner and the settings block -- but a two-module zone
 * still beats showing no code at all.
 */
export function planJoin(
  maxW: number,
  maxH: number,
  modules: number,
  wide: boolean,
): JoinPlan {
  const candidates: JoinPlan[] = [];
  const quiets = [6, 5, 4, 3, 2];
  const combos = [
    { big: true, rule: true, gap: true, config: true },
    { big: false, rule: true, gap: true, config: true },
    { big: true, rule: false, gap: true, config: true },
    { big: false, rule: false, gap: true, config: true },
    { big: true, rule: true, gap: true, config: false },
    { big: false, rule: true, gap: true, config: false },
    { big: false, rule: false, gap: true, config: false },
    { big: false, rule: false, gap: false, config: false },
  ];

  for (const quiet of modules > 0 ? quiets : []) {
    const w = modules + quiet * 2;
    if (w > maxW) continue;
    const h = Math.ceil(w / 2);
    for (const combo of combos) {
      const plan = measureJoin({ ...combo, quiet, w, h }, maxW, wide);
      if (plan.height <= maxH && plan.width <= maxW) candidates.push(plan);
    }
  }
  // No QR fits: the room code becomes the artwork instead of a stretched or
  // clipped code that no camera would read.
  for (const combo of combos) {
    const plan = measureJoin({ ...combo, quiet: 0, w: 0, h: 0 }, maxW, wide);
    if (plan.height <= maxH && plan.width <= maxW) candidates.push(plan);
  }

  if (!candidates.length) {
    return {
      qr: null,
      big: false,
      bigScale: 1,
      rule: false,
      gap: false,
      combined: true,
      config: false,
      height: 1,
      width: Math.min(maxW, 24),
    };
  }

  candidates.sort((a, b) => score(b) - score(a));
  return candidates[0];
}

function measureJoin(
  input: {
    quiet: number;
    w: number;
    h: number;
    big: boolean;
    rule: boolean;
    gap: boolean;
    config: boolean;
  },
  maxW: number,
  wide: boolean,
): JoinPlan {
  const qr = input.quiet > 0 ? { quiet: input.quiet, w: input.w, h: input.h } : null;
  // Two cells per bitmap pixel is the honest aspect ratio: a terminal cell is
  // about twice as tall as it is wide, so a one-cell pixel draws a letter half
  // as wide as it should be. Beside a QR the banner has to live inside the
  // code's width, though -- a card wider than its own artwork would push the
  // telemetry column narrower for nothing.
  const ceiling = qr ? qr.w : maxW;
  const bigScale: 1 | 2 = BANNER_W(2) <= ceiling ? 2 : 1;
  const big = input.big || !qr;
  const bannerW = big ? BANNER_W(bigScale) : 0;
  const codeRows = big ? BANNER_H : 1;
  // Without a QR the address needs its own line; beside one it fits the code's.
  const combined = !big && !wide;

  let height = 0;
  if (input.rule) height += 1;
  if (qr) height += qr.h;
  if (input.gap && qr) height += 1;
  height += codeRows;
  if (!combined) height += 1;
  if (input.config) height += 5;

  const width = Math.max(qr?.w ?? 0, bannerW, 20);
  return {
    qr,
    big,
    bigScale,
    rule: input.rule,
    gap: input.gap && qr !== null,
    combined,
    config: input.config,
    height,
    width: Math.min(width, maxW),
  };
}

/** Bitmap glyphs are four pixels wide with one pixel of tracking. */
const BANNER_H = 5;
const BANNER_W = (scale: 1 | 2) => (4 * scale + scale) * 6 - scale;

function score(plan: JoinPlan): number {
  const quiet = plan.qr?.quiet ?? 0;
  let s = 0;
  if (plan.qr) s += 10_000;
  if (quiet >= 4) s += 4_000;
  else if (quiet === 3) s += 2_000;
  if (plan.config) s += 300;
  if (quiet > 4) s += (quiet - 4) * 60;
  if (plan.big) s += 40;
  if (plan.rule) s += 12;
  if (plan.gap) s += 6;
  return s;
}

export function planLayout(
  cols: number,
  rows: number,
  modules: number,
  deviceCount: number,
): Layout {
  const bodyW = Math.max(10, cols - 2);
  const contentH = Math.max(1, rows - CHROME_ROWS);
  // Two columns only once a QR with its minimum quiet zone and a readable
  // telemetry column both fit; otherwise the code would silently degrade to a
  // banner on a terminal that is in fact wide enough to show it stacked.
  const qrMinW = (modules > 0 ? modules : 31) + 4;
  const stacked = bodyW < qrMinW + GUTTER + RIGHT_MIN;

  const deviceCap = clamp(deviceCount + 1, 2, 10);

  if (!stacked) {
    const join = planJoin(bodyW - GUTTER - RIGHT_MIN, contentH, modules, true);
    const leftW = join.width;
    const rightW = bodyW - leftW - GUTTER;
    const alloc = allocate(contentH, [
      { key: "scope", chrome: 1, min: 3, cap: Math.max(12, Math.floor(contentH * 0.45)), weight: 2, dropOrder: 2, grow: true },
      { key: "devices", chrome: 2, min: 1, cap: deviceCap, weight: 1, dropOrder: 1 },
      { key: "telemetry", chrome: 1, min: 1, cap: 2, weight: 1, dropOrder: 3 },
      { key: "log", chrome: 1, min: 3, cap: Math.max(5, Math.floor(contentH * 0.3)), weight: 1, dropOrder: 4 },
    ]);
    return {
      cols, rows, stacked: false, bodyW, contentH, leftW, rightW, join,
      scope: alloc.get("scope")!,
      devices: alloc.get("devices")!,
      telemetry: alloc.get("telemetry")!,
      log: alloc.get("log")!,
      statColumns: clamp(Math.floor(rightW / 20), 1, 3),
    };
  }

  // Narrow: one column. The join card is measured first against a reserve for
  // the device list, so a tall QR can never push the guest list off screen.
  const reserve = 8;
  let join = planJoin(bodyW, Math.max(3, contentH - reserve), modules, false);
  if (join.height + 3 > contentH) join = planJoin(bodyW, contentH, modules, false);

  const alloc = allocate(Math.max(0, contentH - join.height - 1), [
    { key: "scope", chrome: 1, min: 3, cap: Math.max(8, Math.floor(contentH * 0.3)), weight: 2, dropOrder: 3, grow: true },
    { key: "devices", chrome: 2, min: 1, cap: deviceCap, weight: 1, dropOrder: 1 },
    { key: "telemetry", chrome: 1, min: 1, cap: 2, weight: 1, dropOrder: 2 },
    { key: "log", chrome: 1, min: 3, cap: Math.max(4, Math.floor(contentH * 0.22)), weight: 1, dropOrder: 4 },
  ]);

  return {
    cols, rows, stacked: true, bodyW, contentH,
    leftW: bodyW, rightW: bodyW, join,
    scope: alloc.get("scope")!,
    devices: alloc.get("devices")!,
    telemetry: alloc.get("telemetry")!,
    log: alloc.get("log")!,
    statColumns: clamp(Math.floor(bodyW / 20), 1, 3),
  };
}
