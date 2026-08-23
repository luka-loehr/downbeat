/**
 * Secrets are not emitted by `wrangler types` (they live in the Workers secret
 * store, not in wrangler.jsonc), so they are declared here by hand and merge
 * into the generated global `Env` interface.
 */
interface Env {
  /** Gates room creation and uploads. Set with `wrangler secret put HOST_PASSPHRASE`. */
  HOST_PASSPHRASE: string;
}
