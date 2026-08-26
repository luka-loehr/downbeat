#!/bin/sh
# One guided deploy of Downbeat onto YOUR Cloudflare account.
#
# Creates the bucket and the database, wires the database id into
# wrangler.jsonc, walks through the secrets, applies migrations, and ships the
# Worker together with the audio container. Run it again any time — every step
# is idempotent.
set -e

REPO="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO"

say()  { printf '\033[1m-> %s\033[0m\n' "$1"; }
need() { command -v "$1" >/dev/null 2>&1 || { echo "missing: $1 — $2"; exit 1; }; }

need npm    "install Node 20+ first"
need docker "the audio source ships as a container; install Docker and start it"
need openssl "needed to generate the token encryption key"

docker info >/dev/null 2>&1 || { echo "Docker is installed but not running — start it and retry."; exit 1; }

say "installing dependencies"
npm install --no-fund --no-audit

say "checking Cloudflare login"
npx wrangler whoami >/dev/null 2>&1 || npx wrangler login

say "R2 bucket (uploaded tracks)"
npx wrangler r2 bucket create downbeat-audio 2>/dev/null || echo "   already exists — good"

say "D1 database (sessions)"
if npx wrangler d1 create downbeat-sessions >/tmp/downbeat-d1.$$ 2>&1; then
  cat /tmp/downbeat-d1.$$
else
  echo "   already exists — good"
fi
DB_ID=$(npx wrangler d1 info downbeat-sessions --json 2>/dev/null | node -e "
  let s=''; process.stdin.on('data',d=>s+=d).on('end',()=>{
    try { process.stdout.write(JSON.parse(s).uuid ?? '') } catch {}
  })")
rm -f /tmp/downbeat-d1.$$
if [ -n "$DB_ID" ]; then
  say "wiring database id $DB_ID into wrangler.jsonc"
  node -e "
    const fs = require('fs');
    const p = 'wrangler.jsonc';
    fs.writeFileSync(p, fs.readFileSync(p, 'utf8')
      .replace(/\"database_id\": \"[^\"]*\"/, '\"database_id\": \"$DB_ID\"'));
  "
else
  echo "   could not read the database id — check wrangler.jsonc by hand"
fi

say "applying migrations"
npx wrangler d1 migrations apply downbeat-sessions --remote

echo ""
echo "Four secrets. The first three you choose or copy from the Spotify"
echo "developer dashboard; the last is generated for you."
echo ""
say "HOST_PASSPHRASE — what unlocks your host console"
npx wrangler secret put HOST_PASSPHRASE
say "SPOTIFY_CLIENT_ID — from developer.spotify.com/dashboard"
npx wrangler secret put SPOTIFY_CLIENT_ID
say "SPOTIFY_CLIENT_SECRET — same page, 'View client secret'"
npx wrangler secret put SPOTIFY_CLIENT_SECRET
say "TOKEN_KEY — generated"
openssl rand -base64 32 | npx wrangler secret put TOKEN_KEY

say "building"
npm run build

say "deploying (this builds and pushes the audio container — first time takes a few minutes)"
npx wrangler deploy

echo ""
echo "Deployed. Two last things:"
echo ""
echo "  1. In your Spotify app at developer.spotify.com/dashboard, add this"
echo "     exact Redirect URI (your deployment's domain + /api/spotify/callback):"
echo "         https://<your-worker-domain>/api/spotify/callback"
echo ""
echo "  2. Open https://<your-worker-domain>/host, unlock with your"
echo "     passphrase, and connect Spotify."
echo ""
echo "Then open a room, start streaming, and pick 'Downbeat' under Devices"
echo "in any Spotify app. That's the whole thing."
