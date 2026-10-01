#!/usr/bin/env bash
# Build dist/rkeychat-kit.zip: rKey + rKeyChat sources (no node_modules, no data),
# pearcore vendored, the setup docs on top. Unzip anywhere; the two folders must
# stay side by side (rKeyChat depends on ../rKey).
set -euo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
RKEY="$(cd "$HERE/../rKey" && pwd)"
STAMP="$(date +%Y%m%d-%H%M)"
TMP="$(mktemp -d)"; K="$TMP/rkeychat-kit"; mkdir -p "$K/rKey" "$K/rKeyChat"
rsync -a --exclude node_modules --exclude .git --exclude dist "$RKEY/" "$K/rKey/"
rsync -a --exclude node_modules --exclude .git --exclude dist --exclude '*.log' "$HERE/" "$K/rKeyChat/"
cp "$HERE/dist/KIMI-SETUP.md" "$HERE/dist/ZORIN-SETUP.md" "$K/" 2>/dev/null || true
printf 'rkeychat-kit built %s from rKeyChat %s, rKey %s\n' "$STAMP" "$(git -C "$HERE" rev-parse --short HEAD)" "$(git -C "$RKEY" rev-parse --short HEAD)" > "$K/VERSION"
mkdir -p "$HERE/dist"
( cd "$TMP" && zip -qr "$HERE/dist/rkeychat-kit-$STAMP.zip" rkeychat-kit -x '*.DS_Store' )
cp "$HERE/dist/rkeychat-kit-$STAMP.zip" "$HERE/dist/rkeychat-kit.zip"
rm -rf "$TMP"
echo "dist/rkeychat-kit-$STAMP.zip ($(du -h "$HERE/dist/rkeychat-kit.zip" | cut -f1))"
