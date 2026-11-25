#!/usr/bin/env bash
# Ship rKeyChat to THIS Mac: bump the version and build counter, package and sign the app, install it into
# /Applications as THE rKeyChat, record it in the machine ledger, relaunch it.
#
#   npm run ship                       bump + build + install + relaunch
#   npm run ship -- --build-only       bump + build; the installers land in ~/Anjou/_deliveries/rkeychat-desktop/
#   npm run ship -- --no-bump          keep package.json's version (a rebuild of the same version, same bytes expected)
#
# After this the app opened from Applications or the Dock IS the newest code, and Settings › Updates says so
# (running version, build, commit, where it runs from). Then `npm run release -- --notes "…"` signs the records and
# puts the build on the update channel, so every other rKeyChat offers "Update to <version>".
#
# ONE rKeyChat ON THIS MAC (Guy, 2026-11-25). The installed app runs its own daemon (in-process) on the device's
# port. A daemon left running from the source tree (`rkeychat start --background`, `npm run app`) holds that port,
# and the installed app would attach to it and show the OLD code with the new icon: that is why "where is our
# local rKeyChat instance" had no simple answer. So this script stops any daemon on the port before it opens the
# new app, and the previous bundle never stays beside the new one in /Applications.
set -euo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
cd "$HERE"
BUILD_ONLY=0; BUMP=1
for a in "$@"; do case "$a" in --build-only) BUILD_ONLY=1 ;; --no-bump) BUMP=0 ;; esac; done
[[ "$(uname -s)" == Darwin ]] || { echo "ship-app.sh installs on macOS; on Linux use npm run dist:linux" >&2; exit 2; }
APP_ID="rkeychat-desktop"
DELIVERIES="$HOME/Anjou/_deliveries/rkeychat-desktop"

# 0. the lessons check: every FAIL is a build stopped before it is made
if [[ -f "$HOME/Anjou/_publishing/lessons/check.mjs" ]]; then
  node "$HOME/Anjou/_publishing/lessons/check.mjs" rKeyChat --release || { echo "ABORT: the lessons check failed (above); nothing was built" >&2; exit 1; }
fi
# a clone that is behind origin ships old code (CLAUDE.md): refuse
git fetch -q origin 2>/dev/null || echo "WARN: could not fetch origin; shipping what is here"
BRANCH="$(git rev-parse --abbrev-ref HEAD)"
if git rev-parse -q --verify "origin/$BRANCH" >/dev/null 2>&1 && [[ -n "$(git log --oneline "HEAD..origin/$BRANCH" 2>/dev/null)" ]]; then
  echo "ABORT: this clone is behind origin/$BRANCH; pull first" >&2; exit 1
fi

# 1. bump: PATCH +1 (every delivery bumps PATCH, AGENTS.md §5) and the build counter YYYY-MM-DD.N (N counts up for the day)
OLD_VERSION="$(node -p "require('./package.json').version")"
if (( BUMP )); then
  VERSION="$(node -p "const p='$OLD_VERSION'.split('.');p[2]=+p[2]+1;p.join('.')")"
  node -e "for (const f of ['package.json','app/package.json']) { const p=require('./'+f); p.version='$VERSION'; require('fs').writeFileSync(f, JSON.stringify(p,null,2)+'\n') }"
else
  VERSION="$OLD_VERSION"
fi
TODAY="$(date +%Y-%m-%d)"
LAST_N="$(ls "$DELIVERIES" 2>/dev/null | grep '\.release\.json$' | xargs -I{} node -p "try{JSON.parse(require('fs').readFileSync('$DELIVERIES/{}','utf8')).build}catch{''}" 2>/dev/null | grep "^$TODAY\." | sed 's/.*\.//' | sort -n | tail -1 || true)"
BUILD="$TODAY.$(( ${LAST_N:-0} + 1 ))"
COMMIT="$(git rev-parse --short HEAD)"
if (( BUMP )); then
  git add package.json app/package.json
  git commit -q -m "rKeyChat $VERSION (build $BUILD)" ${SHIP_TRAILER:+-m "$SHIP_TRAILER"} && COMMIT="$(git rev-parse --short HEAD)"
