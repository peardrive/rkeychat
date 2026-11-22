# Debug notes: the one module every app gets

*2026-10-20. Guy: "build out a module that is basically universal … so this can be super fast
implemented into every single tool we're using."* This is that module, as it exists today in two apps,
and the recipe for the third. The design is pearcast's `docs/NOTES-MODE.md` (pearcast-projects).

> **Where the shared copy lives (2026-10-28):** `~/Anjou/pear-ui/debug/` today (PearDrive vendors it), moving into
> the library repo **Pearkit** (`github.com/peardrive/pearkit`). rKeyChat still runs the older in-app copy described
> below. Not `PearDrive-UI`: that repo was a stale mockup and was deleted on 2026-10-28.

## What a note is

Three files, always, whatever app made it:

| file | what |
|---|---|
| `note.<webm\|ogg\|m4a>` | the voice: what you said while using the app |
| `trace.jsonl` | one line per step taken while the recording ran, each with `t` (seconds into the recording) |
| `note.json` | `id`, `startedAt`, `seconds`, `steps`, `app`, `window`, `userAgent`, the audio file's name, plus whatever the app adds (room, panel) |

A step is `{ t, kind, text, data? }`. `kind` is one of:

- `log` — the app's own log line (`[room] joined …`). The app already names what it did; the trace keeps it on the recording's clock.
- `click` — a control, by its label (`Invite`, `room: PearDrive Lab`), with `data: { in, at, el, rect }`: the region of the screen, the pointer position, the element's short DOM path (`div#panel > section.agents > button.primary`) and its box on screen.
- `tap` — something that is not a control (a message bubble, by author), same `data`.
- `focus` — a field was entered (its placeholder or label; never what was typed).
- `scroll` — one step per run of scrolling, with where it ended.
- `ui` — state at the start of the note (room, panel).

Repeats within two seconds collapse into the kept step (`until`, `times`), so a drag or a scrub is one line.

## Where it goes

Each app has **one pearcore space of its own for notes**, shared read-only by link: `permissionRead: true`,
`permissionBroadcast: false`, `broadcastWhitelist: [this device]`. The app announces every saved note's files
into it. Whoever is helping joins by the link and pulls the notes — on their own machine, with their own agent.
A note written with the network off is still saved; it is announced the next time the space is up.

## The two halves, and where they live today

| half | rKeyChat | pearcast |
|---|---|---|
| recorder in the page (`createTrace({ log, save })`) | `src/ui/index.html` (search `createTrace`) | `spikes/capture/src/trace.js` |
| hooks: click/tap/focus/scroll with `at`/`el`/`rect` | `src/ui/index.html` (search `touched(`) | `src/ui.js` semantic hooks |
| store: files on disk + the space + announce | `src/debug-notes.js` (`DebugNotes`) | `main.js` (`debug:space`, `debug:note`) |
| transport page → store | `POST /api/debug/note` (`src/server.js`) | Electron IPC |
| listing / link | `GET /api/debug/notes`, `GET /api/debug/space`; `rkeychat notes [ID]` | Settings → Debug notes link |
| reader's side | `rkeychat notes ID` prints the trace, audio path beside it | `scripts/debug-notes.mjs --packet` |

The recorder knows nothing about the app around it: it takes a logger with `subscribe(fn)` and a `save`
function. The store knows nothing about the page: it takes bytes and a trace. Those two seams are the
module.

## Adding it to the next app (about an hour)

1. **A logger with `subscribe`** in the page. If the app already logs what it does by name, done.
   If not, add `log.info(scope, msg)` where the app does something a person would name.
2. **Copy `createTrace`** from `src/ui/index.html` (rKeyChat) into the page, and the four listeners
   below it (`click`, `focusin`, `scroll`, plus the `touched`/`domPath`/`box` helpers). Change the
   `region()` selectors to the app's own areas. Set `app: '<name>'` in `meta`.
3. **A mic button** that calls `trace.start()` / `trace.stop({ …state })`, shown only when a Debug
   mode toggle is on.
4. **Copy `src/debug-notes.js`** (`DebugNotes`) into the app's process. It needs a pearcore `core`
   (for `space.create/list` and `drives.get`) and a device key for the whitelist; change `SPACE` to
   `<app>-debug`. Expose `save`, `list`, `info` over whatever the page already talks to the process
   with (HTTP route, IPC, bridge).
5. **Show the link** (`info().sharelink`) in Settings and in the CLI, so a helper can join.
6. **Anything selectable should have a stable, nameable identity** (an id or a label the trace can
   print), not just a position. That is the one thing the module asks of the app.

The audio is base64 in the POST body in rKeyChat (fine up to a few minutes); for long notes or an IPC
transport, pass the bytes directly.

