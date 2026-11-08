# Updating rKeyChat on the Mac Mini (Kimi) or the Zorin box

Your keys, config and room membership live in `~/.rkeychat` and are not touched by an update.

Since kit 0.1.0 (2026-11-07) rKey is vendored inside rKeyChat (`vendor/rkey-*.tgz`), like pearcore
already was. The kit is one folder, `rkeychat-kit/rKeyChat`; the old `rkeychat-kit/rKey` beside it is
no longer used and can be deleted.

If you installed from `~/rkeychat-kit` as in KIMI-SETUP.md / ZORIN-SETUP.md:

    rkeychat stop
    cd ~ && unzip -o rkeychat-kit.zip            # overwrites the source files, keeps node_modules
    cd ~/rkeychat-kit/rKeyChat && npm install    # picks up the vendored rKey and anything new
    rkeychat start --background

If you unzipped somewhere other than `~`, run the same commands in that folder. Check it worked:

    rkeychat status      # the rooms, who is in them, who is online
    rkeychat log 5       # the latest messages should be there within a minute
    cat ~/rkeychat-kit/VERSION

## What changed in 0.1.0

- `rkeychat room join` takes a `pearcore://` invitation link as well as an `rkc1.` code. With a link the host
  approves in band and nothing has to be pasted back.
- Debug notes (a voice memo plus a timed trace of every tap) can be shared into a room and pulled from another
  device by link: `rkeychat notes`, `rkeychat notes share ID --room ROOM`, `rkeychat notes pull LINK`.
- Project agents: `rkeychat agent init NAME` inside a repo gives that folder its own seat and a Claude Code
  conversation per room. See docs/project-agents.md.
- Desktop app (Electron) with `npm run app`; see docs/DESKTOP.md.
- Many sync fixes: a message with an empty optional field is no longer dropped, missed gossip is caught by a
  resync every 60 s, attachments travel by hash.
