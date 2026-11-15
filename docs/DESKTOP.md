# rKeyChat as its own app

*2026-10-20. Guy: "I'm done with the browser tabs. Everything needs to be its own app."*

The desktop app is the daemon and its UI in a window: the same `src/ui/index.html` the browser
gets, served by the same `src/server.js`, with Electron as the frame. It is `electron/main.js`,
the same shape as PearDrive's (`peardrive/electron/main.js`), and nothing in `src/` knows it is
inside an app except one fact the preload exposes (`window.rkc.desktop`).

## Run it

```sh
npm run app          # dev: opens the window on this device's daemon
npm run dist:mac     # package: release/rKeyChat-<version>-mac-arm64.{dmg,zip} → ~/Anjou/_deliveries/
npm run dist:linux   # on the Linux box: AppImage + deb
```

## Where the daemon comes from

Three cases, tried in that order at launch (`ensureDaemon` in `electron/main.js`):

1. **A daemon is already running** on this device's port (`rkeychat start` in a terminal, or
   `--background`). The app attaches to it. Closing the window, or quitting the app, never touches
   it. This is the everyday case on the MacBook: Claude's `rkeychat wait` and the other CLI commands
   depend on that daemon, and the window is just a view on it.
2. **None is running: the app boots it in-process** (`bootDaemon` in `src/daemon.js`, the same
   function `rkeychat start` uses). This is what the packaged app does. Quit stops it.
3. **The in-process boot fails on a native module** (`better-sqlite3`, pearcore's database, is built
   for one Node ABI at a time, and the dev tree is built for plain Node). The app then runs
   `node bin/rkeychat.js start` as a child and attaches to that. Quit stops the child.

So from the dev tree `npm run app` works without rebuilding anything, and the packaged app is
self-contained because `scripts/build-app.sh` rebuilds `better-sqlite3` for Electron while
packaging and for plain Node again afterwards.

Closing the window on macOS leaves rKeyChat in the dock; the dock icon reopens it. On Linux and
Windows closing the window quits.

## What the frame adds

- **Microphone** for dictation and debug notes without a browser's prompt: the permission handler
  allows `media` for our own origin only, and macOS is asked once through `askForMediaAccess`
  (`NSMicrophoneUsageDescription` is in the app's Info.plist via `build.mac.extendInfo`).
- **Links** (`https://…`, sharelinks shown as URLs) open in the system browser, never in a second
  rKeyChat window.
- **One instance**: a second launch focuses the window.

## Debugging it while you use it

Settings → Debug mode → the mic button in the title bar. Talk and keep using the app; press again
and the note lands in `~/.rkeychat/debug-notes/notes/<id>/` and is announced to the
`rkeychat-debug:<device>` pearcore space, whose link is shown in Settings and by
`rkeychat notes`. See [debug-notes-module.md](debug-notes-module.md) for what a note holds and how
the same thing goes into any other app.

## Not yet

- Signing and notarisation (`identity: null`): a built dmg opens with right-click → Open the first time.
- A tray/menu-bar presence. The dock is enough for now.
- Windows builds.
