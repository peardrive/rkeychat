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
# THE MAC BUILD IS SIGNED BY PEARDRIVE LLC AND NOTARIZED BY APPLE (2026-11-16), as PearDrive's is.
# electron-builder finds the "Developer ID Application" certificate in this Mac's keychain by itself, signs
# every binary with the hardened runtime, and, with the APPLE_API_* variables notary-env.sh sets (the key
# named by path, never read here), has Apple notarize the app before the zip and the dmg are made. A
# firewall and the microphone and camera permissions then see one rKeyChat across every build.
if [[ "$PLATFORM" == mac && -f "$HOME/Anjou/_publishing/mac/notary-env.sh" ]]; then source "$HOME/Anjou/_publishing/mac/notary-env.sh"; fi
# --publish never: on a CI build made from a tag, electron-builder would otherwise try to publish a GitHub release
# and fail for want of a token (the Linux workflow, 2026-11-24); the deliveries folder is where builds go
case "$PLATFORM" in
  mac)   npx electron-builder --mac --publish never ;;
  linux) npx electron-builder --linux --publish never ;;
  *) echo "usage: build-app.sh [mac|linux]" >&2; exit 2 ;;
esac
if [[ "$PLATFORM" == mac && -x "$HOME/Anjou/_publishing/mac/verify-signed.sh" ]]; then
  # read into a variable first: `... | grep -q` under pipefail fails at random (see ship-app.sh, 2026-11-16)
  IDS="$(security find-identity -v -p codesigning 2>/dev/null || true)"
  if grep -q "Developer ID Application" <<<"$IDS"; then
    "$HOME/Anjou/_publishing/mac/verify-signed.sh" release/mac-arm64/rKeyChat.app ${APPLE_API_KEY:+--notarized} \
      || { echo "ABORT: the Mac build is not signed as a release must be (see the FAIL line above)" >&2; exit 1; }
  else
    echo "WARN: no Developer ID certificate in this keychain: the Mac build is NOT signed by Peardrive LLC"
  fi
fi
# THE APP'S FOLDER IN _deliveries (~/Anjou/_deliveries/AGENTS.md, 2026-11-25): one folder per app and channel, every
# installer named <app>-<version>-<os>-<arch>.<ext> (package.json build.artifactName). The signed release record beside
# each installer, the channel Space and the deliveries check come from `npm run release` (scripts/release.mjs), which
# signs with the device key that publishes the channel. electron-builder spells the Linux arch amd64/x86_64 in places;
# the standard says x64.
DELIVERIES="$HOME/Anjou/_deliveries/rkeychat-desktop"
mkdir -p "$DELIVERIES"
shopt -s nullglob
for a in release/rkeychat-desktop-"$VERSION"-*.dmg release/rkeychat-desktop-"$VERSION"-*.zip release/rkeychat-desktop-"$VERSION"-*.AppImage release/rkeychat-desktop-"$VERSION"-*.deb; do
  name="$(basename "$a" | sed -e 's/-amd64\./-x64./' -e 's/-x86_64\./-x64./')"
  cp -f "$a" "$DELIVERIES/$name"
  echo "delivery: $DELIVERIES/$name"
done
echo "done: rKeyChat $VERSION for $PLATFORM (records and the channel: npm run release)"
