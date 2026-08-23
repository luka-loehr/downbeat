import { CODE_ALPHABET, CODE_LENGTH } from "./protocol";

/**
 * Room codes are read aloud across a room and typed on phone keyboards, so the
 * alphabet drops I, L, O and U: no letter can be mistaken for a digit, and no
 * accidental words appear.
 */
export function generateCode(random: (n: number) => Uint8Array = cryptoBytes): string {
  const bytes = random(CODE_LENGTH);
  let out = "";
  for (const b of bytes) out += CODE_ALPHABET[b % CODE_ALPHABET.length];
  return out;
}

/**
 * Fold the glyphs people substitute when reading a code aloud or typing it.
 *
 * The alphabet drops I, L, O and U precisely because they are confusable, but
 * that only helps if someone typing "O" for zero gets in rather than an error.
 * Crockford's mapping: O is zero, I and L are one. U has no mapping -- it is
 * excluded to keep accidental words out, not because it looks like anything.
 */
export function normalizeCode(input: string): string {
  return input
    .trim()
    .toUpperCase()
    .replace(/[\s-]/g, "")
    .replace(/O/g, "0")
    .replace(/[IL]/g, "1");
}

export function isValidCode(code: string): boolean {
  if (code.length !== CODE_LENGTH) return false;
  for (const ch of code) if (!CODE_ALPHABET.includes(ch)) return false;
  return true;
}

function cryptoBytes(n: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(n));
}