fi
# what the running copy says about itself (src/version.js reads it; git-ignored, shipped inside the app)
printf '{ "build": "%s", "commit": "%s", "builtAt": "%s" }\n' "$BUILD" "$COMMIT" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > src/build.json
echo "rKeyChat $VERSION (build $BUILD, commit $COMMIT)"

# 2. package: the shell, then the signed and notarized Mac app (build-app.sh), copied into the deliveries folder
npm run app:build
bash scripts/build-app.sh mac
BUILT="release/mac-arm64/rKeyChat.app"
[[ -d "$BUILT" ]] || { echo "ABORT: $BUILT was not produced" >&2; exit 1; }
if (( BUILD_ONLY )); then
  rm -rf "$BUILT" # the dmg and zip are the deliverables; the unpacked bundle would be a second rKeyChat in Spotlight (lessons: stray-app-copies)
  echo "built, not installed: rKeyChat $VERSION (build $BUILD) is in $DELIVERIES"
  echo "publish it: npm run release -- --notes 'what changed'"
  exit 0
fi

# 3. the build is signed by Peardrive LLC (build-app.sh verified it, seven PASS lines). Never sign it again here.
SIG="$(codesign -dv "$BUILT" 2>&1 || true)"
grep -q '^TeamIdentifier=[A-Z0-9]\{10\}$' <<<"$SIG" || { echo "ABORT: the build is not signed by a publisher; not installing it" >&2; exit 1; }

# 4. quit the running rKeyChat app, and stop a daemon running from a source tree on the device's port
osascript -e 'tell application id "com.rkeychat.app" to quit' >/dev/null 2>&1 || true
for _ in $(seq 1 20); do pgrep -f 'rKeyChat.app/Contents/MacOS/rKeyChat' >/dev/null || break; sleep 0.5; done
pkill -f 'rKeyChat.app/Contents/MacOS/rKeyChat' 2>/dev/null || true
node bin/rkeychat.js stop >/dev/null 2>&1 || true
for _ in $(seq 1 20); do curl -s -m 1 "http://127.0.0.1:$(node -p "try{require(require('os').homedir()+'/.rkeychat/config.json').port||4455}catch{4455}")/api/rooms" >/dev/null 2>&1 || break; sleep 0.5; done

# 5. install: the new bundle takes the place of the old one; nothing is left beside it (the updater keeps its
#    previous copy under ~/.rkeychat/updates/previous.noindex, out of Spotlight's sight; a ship keeps none)
DEST="/Applications/rKeyChat.app"
rm -rf "$DEST.new" "$DEST.previous"
ditto "$BUILT" "$DEST.new"
rm -rf "$DEST"
mv "$DEST.new" "$DEST"
VERIFY="$HOME/Anjou/_publishing/mac/verify-signed.sh"
if [[ -x "$VERIFY" ]]; then
  NOTARIZED=""; if xcrun stapler validate "$BUILT" >/dev/null 2>&1; then NOTARIZED="--notarized"; fi
  VOUT="$("$VERIFY" "$DEST" $NOTARIZED 2>&1)" || { echo "$VOUT" >&2; echo "ABORT: the app installed in /Applications is not signed as it was built (see the FAIL line above)" >&2; exit 1; }
  echo "installed copy: signed by the publisher${NOTARIZED:+, notarized}, $(grep -c '^PASS' <<<"$VOUT") checks pass"
fi
# the build output is not a second app on this Mac (lessons: stray-app-copies)
rm -rf "$BUILT"

# 6. the machine ledger (~/.anjou/versions.json, one entry per app id; AGENTS.md §7)
mkdir -p "$HOME/.anjou"
node -e "
const fs=require('fs'),f=process.env.HOME+'/.anjou/versions.json';
let l={};try{l=JSON.parse(fs.readFileSync(f,'utf8'))}catch{}
l['$APP_ID']={version:'$VERSION',build:'$BUILD',commit:'$COMMIT',installedAt:new Date().toISOString(),app:'$DEST',source:'$HERE'};
delete l.rkeychat;
fs.writeFileSync(f,JSON.stringify(l,null,2)+'\n')"

# 7. relaunch through LaunchServices: its own process, its own daemon, its own permissions
open "$DEST"
echo "shipped: rKeyChat $VERSION (build $BUILD) → $DEST"
echo "to the update channel (every device on it sees it): npm run release -- --notes 'what changed'"
