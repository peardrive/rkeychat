# In-app updates

Guy, 2026-11-25: "one main .dmg app in my Applications folder which we can continue to sign and update, so that I have
one location with one main way to launch it and I won't have twenty old builds and outdated versions lying around."
And the updater "should be available in PearKit as a main module that we want everywhere."

## The shape

- **The module is PearKit's.** `pearkit/updates` holds the release record (the shape every installer's `.release.json`
  has, `~/Anjou/_deliveries/AGENTS.md` §3) with `signRelease` / `verifyRelease` over the record's canonical JSON, and
  `UpdateChannel`: which releases are for this computer, which is newest, how far behind this copy is, the download
  and the hand-over to the swap. `pearkit/electron`'s `installUpdate` does the swap; `UpdatesPanel` and `UpdateNotice`
  are the block in Settings and the notice in the sidebar. PearDrive's updater is where it all came from; every app
  now runs the same code.
- **The channel** is a pearcore Space that mirrors `~/Anjou/_deliveries/rkeychat-desktop/`, published by Guy's Mac.
  Its link and the publisher's device key are baked into `src/updates.js` (`DEFAULT_CHANNEL`); Settings › Updates ›
  Advanced shows them. The Space carries the installers and, beside each, its signed record; a record from any other
  key is dropped, however it is worded. A machine that already has the deliveries folder (an agent box, through
  PearDrive) can read the folder directly instead: `POST /api/updates/channel { folder }`.
- **On a device**: the daemon joins the channel Space at start (`src/updates.js`), fetches every `*.release.json`
  it lists (they are tiny), verifies each with rkey's ed25519 and hands the publisher's to the channel. When a
  newer version for this platform is there, the sidebar shows **Update to X** and Settings › Updates says
  "rKeyChat X is ready". One press fetches that installer through the Space, checks it against the record's size
  and sha256, and hands the path to the desktop app.
- **The swap** (`electron/main.js` → `installUpdate`): the new build is asked to load its native modules first
  (better-sqlite3, sodium-native) and refused if it cannot; a detached helper waits for the app to quit, moves the
  running bundle to `~/.rkeychat/updates/previous.noindex/` (never beside the app: Spotlight lists any `.app` it
  finds), puts the new one in `/Applications/rKeyChat.app`, and opens it. A Developer ID-signed build is left exactly
  as it came. On Linux the AppImage replaces `$APPIMAGE`.
- **The way back**: when the new build's daemon does not start, the app says so and offers "Go back to the previous
  version" (the swap in reverse; the failed build is set aside under `failed.noindex/`, and that version is written to
  `~/.rkeychat/updates/failed-start.json` so the copy gone back to does not offer it again).
- **A source tree** (`npm run app`, `rkeychat start`) has nothing to swap: Install says where the file is.
- **A phone** has no desktop build: the module is a stub there, and Settings shows no Updates block.

## Routes

`GET /api/updates` (the channel's state, also pushed as `updates` events), `GET /api/updates/release?id=`,
`POST /api/updates/check`, `/download { id? }`, `/install { id? }`, `/channel { link, publisher } | { folder } |
{ reset: true }`; for the publisher `POST /api/updates/record { record }` (signed with this device's key) and
`POST /api/updates/publish { folder? }` (the Space made once, the folder's installers and records registered).
`GET /api/state` carries `device.version`: the running version, build counter, commit and where the copy runs from.

## Shipping

```
npm run ship                               bump PATCH + build counter, build (signed, notarized), install into /Applications, relaunch
npm run ship -- --build-only               bump + build only (the installers land in _deliveries/rkeychat-desktop/)
npm run release -- --notes "what changed"  sign a record beside every installer of this version, register the folder in the Space, run the deliveries check
git push origin v<version>                 the Linux build on GitHub Actions (.github/workflows/linux.yml); download its artifacts into the folder, then release again
```

`scripts/ship-app.sh` writes `src/build.json` (the build counter and commit the running copy reports; git-ignored),
stops any daemon running from a source tree on the device's port before opening the new app (an installed app
attaches to a daemon already on the port and would show the old code with the new icon), leaves nothing beside the
app in /Applications, and records the install in `~/.anjou/versions.json` under `rkeychat-desktop`.
`scripts/release.mjs` needs the running rKeyChat on this Mac: it holds the key.

## Verified (2026-11-25)

- pearkit: 17 tests on the record and the channel (signing, a stranger's record dropped, pending and versions,
  download progress, a refused build, the swap helper run against a throwaway bundle and the way back).
- rKeyChat: `test/updates.test.js` (records signed by the device and verified with rkey, a deliveries folder as the
  channel, an installer whose bytes are not the record's refused, the hand-over to the desktop app), 90 daemon tests;
  the shell's store test and two GUI tests (the block, the release window, one press to restart; up to date).
