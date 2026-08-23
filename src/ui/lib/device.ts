/**
 * A name for this speaker, taken from the device rather than asked for.
 *
 * Nobody at a party wants to type a name before the music starts, and the
 * answer is almost always just "iPhone" anyway. The room numbers duplicates,
 * so three iPhones become iPhone, iPhone 2, iPhone 3.
 */
export function deviceName(): string {
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
