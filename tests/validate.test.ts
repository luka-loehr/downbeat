import { describe, expect, it } from "vitest";
import {
  BodyTooLarge,
  MAX_QUEUE,
  cleanText,
  parseDuration,
  readCapped,
  readJsonObject,
  sanitizeCommand,
  sanitizeLive,
  sanitizeTelemetry,
  sanitizeTrack,
} from "../src/shared/validate";

const ID = "0123456789abcdef0123456789abcdef";
const track = { id: ID, title: "Song", duration: 180, size: 1000, mimeType: "audio/mpeg" };

describe("cleanText", () => {
  it("drops control characters, trims and cuts", () => {
    expect(cleanText("  Lu\u0000ka\n  ", 24)).toBe("Luka");
    expect(cleanText("x".repeat(100), 24)).toHaveLength(24);
    expect(cleanText("Grüße 🎧", 24)).toBe("Grüße 🎧");
  });
  it("turns anything that is not a string into an empty string", () => {
    for (const v of [null, undefined, 5, {}, ["a"]]) expect(cleanText(v, 24)).toBe("");
  });
});

describe("sanitizeTelemetry", () => {
  it("keeps a real report unchanged", () => {
    const report = { rtt: 12.5, sync: 0.4, startError: -3, playoutMs: 80, marginMs: 40, cushionMs: 30, underruns: 0, ctxRate: 1.0001, stuck: true };
    expect(sanitizeTelemetry({ t: "telemetry", ...report })).toEqual(report);
  });
  it("replaces wrong types, NaN and oversized values with the unreported value", () => {
    const out = sanitizeTelemetry({ rtt: "x".repeat(5000), sync: null, startError: { a: 1 }, playoutMs: [1], marginMs: "7", cushionMs: 1e300, underruns: -1, ctxRate: Number.NaN, stuck: "yes" });
    expect(out).toEqual({ rtt: 0, sync: 0, startError: null, playoutMs: null, marginMs: null, cushionMs: null, underruns: null, ctxRate: null, stuck: false });
    // Whatever arrives, the result fits a WebSocket attachment (2 kB limit).
    expect(JSON.stringify(out).length).toBeLessThan(300);
  });
  it("survives a message that is not an object", () => {
    expect(sanitizeTelemetry(null).rtt).toBe(0);
  });
});

describe("sanitizeTrack", () => {
  it("accepts an uploaded track and drops unknown fields", () => {
    expect(sanitizeTrack({ ...track, evil: "x" })).toEqual(track);
  });
  it("rejects ids that are not upload ids", () => {
    for (const id of ["", "../secret", ID.toUpperCase(), ID + "0", 5, null]) expect(sanitizeTrack({ ...track, id })).toBeNull();
  });
  it("repairs title, duration and size", () => {
    expect(sanitizeTrack({ id: ID, title: 5, duration: -1, size: "big" })).toEqual({ id: ID, title: "Untitled", duration: 0, size: 0, mimeType: "" });
    expect(sanitizeTrack({ ...track, title: "t".repeat(500) })!.title).toHaveLength(120);
  });
});

describe("sanitizeLive", () => {
  const opus = { sampleRate: 48000, channels: 2, frameSize: 960, bufferMs: 500, sourceLabel: "Spotify", epoch: 1795000000000.5, codec: "opus" };
  it("accepts what the CLI announces, Opus and FLAC", () => {
    expect(sanitizeLive(opus)).toEqual(opus);
    expect(sanitizeLive({ ...opus, codec: "flac", bitDepth: 24 })).toEqual({ ...opus, codec: "flac", bitDepth: 24 });
    // Sources older than 0.5 send neither codec nor epoch.
    const { codec: _c, epoch: _e, ...old } = opus;
    expect(sanitizeLive(old)).toEqual(old);
  });
  it("rejects impossible streams", () => {
    for (const bad of [{ sampleRate: 0 }, { channels: 2.5 }, { channels: 99 }, { frameSize: "960" }, { bufferMs: -1 }, { bufferMs: 1e9 }, { codec: "mp3" }]) {
      expect(sanitizeLive({ ...opus, ...bad }), JSON.stringify(bad)).toBeNull();
    }
    expect(sanitizeLive(null)).toBeNull();
    expect(sanitizeLive("live")).toBeNull();
  });
});

