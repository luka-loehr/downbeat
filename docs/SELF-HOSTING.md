# Self-hosting

Downbeat is not a hosted service. You run the server on your own Cloudflare
account and point the Mac CLI at it.

## Requirements

- A Cloudflare account on **Workers Paid** (Durable Objects). R2 and D1 usage
  fits the free tiers for typical use.
- macOS 15+ on the host Mac, with Xcode command line tools (Swift 6).
- Listeners need only a modern browser.

## Deploy the Worker

```bash
npm install
cp wrangler.example.jsonc wrangler.jsonc       # gitignored, holds your own ids
npx wrangler r2 bucket create downbeat-audio
npx wrangler d1 create downbeat-sessions       # put the id in wrangler.jsonc
npx wrangler d1 migrations apply downbeat-sessions --remote
npx wrangler secret put HOST_PASSPHRASE        # gates room creation and uploads
npm run build && npx wrangler deploy
```

In `wrangler.jsonc`, set `database_id` to the id printed by `d1 create`, and
either point `routes` at a hostname on a zone you control or remove the
`routes` line to use only the `*.workers.dev` URL.

### Deploying from GitHub Actions

`.github/workflows/deploy.yml` deploys on every push to `main`. Because
`wrangler.jsonc` is not committed, the workflow generates it from
`wrangler.example.jsonc`. Configure these in the repository settings:

| Name | Kind | Value |
| --- | --- | --- |
| `CLOUDFLARE_API_TOKEN` | secret | API token with Workers, D1 and R2 edit rights |
| `CLOUDFLARE_ACCOUNT_ID` | secret | Your Cloudflare account id |
| `D1_DATABASE_ID` | secret | The id of `downbeat-sessions` |
| `WORKER_ROUTE` | variable (optional) | Custom hostname, e.g. `downbeat.example.com`; unset uses `*.workers.dev` |

## Set up the host Mac

The CLI has no default server. Set `DOWNBEAT_URL` to your deployment (for
example in `~/.zshrc`), or pass `--url` on each command:

```bash
./scripts/install.sh                                   # or: cd cli && swift build -c release
export DOWNBEAT_URL=https://downbeat.example.com
downbeat login                                         # passphrase once, stored per server
downbeat host                                          # prints a QR code
```

The passphrase is stored in `~/.config/downbeat/<host>.passphrase` (mode 0600).
`DOWNBEAT_PASSPHRASE` or `--passphrase` override it.

### Hosting options

While hosting, `m` mutes this Mac, `+` and `-` set its level, and `s` switches
the captured app without interrupting the room.

| Flag | Effect |
| --- | --- |
| `--url <https://...>` | Server URL (default: `$DOWNBEAT_URL`) |
| `--code PARTY7` | Claim a fixed room code instead of a random one |
| `--buffer 1000` | Starting delay budget (default 500 ms); adapts toward the smallest value listeners can carry |
| `--min-buffer 500` | Floor of the adaptive budget (default 350 ms) |
| `--no-adapt` | Pin the budget at `--buffer` |
| `--source Spotify` | Capture one app instead of everything the Mac plays (the default) |
| `--takeover` | Take a room already held by another session |
| `--no-mute` | Leave the source audible locally |
| `--no-local` | Do not play on this Mac |
| `--offline` | Local capture and playback only, no room |

## Development

```bash
cp wrangler.example.jsonc wrangler.jsonc   # if you have not already
npx wrangler types
npm run typecheck                          # worker + web
npm test                                   # clock estimator, drift controller, room codes
npm run build
cd cli && swift build -c release
./.build/release/downbeat selftest         # Opus encoder against live capture
./.build/release/downbeat selftest-qr      # renders a QR and decodes it back
```

`selftest-qr` feeds the rendered modules back through Vision to confirm that the
printed pattern is a QR code a phone can scan.

Tagging `v*` builds a universal CLI binary and attaches it to a GitHub release.
