#!/bin/sh
# Build and install Downbeat.
#
# Two binaries, one command. The capture engine must be native (Core Audio
# process taps are macOS APIs) and the UI is React Ink, which must be Node, so
# `downbeat` is a launcher that finds and spawns `downbeat-core`. Users only
# ever type `downbeat`.
set -e

REPO="$(cd "$(dirname "$0")/.." && pwd)"
PREFIX="${PREFIX:-$( [ -w /usr/local/bin ] && echo /usr/local/bin || echo "$HOME/.local/bin" )}"
mkdir -p "$PREFIX"

echo "Repository : $REPO"
echo "Target     : $PREFIX"

echo "-> building the capture engine (Swift)"
( cd "$REPO/cli" && swift build -c release )
install -m 755 "$REPO/cli/.build/release/downbeat-core" "$PREFIX/downbeat-core"

echo "-> building the terminal UI (Ink)"
( cd "$REPO/tui" && npm ci --silent --no-audit --no-fund 2>/dev/null || npm install --silent --no-audit --no-fund )
( cd "$REPO/tui" && npm run --silent build )

cat > "$PREFIX/downbeat" <<LAUNCHER
#!/bin/sh
# Downbeat — installed by scripts/install.sh
exec node "$REPO/tui/dist/cli.js" "\$@"
LAUNCHER
chmod 755 "$PREFIX/downbeat"

echo
echo "Installed:"
echo "  $PREFIX/downbeat"
echo "  $PREFIX/downbeat-core"
echo
echo "Next:  downbeat login   then   downbeat host"
