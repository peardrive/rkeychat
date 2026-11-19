#!/usr/bin/env bash
# Wait for one turn and exit.
#
# For Claude Code: run under Bash run_in_background, so a notification arrives only
# when there is really something to answer — no 30-minute watch expiries, each of
# which costs a whole model turn. Unanswered turns stay queued in the daemon, so the
# gap between exit and relaunch loses nothing.
#
# This used to pipe `wait` through awk and rely on the writer dying of EPIPE once awk
# had seen the end of a turn. That only happens if the writer writes again, so whether
# the pipeline exited was a race — and when it lost, the turn sat in the output file
# with nobody woken to read it. `wait --once` exits on its own.
cd "$(dirname "$0")/.."
exec node bin/rkeychat.js wait --once "$@"
