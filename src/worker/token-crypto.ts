/**
 * AES-GCM for the stored Spotify refresh token — the deployment's crown
 * jewel, so it never touches the database in the clear. The key is 32 random
 * bytes, base64 (`openssl rand -base64 32`), living only as a Worker secret;
 * blobs are `iv(12) || ciphertext`, base64. Deliberately free of any Worker
 * types so the tests exercise the exact production code.
 */

async function aesKey(keyB64: string): Promise<CryptoKey> {
  const raw = Uint8Array.from(atob(keyB64), (c) => c.charCodeAt(0));
  return crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

export async function encryptSecret(plain: string, keyB64: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    await aesKey(keyB64),
    new TextEncoder().encode(plain),
  );
  const out = new Uint8Array(12 + ct.byteLength);
  out.set(iv);
  out.set(new Uint8Array(ct), 12);
  return btoa(String.fromCharCode(...out));
}

export async function decryptSecret(blob: string, keyB64: string): Promise<string> {
  const bytes = Uint8Array.from(atob(blob), (c) => c.charCodeAt(0));
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: bytes.slice(0, 12) },
    await aesKey(keyB64),
    bytes.slice(12),
  );
  return new TextDecoder().decode(plain);
}
