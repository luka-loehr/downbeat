/**
 * What this device remembers about itself.
 *
 * A guest should name their speaker once, ever. After that the phone knows
 * what it is called and which room it was last in, so a reload, a dropped
 * connection or a host restart puts them straight back into the music instead
 * of back at a form.
 */
const NAME_KEY = "downbeat.deviceName.v1";
const ROOM_KEY = "downbeat.lastRoom.v1";

/** A sensible first suggestion, so the name field is never empty. */
export function suggestedName(): string {
  const ua = navigator.userAgent;
  const touch = navigator.maxTouchPoints ?? 0;

  if (/iPhone/.test(ua)) return "iPhone";
  if (/iPad/.test(ua)) return "iPad";
  // Modern iPadOS reports itself as a Mac; the touch points give it away.
  if (/Macintosh/.test(ua) && touch > 1) return "iPad";
  if (/Macintosh|Mac OS X/.test(ua)) return "Mac";
  if (/Android/.test(ua)) {
    const model = /;\s*([^;)]+?)\s+Build\//.exec(ua)?.[1]?.trim();
    return model && model.length <= 20 ? model : "Android";
  }
  if (/Windows/.test(ua)) return "Windows";
  if (/CrOS/.test(ua)) return "Chromebook";
  if (/Linux/.test(ua)) return "Linux";
  return "Speaker";
}

export function savedName(): string | null {
  try {
    const v = localStorage.getItem(NAME_KEY)?.trim();
    return v ? v : null;
  } catch {
    return null;
  }
}

export function saveName(name: string): void {
  try {
    localStorage.setItem(NAME_KEY, name.slice(0, 24));
  } catch {
    /* private mode; the name just will not persist */
  }
}

/** The effective name: whatever was chosen, else the suggestion. */
export function deviceName(): string {
  return savedName() ?? suggestedName();
}

export interface RememberedRoom {
  code: string;
  at: number;
}

/** Rooms are remembered for a day -- long enough for one party, not forever. */
const ROOM_TTL_MS = 24 * 60 * 60 * 1000;

export function rememberRoom(code: string): void {
  try {
    localStorage.setItem(ROOM_KEY, JSON.stringify({ code, at: Date.now() }));
  } catch {
    /* ignore */
  }
}

export function lastRoom(): RememberedRoom | null {
  try {
    const raw = localStorage.getItem(ROOM_KEY);
    if (!raw) return null;
    const room = JSON.parse(raw) as RememberedRoom;
    if (!room?.code || Date.now() - room.at > ROOM_TTL_MS) return null;
    return room;
  } catch {
    return null;
  }
}

export function forgetRoom(): void {
  try {
    localStorage.removeItem(ROOM_KEY);
  } catch {
    /* ignore */
  }
}
