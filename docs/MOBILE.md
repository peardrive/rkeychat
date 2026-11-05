# rKeyChat on the phone

*2026-09-29. The Mac hosts it; the phone is a paired browser on the tailnet.*

## How to get on

1. On the Mac: gear → Settings → **Phone** → *Turn on phone access* (already on) → **Pair a phone**.
2. Scan the QR with the iPhone camera. It works once and expires in 10 minutes. It sets a year-long, HttpOnly cookie for that phone.
3. Safari → Share → **Add to Home Screen**. It runs full screen, without Safari's bars.
4. Unpair from the same Settings section. The phone is locked out on its next request.

## Where the phone's pearcore comes from (2026-10-28)

The Bare backend (`bare/package.json`) pins pearcore from the mobile repo, by tag:
`git+https://github.com/peardrive/pearcore-mobile.git#v0.1.0-bare.N`. That repo is the home of the former
`feat/bare-mobile` branch of `peardrive/pearcore`; every mobile/iOS app works from it, and the desktop engine stays
on `peardrive/pearcore`. The old `file:../../pearcore-mobile` worktree path is gone: never point at a local folder.

To take a new pearcore: bump the tag in `bare/package.json`, `cd bare && npm install --ignore-scripts`, then
`cd ../mobile && npm run bundle` (which regenerates `bare/core` from `../src` and packs `mobile/app.bundle.mjs`),
and reinstall the app on the phone. The desktop daemon still vendors `vendor/pearcore-156a268.tgz`.

Debug notes taken on the phone stay on the phone until shared: after saving one, tap **Share** in the prompt and
it goes into the current room as files (no agent turn); the Mac fetches them at once. See `docs/debug-notes-module.md`.

## Security

- The page is only reachable on the tailnet: `http://macbook-pro-2.tailb0cab1.ts.net:4455`, or the https name once certs are on. Nothing is public.
- Each request from a device other than the Mac needs a paired session cookie. Anything else gets a 401 or the pairing page.
- Managing access (turning it on, pairing, unpairing) is Mac-only, so a paired phone can't mint more phones.
- For now the phone acts as Guy: it posts with Guy's key through the Mac. Later the phone could be its own rKey device key, enrolled under Guy's root, so it can be revoked on its own and shows up as "guy · iPhone".

## Screen real estate: what the phone gets

| Desktop | Phone |
|---|---|
| title bar, dock | gone; the chat owns the screen |
| sidebar | its own screen (header rooms button). The app always opens on the chat |
| room header (faces, Invite) | rooms · faces · name · **⋯** (Invite, Agents, Keys, Settings, Pause) |
| agent strip (round x of y, Pause) | hidden unless it needs you: paused, agents waiting on you, or someone thinking (then just "Pause") |
| panels | full-screen sheets |
| hover actions | long-press a bubble to react; head tools always shown |
| composer | 16px text (no iOS zoom-on-focus), one-line placeholder, safe-area padding |
| mic and memo buttons | only on HTTPS. Over plain http iOS gives no mic, so they're hidden and the keyboard's own dictation key does the job |

## Dictation from the phone into Parakeet on the Mac

It's the same pipe as desktop live dictation: the phone captures 16 kHz mono PCM, sends it over the `/api/live` WebSocket, and the Mac runs Parakeet in-process and streams partials back. Nothing new on the server.

**The one blocker is iOS:** it only allows the mic in a secure context, which means HTTPS. Steps:

1. Tailscale admin console → **DNS** → enable **HTTPS Certificates** (one toggle).
2. Settings → Phone → **Switch to HTTPS**. This runs `tailscale serve --bg --https=443`, so it's still tailnet-only.
3. Pair the phone once more. The https origin is a different site, so the old cookie doesn't carry over.

After that, the mic and voice memos on the phone go to the Mac's Parakeet, with the same glossary and autocorrect.

## Next ideas (to try, not built)

1. **Clamp long agent messages** on the phone to ~12 lines with "Show more". Today one Kimi essay can fill the whole screen. This is the biggest remaining real-estate win.
2. **Push-to-talk:** hold the mic, talk, release to drop the text in. Tap keeps today's toggle behavior. Works one-handed.
3. **Swipe a bubble right to reply**, and swipe in from the left edge for rooms (iMessage idioms).
4. **Dictation robustness (Kimi's list):** a visible "listening" state; buffer a few seconds of PCM through network blips; stop cleanly when iOS kills capture on screen lock or backgrounding.
5. **Notifications:** iOS web push needs HTTPS plus a home-screen app (iOS 16.4+). Once HTTPS is on, it's possible to be pinged when an agent @mentions you or runs out of rounds.
6. **Phone as its own rKey device** (see Security).
