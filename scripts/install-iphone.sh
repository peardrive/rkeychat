#!/usr/bin/env bash
# Build the phone app for the iPhone on the cable or wifi pairing, install it, and take the built app off this Mac.
#
#   bash scripts/install-iphone.sh                 the iPhone in IPHONE (default: Guy's)
#
# Why not `npx expo run:ios`: after building and installing it waits on its own and never returns (2026-11-25: 11 hours),
# so a chain behind it never ran. xcodebuild builds into ios/build/device, devicectl installs, and the built .app is
# removed afterwards: Spotlight lists any .app it finds, and a crossed-out "rKeyChat" in the Mac's app list was this
# build (Guy, 2026-11-26; ~/Anjou/_publishing/disk.md: one build kept).
set -euo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
IPHONE="${IPHONE:-00008150-00164C4226D2401C}"
OUT="$HERE/mobile/ios/build/device"
cd "$HERE/mobile"
npm run bundle 2>&1 | tail -1
cd ios
env -u CLAUDECODE -u ELECTRON_RUN_AS_NODE xcodebuild -workspace rKeyChat.xcworkspace -scheme rKeyChat -configuration Release \
  -destination "id=$IPHONE" -derivedDataPath "$OUT" -allowProvisioningUpdates build 2>&1 | tee "$OUT.log" | grep -E "error:|\*\* BUILD" || true
grep -q "\*\* BUILD SUCCEEDED" "$OUT.log" || { echo "✗ the iPhone build failed; see $OUT.log" >&2; exit 1; }
APP="$OUT/Build/Products/Release-iphoneos/rKeyChat.app"
xcrun devicectl device install app --device "$IPHONE" "$APP" 2>&1 | grep -E "App installed|bundleID|rror" | grep -v "provisioning paramter" || true
# the built app off this Mac (the build cache stays for the next build's speed; only the .app shows in Spotlight)
/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -u "$APP" >/dev/null 2>&1 || true
rm -rf "${APP:?}" "$OUT.log"
echo "installed on $IPHONE; the built app removed from this Mac"
