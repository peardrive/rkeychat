#!/usr/bin/env bash
# Package the standalone rKeyChat app (Electron) for this machine's platform, or the
# one named: `scripts/build-app.sh [mac|linux]`.
#
# The daemon runs INSIDE Electron (electron/main.js → src/daemon.js bootDaemon), so
# native modules must match Electron's Node ABI. udx-native, sodium-native and
# sherpa-onnx-node are N-API (one build works under Node and Electron);
# better-sqlite3 (pearcore's database) is not, so it is rebuilt for Electron here and
# rebuilt for plain Node again afterwards, so `rkeychat start`, the tests and the
# CLI keep working from this tree. Same recipe as peardrive/scripts/build-app.sh.
#
# Output: release/rKeyChat-<version>-<os>-<arch>.{dmg,zip|AppImage,deb}, copied into
# ~/Anjou/_deliveries/ so PearDrive carries the app to the other machines. Linux
# artifacts are built ON Linux (`npm install && npm run dist:linux` there).
set -euo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
cd "$HERE"
PLATFORM="${1:-}"
if [[ -z "$PLATFORM" ]]; then
  case "$(uname -s)" in Darwin) PLATFORM=mac ;; Linux) PLATFORM=linux ;; *) echo "unsupported: $(uname -s)" >&2; exit 2 ;; esac
fi
VERSION="$(node -p "require('./package.json').version")"
echo "rKeyChat $VERSION — packaging for $PLATFORM"
restore() { echo "restoring better-sqlite3 for Node $(node -v)..."; npm rebuild better-sqlite3 > /dev/null 2>&1 || echo "WARN: npm rebuild better-sqlite3 failed — run it by hand before 'rkeychat start' from this tree" >&2; }
trap restore EXIT
ELECTRON="$(node -p "require('./node_modules/electron/package.json').version")"
echo "building better-sqlite3 for Electron ${ELECTRON}..."
npx electron-rebuild -f -v "$ELECTRON" -w better-sqlite3 -o better-sqlite3
case "$PLATFORM" in
  mac)   npx electron-builder --mac ;;
  linux) npx electron-builder --linux ;;
  *) echo "usage: build-app.sh [mac|linux]" >&2; exit 2 ;;
esac
DELIVERIES="$HOME/Anjou/_deliveries"
mkdir -p "$DELIVERIES"
shopt -s nullglob
for a in release/rKeyChat-"$VERSION"-*.dmg release/rKeyChat-"$VERSION"-*.zip release/rKeyChat-"$VERSION"-*.AppImage release/rKeyChat-"$VERSION"-*.deb; do
  cp -f "$a" "$DELIVERIES/"
  echo "delivery: $DELIVERIES/$(basename "$a")"
  # tell every box this is the current rKeyChat (_deliveries/CURRENT.json; check-updates.mjs reads it)
  [[ -f "$DELIVERIES/publish.mjs" ]] && node "$DELIVERIES/publish.mjs" rkeychat "$VERSION" "$(basename "$a")"
done
