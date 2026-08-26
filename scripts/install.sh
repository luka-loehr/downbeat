#!/bin/sh
# Build and install Downbeat: one native Swift binary, nothing else.
set -e

REPO="$(cd "$(dirname "$0")/.." && pwd)"
PREFIX="${PREFIX:-$( [ -w /usr/local/bin ] && echo /usr/local/bin || echo "$HOME/.local/bin" )}"
mkdir -p "$PREFIX"

echo "Repository : $REPO"
echo "Target     : $PREFIX"

echo "-> building downbeat (Swift)"
( cd "$REPO/cli" && swift build -c release )
install -m 755 "$REPO/cli/.build/release/downbeat" "$PREFIX/downbeat"

# The pre-0.4 split install: a Node launcher plus a separate engine.
rm -f "$PREFIX/downbeat-core"

echo
echo "Installed:"
echo "  $PREFIX/downbeat"
echo
echo "Next:  downbeat login   then   downbeat host"
