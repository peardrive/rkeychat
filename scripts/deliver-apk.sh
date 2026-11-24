#!/usr/bin/env bash
# Build the rKeyChat Android APK (a sideload for a phone, not a Play bundle) and copy it, versioned, into the shared
# deliveries folder. Same shape as peardrop-mobile/scripts/deliver-apk.sh (2026-11-24).
#
#   scripts/deliver-apk.sh              release build, arm64 only (modern phones; small)
#   scripts/deliver-apk.sh --all-abis   every ABI (a universal APK, about four times the size)
#   scripts/deliver-apk.sh --clean      ./gradlew clean first
#
# Before this: `rsync` rKeyChat/src into ./src and commit (the phone's engine is a copy of the desktop's; the lessons
# check `phone-daemon-copy-matches-the-desktop` fails a build whose copy is behind), and build the shell once
# (`npm --prefix ~/Anjou/rKeyChat/app run build`): `npm run bundle` packs both into mobile/app.bundle.mjs.
#
# Signing: android/app/build.gradle reads ~/Anjou/_keys/rkeychat-android-keystore.properties (storeFile, storePassword,
# keyAlias, keyPassword). Without it the APK is DEBUG-SIGNED: it installs and runs, but a later signed build cannot
# update it, and it can never go to Play. The file name says which.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP="$HERE/mobile"
DELIVERIES="${RKEYCHAT_DELIVERIES:-$HOME/Anjou/_deliveries/rkeychat-mobile}"
ABIS="arm64-v8a"; DO_CLEAN=no
for arg in "$@"; do
  case "$arg" in
    --all-abis) ABIS="armeabi-v7a,arm64-v8a,x86,x86_64" ;;
    --clean) DO_CLEAN=yes ;;
    -h|--help) sed -n 2,16p "$0"; exit 0 ;;
    *) echo "unknown option: $arg" >&2; exit 2 ;;
  esac
done
cd "$APP"
if [ -z "${ANDROID_HOME:-}" ] && [ -z "${ANDROID_SDK_ROOT:-}" ]; then
  for cand in "$HOME/Library/Android/sdk" "$HOME/Android/Sdk"; do
    if [ -d "$cand/platform-tools" ] || [ -d "$cand/build-tools" ]; then export ANDROID_HOME="$cand" ANDROID_SDK_ROOT="$cand"; break; fi
  done
fi
[ -n "${ANDROID_HOME:-}" ] || { echo "✗ Android SDK not found: set ANDROID_HOME" >&2; exit 1; }
# the Android project is generated and gitignored (like ios/): make it when missing, then put in what it lacks
[ -d android ] || env -u CLAUDECODE -u ELECTRON_RUN_AS_NODE npx expo prebuild --platform android --no-install
node "$HERE/scripts/patch-android.mjs"
[ -f android/local.properties ] || echo "sdk.dir=$ANDROID_HOME" > android/local.properties
VERSION="$(node -p "require('./app.json').expo.version")"
CODE="$(node -p "require('./app.json').expo.android.versionCode")"
SHA="$(git -C "$HERE" rev-parse --short HEAD 2>/dev/null || echo nogit)"
DIRTY=""; git -C "$HERE" diff --quiet 2>/dev/null || DIRTY="-dirty"
echo "rKeyChat Android $VERSION (vc$CODE, git $SHA$DIRTY) · abis: $ABIS"
# the engine (../src via bare/core) and the shell (rKeyChat/app/dist) into app.bundle.mjs; read its whole output
npm run bundle
# the Bare addons (udx, sodium, sqlite…) into the bare-kit library for every Android ABI
node node_modules/react-native-bare-kit/android/link.mjs > /dev/null
cd android
[ "$DO_CLEAN" = yes ] && ./gradlew clean -q
./gradlew assembleRelease -PreactNativeArchitectures="$ABIS" --console=plain 2>&1 | tee "$APP/android/build-release.log" | grep -E "WARNING: no usable keystore|BUILD |error:|FAILED|> Task :app:assembleRelease" || true
grep -q "BUILD SUCCESSFUL" "$APP/android/build-release.log" || { echo "✗ gradle failed; see mobile/android/build-release.log" >&2; exit 1; }
APK="$APP/android/app/build/outputs/apk/release/app-release.apk"
[ -f "$APK" ] || { echo "✗ no APK at $APK" >&2; exit 1; }
SIGNED="signed"; grep -q "no usable keystore" "$APP/android/build-release.log" && SIGNED="debugsigned"
mkdir -p "$DELIVERIES"
OUT="$DELIVERIES/rkeychat-mobile-$VERSION-vc$CODE-$SHA$DIRTY-$SIGNED.apk"
cp -f "$APK" "$OUT"
echo "delivery: $OUT ($(du -h "$OUT" | cut -f1), $SIGNED)"
