# A project's home device, what syncs, and who may spawn what

*2026-11-18, from Guy's note after the first `projects` build: the folder lives on one computer; what syncs and what
must not sync has to be systematic (no room taken down by a stray `node_modules`); the space directory and the disk
need one obvious way to move between them; the agent spawns on a particular computer; nobody who merely joins a
room may spawn agents on my machine. Companion to `projects-and-conversations.md` and `projects-api.md`.*

## 1. Every project has a home

A project's folder lives on exactly one device: its **home**. The signed app note gains it:

```
{ action: 'app', app: 'rkeychat', role: 'project', name, home: { device: <device ref>, name: 'macbook' } }
```

The home is where the seat runs, where "Open folder" means something, and where files are read from disk.
Every other device sees the project through the space: its conversations, its prompt, and its file index. The
home can move: the owner signs a new note with another of their devices as home, and that device becomes the one
that runs the seat (the old one stops it). This is PearDrive's *move* applied to a whole project: the hashes, the
index and the history stay, only where the bytes sit on disk changes. A folder path never appears in a record
(space-directories edge case 12); it stays in that device's config.

**Starting a project from the phone.** "New project" on a device that cannot hold a folder (the phone) asks one
thing: *where should it live?* The list is your own devices, from the chain (the keys under your root) and
presence (which are online now). Pick the MacBook; the phone signs a `project` request; the MacBook's daemon
creates the folder under its **workspace root** (a setting, default `~/Projects`), makes the room, the note and
the seat, and the project appears on the phone a moment later. Later, on the MacBook, "Move folder…" relocates it
anywhere on disk; nothing in the space changes.

Defaults: one workspace root per device, every project a folder directly under it unless you choose otherwise.
`rkeychat project init DIR` keeps working for a folder that already exists.