## Reading a note

`rkeychat notes` lists them; `rkeychat notes <id>` prints the trace with the audio's path beside it.
Transcribe the audio (Parakeet is in the tree: `src/stt.js`), then walk the transcript sentence by
sentence with the steps that happened before the next sentence — pearcast's `--packet` format. One
issue per thing said. Mark the note processed. The exact words stay on disk; nothing is quoted from
memory.

## Getting a note off the device it was taken on (2026-10-28)

Each device's notes sit in its own read-only space, and nothing pulls that space by link yet. The way a note
travels is **the room**: when a note is saved the app asks "Share this note to <room>?"; saying yes shares its
files by hash (`<id>-note.m4a`, `<id>-trace.jsonl`, `<id>-note.json`) and posts one message with `via: 'note'`,
which opens no agent turn and spends no rounds (`turns.js`). Desktop daemons fetch the files the moment that
message lands (`room.js`, `#ingest`), so a phone can go back to sleep; phones never auto-fetch. From the CLI:
`rkeychat notes share <id> --room <room>`; a helper reads them with `rkeychat files` / `rkeychat get ROOT`.

**Pulling by link (2026-11-05).** `rkeychat notes pull <link>` (or the field under Settings → Debug) joins the other
device's notes space, waits for its file list and fetches the notes into `debug-notes/from/<host>/notes/<id>/`;
`rkeychat notes` lists them with `from`. The other device must have rKeyChat open: it is the only holder. A note
that got no microphone now records why (`noAudio` in note.json, a `No audio:` line in the trace) and tells the person
the fix; in the desktop app on macOS that is System Settings → Privacy & Security → Microphone.

**In Pearkit (2026-11-08).** The module now lives in the library repo as TypeScript: `pearkit/src/debug/` (trace,
web recorder, DOM capture, `createDebugNotes`) and `DebugNotesButton` / `useDebugNotes` in
`pearkit/src/components/DebugNotes/`, guide `pearkit/docs/debug-notes.md` (issue peardrive/pearkit#13). Same three
files per note, same step shapes, so this app's store, `rkeychat notes` and the reader side are unchanged. rKeyChat's
in-page copy (`createTrace` in `src/ui/index.html`) stays until the GUI moves onto Pearkit; `~/Anjou/pear-ui/debug/`
is the plain-JS mirror for the vanilla apps.

## The bubble and the dot (2026-11-22)

A note taken on the phone was arriving on the Mac hours late or not at all, and nothing on the phone said which. Two
small things now say it, both from PearKit:

- **The dot.** The debug button carries a 6px dot at its corner (`DebugNotesButton connection=`): green and glowing
  while a reader is on this device's notes space, grey when none is. The daemon knows from the sockets on the
  space's topic (`DebugNotes.peers()`), and the shell asks `GET /api/debug/sync` every ten seconds.
- **The bubble.** When a note stops, a pill comes up at the bottom of the screen (`SyncBubble`, above the dock or the
  composer) and follows the note: *Saved · checking the sync* → *Waiting for the Mac · open rKeyChat there* (or
  *macbook is connected · waiting for it to fetch the note*) → *Sending to macbook · 2 of 3 files* → *On macbook ·
  3 files*, then it goes on its own four seconds later. A note that could not be saved, or whose space is down,
  says so and stays eight seconds; a wait gives up after two minutes (the state is still shown beside the note in
  Settings › Debug, as a pill). Tap the bubble to dismiss it. While a bubble is up the shell asks every 1.5 s.

How the phone knows: pearcore tells the serving side about every `SpaceFileTreeRequest` and
`SpaceFileContentRequest` it answers. `src/debug-notes.js` keeps, per reader key, which note files were asked for
and which had their last chunk asked for (file size ÷ 256 KB chunks); a note is `fetching` once a reader asked for
any of its files and `fetched` once every file's last chunk went out to one reader. The reader's name comes from the
owner's device list when the key is one of them. Only this session is remembered: after a restart a note shows as
waiting again until it is asked for again, which is honest enough. The rules are tested in
`test/debug-notes-sync.test.js` (daemon), `app/src/debugSync.test.ts` (the words), PearKit's `syncState.test.ts`,
and the GUI test "debug note: a bubble at the bottom…" drives the whole thing in a browser against the mock.

**A pull that is not going to work now says why.** pearcore (156a268) drops a peer's `Reject` on the floor inside a
download, so a pull of a file the other side refuses waited ten minutes in silence. The daemon now listens for
`Reject`, logs it (`[debug] <peer> refused a request: <reason>`), and a pull fails within 90 s per file naming the
refusal. `GET /api/debug/downloads` lists this device's downloads in flight (providers, whether the tree is known).
