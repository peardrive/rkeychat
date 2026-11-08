# Pearcast on the iPhone — plan (draft)

Goal (Guy, 2026-11-05): Pearcast on the iPhone joins the desktop project's space and records into its timeline.

Drafted by @rkeychat from what the room has established. This session cannot read pearcast-projects or
peardrive-photos, so every file/line below is from the room, not verified — @claude-studio's second pass
checks it against the code.

## What already exists

| Piece | Where | State |
|---|---|---|
| Project = pearcore space, invite = plain `pearcast://` link, knock → owner lets in as editor | pearcast-projects `projects-sync` (2f1d1dd+), `npm run test:apps` | proven desktop↔desktop, incl. LAN bootstrapper |
| What syncs as files | takes (chunks, peaks, scene events, `take.json` after its chunks), `media/`, `library.json` | proven, byte-identical |
| What does NOT sync as files | timeline + threads: `op` / `hist-req` messages between running apps | only while both apps are open |
| pearcore on Bare, on the phone | `peardrive/pearcore-mobile` @ `v0.1.0-bare.4` | rKeyChat-mobile bundle built, not yet run on a phone |
| Phone joins a desktop space, knock, allow, push files, desktop confirms each so the phone drops its temp copy | `peardrive/peardrive-photos` `bare/app.js`; lab `photos-worklet*.mjs`, `photos-suspend`, `photos-two-members` | proven in the lab |
| QR scanner + paste-a-link modal | pearcast `tools/space-modal.js` (jsQR) | desktop; reusable in a WebView |

## v0 — roughest working version (agreed with @peardrive, 2026-11-05)

Phone records a plain `.mov` (native camera) → Photos' Bare backend `add`s it at `media/phone/<date>.mov` in the
project space → desktop pulls it → a desktop watcher imports new member files under `media/` and appends them to
the end of the timeline. No take format, no timeline code on the phone.

Blockers, in order:
1. **Join from the phone** — Photos' phone *owns* its space; here it must *join* the desktop's. Check whether
   `peardrive-photos/bare/app.js` has a join command (needs someone with peardrive-photos access).
2. **Desktop watcher** for `media/` (the known "files added outside the app aren't scanned" gap) + append to
   timeline. Pearcast side — @claude-studio.
3. **pearcore pin** — Photos is on `bare.1`; `pearcore-mobile` carries the same tags through `bare.4`, so
   moving is a tag bump on the same line, not a port.

## Shape (v1)

One iOS shell (start from PearDrive Photos' shell, not a new one), three parts:

1. **Bare worklet** — Photos' `bare/app.js` pattern on `pearcore-mobile`, pointed at a `pearcast://` link
   instead of a PearDrive one. Joins, knocks, keeps the project folder, pushes new take files.
2. **Recorder** — native capture (AVFoundation) writing the *same take format* the desktop writes: chunks,
   then `take.json` last (the desktop already relies on that order to know a take is complete).
3. **UI** — small: Join (scan / paste), project name + "let in" status, a big record button, a list of takes
   with sync state. No editor on the phone in v1.

## Getting the take into the timeline

Two options; recommend **A** for v1.

- **A. Desktop places it.** The phone only adds files. When the desktop sees a complete take from a member
  (its `take.json` lands), it places it — append to the end of the timeline, or into an "Inbox" lane the editor
  drags from — and broadcasts that as an ordinary timeline op. Phone needs no timeline code at all. Cost: the
  desktop must be running for placement (it is, in the target scenario).
- **B. Phone sends the op.** The phone speaks the `op` protocol itself. More code on the phone, a second writer
  of timeline ops, and the op ordering/history (`hist-req`) has to work over a phone that suspends. Later, if
  ever.

## Steps

1. **Prove the format headless** (no phone): a Node script that plays "phone" — joins by link, writes a take in
   the desktop format from a fixture clip, and the desktop under `test:apps` places it (option A). This settles
   the take contract and the placement rule before any iOS work. *Owner: @claude-studio (knows the take code).*
2. **Desktop placement** — "new take from a member → timeline" behind one module, with a setting (append /
   Inbox / off). Same isolated-module pattern as host-matte.
3. **Worklet** — fork Photos' `bare/app.js` into a Pearcast worklet; run Photos' lab tests against a Pearcast
   owner (`test:apps --owner`) to prove join + push from Bare.
4. **iOS shell** — Photos' shell, Pearcast colours, Join modal (scanner + paste, same flow as desktop), record
   button. Recorder writes chunks to the project folder as it records, so a long take is mostly synced by the
   time it stops.
5. **On a phone over LAN** — Guy's iPhone, desktop owner on the MacBook, LAN bootstrapper. Record → see it on
   the desktop timeline.
6. Then: thumbnails for synced takes (r10-09T23-20#7 — they exist only in memory while recording, so a phone
   take arrives with none), public DHT when off-LAN.

## Edge cases to guard

- **App backgrounded mid-take or mid-sync.** iOS only syncs in the foreground: resume on return; the take is only
  "done" when `take.json` is written, so a half-synced take never gets placed.
- **Phone take with no desktop running** — files wait on the phone; placement happens when both are up. Show
  "waiting for the studio" on the phone.
- **Two phones / phone + desktop recording at once** — placement order by take start time, not arrival time.
- **Clock skew** between phone and desktop — use the desktop's clock at placement, keep the phone's in the take.
- **Formats** — phone codec/resolution/fps vs the desktop's; the desktop decode path must accept them (HEVC?).
- **Storage** — the phone should not pull the whole project (97 MB for a small one): join for push only, or
  pull just `library.json`, not media.
- **Permissions** — the phone joins as editor only to add takes; does it need edit rights on the timeline at all
  under option A? (A narrower "contributor" role would be safer.)
- **Delete on the phone** — after the desktop confirms, as Photos does; never before.
- **Re-join / link revoked / owner removes the phone** — the phone must say so, not keep recording into nothing.

## Open questions for Guy

1. Phone take lands where: end of the timeline, or an Inbox lane you drag from?
2. Does the phone need to see the timeline (read-only playback), or only record into it, for v1?
3. Only LAN for v1, or public DHT from the start?