describe("sanitizeCommand", () => {
  it("passes every well-formed command", () => {
    for (const c of ["pause", "next", "prev", "forceStart", "liveStop"]) expect(sanitizeCommand({ c })).toEqual({ c });
    expect(sanitizeCommand({ c: "play" })).toEqual({ c: "play" });
    expect(sanitizeCommand({ c: "play", index: 3, offsetInTrack: 12.5 })).toEqual({ c: "play", index: 3, offsetInTrack: 12.5 });
    expect(sanitizeCommand({ c: "seek", offsetInTrack: -5 })).toEqual({ c: "seek", offsetInTrack: -5 });
    expect(sanitizeCommand({ c: "addTracks", tracks: [track] })).toEqual({ c: "addTracks", tracks: [track] });
    expect(sanitizeCommand({ c: "removeTrack", id: ID })).toEqual({ c: "removeTrack", id: ID });
  });
  it("rejects malformed ones", () => {
    const bad: unknown[] = [
      null,
      "play",
      [],
      {},
      { c: "nope" },
      { c: "play", index: "0" },
      { c: "play", index: 1.5 },
      { c: "play", index: -1 },
      { c: "play", index: MAX_QUEUE },
      { c: "play", offsetInTrack: Number.NaN },
      { c: "seek" },
      { c: "seek", offsetInTrack: "10" },
      { c: "addTracks" },
      { c: "addTracks", tracks: "x" },
      { c: "addTracks", tracks: [track, { ...track, id: "x" }] },
      { c: "addTracks", tracks: Array.from({ length: MAX_QUEUE + 1 }, () => track) },
      { c: "removeTrack", id: 5 },
      { c: "liveStart" },
      { c: "liveStart", live: { sampleRate: 48000 } },
    ];
    for (const cmd of bad) expect(sanitizeCommand(cmd), JSON.stringify(cmd)).toBeNull();
  });
});

describe("parseDuration", () => {
  it("reads plain seconds and nothing else", () => {
    expect(parseDuration("183.4")).toBe(183.4);
    expect(parseDuration(" 12 ")).toBe(12);
    for (const raw of [null, "", "abc", "-5", "Infinity", "1e9", "0x10", "999999999"]) expect(parseDuration(raw), String(raw)).toBe(0);
  });
});

describe("request bodies", () => {
  const post = (body: BodyInit | null, headers: Record<string, string> = {}) =>
    new Request("https://downbeat.test/api/rooms", { method: "POST", body, headers, duplex: "half" } as RequestInit);
  const stream = (chunks: number, size: number) => {
    let sent = 0;
    return new ReadableStream<Uint8Array>({
      pull(controller) {
        sent++ < chunks ? controller.enqueue(new Uint8Array(size)) : controller.close();
      },
    });
  };

  it("reads a body up to the limit", async () => {
    expect(await readCapped(post("hello"), 5)).toEqual(new TextEncoder().encode("hello"));
    expect((await readCapped(post(stream(3, 100)), 300)).byteLength).toBe(300);
    expect((await readCapped(post(null), 10)).byteLength).toBe(0);
  });
  it("refuses a declared or streamed body over the limit", async () => {
    await expect(readCapped(post("x", { "content-length": "999" }), 10)).rejects.toBeInstanceOf(BodyTooLarge);
    await expect(readCapped(post("hello!"), 5)).rejects.toBeInstanceOf(BodyTooLarge);
    await expect(readCapped(post(stream(1000, 1000)), 5000)).rejects.toBeInstanceOf(BodyTooLarge);
  });
  it("returns JSON objects and null for everything else", async () => {
    expect(await readJsonObject(post('{"passphrase":"p"}'))).toEqual({ passphrase: "p" });
    for (const body of ["", "null", "[1]", '"str"', "5", "{bad", `{"p":"${"x".repeat(5000)}"}`]) {
      expect(await readJsonObject(post(body)), body.slice(0, 20)).toBeNull();
    }
  });
});