**The request's life** (settled after "Leaf Note", 2026-11-19, when the MacBook made a project called "guy"
from the viewed copy of the request, then removed it without telling the phone). The home device reads the
request from the *signed* record (`src/project-requests.js`; the viewed copy's `name` is the author), makes the
project, and answers with the room's `app` note carrying `request: <the control's id>`. The phone matches the
arrival by that id, not by name. A request is marked done only once it is answered, so one that fails is tried
again at the next record and at every start (the daemon sweeps each room's `project` controls when it opens
it). A name already in use on the home is the answer: that room's note gains the request id. Until a room
answers, the phone shows the wait: `GET /api/projects/pending`, a "Waiting on macbook" row in Projects with a
way to stop waiting; unanswered requests expire after 30 days.

**Closing a room.** The owner removing a project writes a signed `close` control first (owner's keys only, like
`project`), then drops the room. Every other device that holds it, the owner's phone included, removes it when
it sees the record, at once when online and at its next start otherwise. A member's device leaves instead
(self-revoke); it cannot close what it does not own.

## 2. What syncs, and what never does

Today rKeyChat syncs **nothing from a folder on its own**: a file enters the space only when someone shares it
(`rkeychat send --file`, the paperclip), by hash. Messages and file announcements are separate small records;
bytes move on demand (`fetchFile`, capped blobs). A project cannot flood a room by existing. Keep that as the
floor: *nothing leaves the folder unless it is shared or a watcher is deliberately connected.*

When a project wants its assets in the space (a pearcast project's media, a design folder), connect a watcher
the PearDrive way, with the same three rules:

1. **The ignore list is built in and the dangerous things are refused.** PearDrive's `ignore.js` already ships
   `node_modules/`, `.git/`, build and cache folders as defaults, with git-style directory semantics and a
   per-folder `.pearignore`; re-including `node_modules` is refused at registration unless written explicitly
   in that folder's own `.pearignore`. rKeyChat uses that module, not a copy, and adds its own: `.rkeychat/`,
   `.env*`, `*.key`, `*.p8`, `*.pem`, `dist/`, `build/`, `release/`, `*.log`.
2. **Hard caps that pause and ask, never silently continue.** Per connection: files and bytes (say 10,000 files
   or 20 GB), registrations per minute, and a maximum share of the space's record stream. Crossing one stops
   the watcher and shows a line in the project pane ("Watching paused: 10,000 files reached in `src/`, 38,000
   more found. Keep going? Ignore `vendor/`?"). A paused watcher is a notice, not a failure.
3. **Collect or mirror, per connection** (edge case 4): a watched folder adds links by default; removals
   propagate only when the connection is set to mirror. The space is the archive, the folder is an inbox.

And the structural guard that makes a storm survivable: **messages and the file index are different record
kinds with different budgets.** A file announcement burst can be throttled or dropped by a peer without touching
chat; blobs are fetched on demand, never pushed in bulk. That is already the shape of `#onSpaceMessage`; the rule
is written down here so nobody merges the two streams for convenience.

## 3. One way to move between the space and the disk

The project pane gets a **Files** section that is the space directory: links by hash, each with its state on
*this* device:

| State | Shown as | Action |
|---|---|---|
| on this device | the path, "Open" | Open in Finder / the app |
| on another device | "on macbook" | Fetch (bytes come by hash into the local cache) |
| fetched here | the cache path, "Save to…" | places a copy where you want it; the link is unchanged |
| nobody online has it | "unavailable, last on zorin" | nothing; honest state |

The mental model is one sentence: *the space is the index; a device holds copies.* The home device holds the
originals and says so. Dropping a file on a conversation shares it (today's path); dropping a folder on the
project pane connects a watcher (section 2), with a preview of what would be linked before anything is.

## 4. Where an agent spawns, and who may ask

A seat runs on the project's home, from the project's folder, with the lab tool list (read anything beside the
project, never the `_` business folders, run the project's own toolchain, no bypass). That part exists.

Who may make it exist is the new rule: **project and seat controls are account-gated, not member-gated.**

| Control | Who may sign it |
|---|---|
| post, react, share a file | any member with `chat` |
| prompt, budget, pause, rename, conversations | admins (humans) of the room |
| `project` (create here), `home` (move), `seat` (start/stop/tools), `watch` (connect a folder) | **only keys under the room owner's root**: the owner's own devices |

The home daemon checks the signature against the chain before acting: the author must be an active key whose
parent is this device's root. A member, even an admin, who sends a `seat` control gets nothing. This is the
same check `approve()` and `ownDevice` are supposed to make, which is why the audit's H1 (a stranger enrolled
as the owner's device) is the prerequisite: with H1 open, "account-gated" is only as strong as the join prompt.
Fix H1–H3 before projects leave this Mac.

Transport-wise pearcore already drops traffic from devices outside the space's whitelist, and `#admits` drops
records not signed by an active key with the right scope. The account gate is one more clause in `#admits` for
three control actions, plus the chain's parent pointer. No new key material, no new protocol: a phone logged into
the same account is a key under the same root, so "spawn on my MacBook from my phone" is allowed and "spawn on
Guy's MacBook from Jeffrey's phone" is refused by construction, with nothing for a person to configure.

What stays explicit for the trusted-but-careful case: a seat's tool list per project (`rkeychat agent tools`),
and a per-device switch "accept project requests from my other devices" (default on) so a machine can be a
member of rooms without ever being a home.

## 5. Order

1. `home` in the app note, workspace root setting, "New project" on the phone picks a device, the home creates it
   (a `project` control, account-gated). 1–2 days.
2. The account gate in `#admits` for `project` / `home` / `seat` / `watch`, with a test that an admin member's
   control is refused and the owner's phone's is accepted. 1 day. (After H1–H3.)
3. Files section in the project pane over the existing share/fetch calls, with per-device state. 2 days.
4. Watchers: PearDrive's `ignore.js` as a dependency, caps that pause, collect/mirror. 2–3 days, after PearDrive's
   space-directory work lands so the two apps share the records.
5. "Move folder…" on the home (disk only) and "Move home" (a new note). 1 day.
