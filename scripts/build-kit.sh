#!/usr/bin/env bash
# Build dist/rkeychat-kit.zip: the rKeyChat source tree (no node_modules, no data, no
# .git) with pearcore and rKey vendored under vendor/, plus the setup docs on top.
# Unzip anywhere and `npm install` inside rkeychat-kit/rKeyChat; nothing is fetched
# from GitHub. The folder is still called rkeychat-kit/rKeyChat so `unzip -o` into ~
# updates a Mac Mini / Zorin install made from an earlier kit in place (the old
# rkeychat-kit/rKey folder beside it is no longer used and can be deleted).
# The zip also lands in ~/Anjou/_deliveries/ and is recorded in CURRENT.json.
set -euo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
VERSION="$(node -p "require('$HERE/package.json').version")"
SHA="$(git -C "$HERE" rev-parse --short HEAD)"
STAMP="$(date +%Y%m%d-%H%M)"
TMP="$(mktemp -d)"; K="$TMP/rkeychat-kit"; mkdir -p "$K/rKeyChat"
rsync -a --exclude node_modules --exclude .git --exclude dist --exclude release --exclude .data \
  --exclude .rkeychat --exclude graphify-out --exclude '*.log' --exclude .DS_Store "$HERE/" "$K/rKeyChat/"
cp "$HERE/docs/KIMI-SETUP.md" "$HERE/docs/ZORIN-SETUP.md" "$HERE/docs/UPDATE-kimi.md" "$K/"
printf 'rkeychat-kit %s built %s from rKeyChat %s (pearcore and rKey vendored in rKeyChat/vendor)\n' "$VERSION" "$STAMP" "$SHA" > "$K/VERSION"
mkdir -p "$HERE/dist"
NAME="rkeychat-kit-$VERSION-$SHA.zip"
( cd "$TMP" && zip -qr "$HERE/dist/$NAME" rkeychat-kit -x '*.DS_Store' )
cp "$HERE/dist/$NAME" "$HERE/dist/rkeychat-kit.zip"
rm -rf "$TMP"
DELIVERIES="$HOME/Anjou/_deliveries"
if [[ -d "$DELIVERIES" ]]; then
  cp -f "$HERE/dist/$NAME" "$DELIVERIES/$NAME"
  cp -f "$HERE/dist/$NAME" "$DELIVERIES/rkeychat-kit.zip"
  [[ -f "$DELIVERIES/publish.mjs" ]] && node "$DELIVERIES/publish.mjs" rkeychat "$VERSION" "$NAME"
  echo "delivery: $DELIVERIES/$NAME"
fi
echo "dist/$NAME ($(du -h "$HERE/dist/rkeychat-kit.zip" | cut -f1))"
