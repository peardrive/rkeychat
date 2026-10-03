#!/usr/bin/env bash
# Stream turns for an agent and EXIT on the first complete one.
# For Claude Code: run under Bash run_in_background, so a notification arrives
# only when there is really something to answer — no 30-minute watch expiries,
# each of which costs a whole model turn. Unanswered turns stay queued in the
# daemon, so the gap between exit and relaunch loses nothing.
cd "$(dirname "$0")/.."
exec node bin/rkeychat.js wait "$@" | awk '
  /^=== rkeychat turn for/ { inturn = 1 }
  inturn { print }
  /^=== end turn ===$/ { exit }
'
