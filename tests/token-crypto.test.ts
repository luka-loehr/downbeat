import { describe, expect, it } from "vitest";
import { decryptSecret, encryptSecret } from "../src/worker/token-crypto";

/**
 * The stored Spotify refresh token is the deployment's crown jewel: whoever
 * decrypts it can stream on the operator's account. These tests pin the two
 * properties that matter — the round trip is faithful, and a tampered or
 * wrong-key blob decrypts to nothing rather than to something.
 */

function randomKey(): string {
  const raw = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...raw));
}

describe("token crypto", () => {
  it("round-trips a refresh token", async () => {
    const key = randomKey();
    const secret = "AQD-refresh-token-with-unicode-🎵-and-length";
    expect(await decryptSecret(await encryptSecret(secret, key), key)).toBe(secret);
  });

  it("uses a fresh IV every time", async () => {
    const key = randomKey();
    const a = await encryptSecret("same", key);
    const b = await encryptSecret("same", key);
    expect(a).not.toBe(b); // identical ciphertexts would leak repetition
    expect(await decryptSecret(a, key)).toBe("same");
    expect(await decryptSecret(b, key)).toBe("same");
  });

  it("rejects a tampered blob", async () => {
    const key = randomKey();
    const blob = await encryptSecret("secret", key);
    const bytes = Uint8Array.from(atob(blob), (c) => c.charCodeAt(0));
    bytes[bytes.length - 1] ^= 0x01; // flip one ciphertext bit
    const tampered = btoa(String.fromCharCode(...bytes));
    await expect(decryptSecret(tampered, key)).rejects.toThrow();
  });

  it("rejects the wrong key", async () => {
    const blob = await encryptSecret("secret", randomKey());
    await expect(decryptSecret(blob, randomKey())).rejects.toThrow();
  });
});
