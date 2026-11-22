# Round 2: one kind of thing, a home screen, bots you can see, a wiki that travels

*2026-11-19, from Guy's first real use of the projects build on his phone. What broke, what he asked for, and the
shape proposed for the next round. Companion to `projects-and-conversations.md` and `projects-home-and-sync.md`.*

## What broke on the first project

| Seen | Cause | Fix |
|---|---|---|
| The name typed on the phone did not take; the project was called "guy" | the daemon read the project name off the *viewed* record, whose `name` is the author | read the signed record; test |
| A folder `~/Projects/guy` appeared in Guy's own projects folder | the default workspace root was `~/Projects`, which is a person's folder, not the tool's | default `~/rKeyChat`; the workspace is a per-device setting shown in New project |
| The seat was called `guy2` | the seat was named after the folder, which was named after the author | a seat is named after its project; never after a person on the device (`-bot` if it collides) |
| The whole screen zooms; a button goes off-screen | the page allowed pinch and double-tap zoom like a web page | `user-scalable=no`, `touch-action: manipulation`; viewers zoom their own content |
| The header disappears while typing | iOS scrolls the page to the focused field; the layout did not follow the visual viewport | the shell sizes its root to `visualViewport` and keeps the top bar pinned |
| "macbook offline" while the Mac's agent was answering | a device's presence window was one minute and the phone had just reconnected | five minutes, and refreshed on every presence push |
| No way to rename or delete a project | not built | rename (a signed `rename` control, as rooms always had), remove from this device (`rkeychat room remove`, `POST /api/rooms/remove`); the folder on disk is never deleted |

## The hierarchy: one kind of thing

Guy: "trying to have two different categories of thing, which are in a sense the exact same thing, doesn't make
any sense." Agreed. There are **projects**, and nothing else at the top level. A project is a space with
conversations in it; it may have a folder on a home device, seats, people. A "chat" is a project with no folder.

Above projects, one optional level for grouping: **Organization**. Not "studio" (a content creator's word),
not "repo" (a developer's). An organization is what a person would call Bitcoin Audible or Anjou: a name a
set of projects belongs to. Below projects: **conversations**, as now. Three words, each one most people
already use. Bitcoin Audible is an organization; every episode is a project in it with its own folder and
conversations; Guy's Takes episodes are projects in the same organization.

How an organization exists: as a signed field on the project's app note (`org: 'Bitcoin Audible'`), set by the
owner, so every member's sidebar groups the same way; later an organization can become its own space
(a shared wiki, its own members) without changing the grouping. Nothing is required: a project with no
organization sits at the top.

## The screens

**Home** is the first screen, not a list of rooms: an **activity feed** (what needs you: an approval, a seat
that finished, a mention; what happened: new conversations, files, members) built from the activity and
record streams the daemon already pushes, in PearDrive's one-line feed style so the module is shared. Above
it, one **+** (New project, with "in an organization" optional; New organization). Below it, the projects,
grouped by organization, each project a row that opens its conversations. No "New conversation" row inside
every project: a **+** on the project's own header, and long-press (right-click) on a project for Rename,
Move to organization, Remove.

**A conversation** has one bar at the top, glassy, three things in it, left to right: **chat** (the
conversation), **files** (everything shared in this project, newest first, with where each file is: here,
on the home device, fetched; open or save), **⋯** (the project: name, prompt, folder and home, organization,
seats, members, invite link, remove). The old separate info button goes. The bar stays put while typing.

**Messages** look like Messages: mine on the right in the brand tint, everyone else on the left, tight,
day separators, avatars kept. Tap a message: a small row with icons only, reply, copy, a + for the full
emoji picker, and the person's six most-used emoji first. Select text inside a message: a small "reply to
this" that quotes only the selection.

**A bot** has a profile: tap its name anywhere. Name and picture (changeable by the owner), which project it
belongs to and which device runs it, its role prompt in this project, its rules (wake on mention or in turn,
order, daily cap), its runtime. The owner edits; everyone else reads. Only the owner's own keys may create,
change or remove a bot in the owner's projects (the account gate from round 1).

**Settings** follows PearDrive's settings: blocks with a visual cue each, little text. This device (name,
workspace folder, "can hold projects"), the **wiki** (below), **media** (a space for GIFs and pictures to
reply with; cached thumbnails, bytes fetched from the space), peers, agents on this device, the old things.

**Add a bot** in a project's ⋯: from a device of yours that can host (each computer's daemon is an ACP host,
so "Mac Mini" and "Linux box" appear as sources), or a hosted model with a saved key (PPQ, OpenRouter) that
runs with no computer at all. Every bot made this way is a seat under the account gate.

## The wiki: one space that every agent reads

Guy's point: the new project's bot "didn't have context. It didn't know where it was or what it was from."
Every session on every machine has been told the same things a hundred times: where PearKit lives, where
the PearDrive repo is, which stack the phone uses, how we organise folders, what we learned.

The answer is one **wiki space**: a pearcore space holding Markdown, synced by PearDrive to every device,
named in rKeyChat's settings (made empty by default, or an existing space pasted in). Its shape is the
organizational standard already written down (`~/Anjou/ORGANIZATION.md`, `_publishing/lessons`, the
graphify graph): an index page, one page per project and tool with "where it lives and what it is", the
lessons, and the references. A project's system prompt gets one line: *the wiki is at <path>; read its index
when you need something outside this folder; nothing from it is loaded unless you go and get it*. That is the
"tip of the iceberg" rule: context is found when needed, never pre-loaded. graphify runs over the wiki like
any folder, so an agent can ask it before reading.

The hand-off Guy described: one page of instructions ("the wiki is here; this is its layout; add what you
know and what you learned") given to every session on every machine, and the wiki fills itself in.

## Order

1. The fixes in the table (daemon ones done; shell: zoom, keyboard, rename, remove). Same day.
2. Organizations: `org` on the app note; sidebar grouping; New project asks "in …?". One day.
3. Home with the activity feed and the + ; project long-press; the one top bar with chat / files / ⋯. Three days, PearKit first (feed row, glass bar, bot profile card, emoji picker, selection reply).
4. Messages look; bot profile; settings in PearDrive's shape. Two days.
5. Wiki space setting + the one line in every seat's prompt + the hand-off page. One day.
6. Add a bot from another device or a hosted model; media space. After.

## Round 3 (2026-11-20): the raised look, from the second memo

From Guy's notes after the dock build: Home is a little house; "All" in Projects is a globe; organizations are
three rounded squares in a huddle; every icon filled and embossed with a barely-there gradient; the button
pads embossed too, soft, never an outline; the same for the top bar in a conversation; the Activity page opens
with the longer Recent list and will also carry new rooms, published files, and later proposals and zaps.

Done in PearKit (`feat/chat-shell` b7e60b7): `Icon emboss`, `embossPad`, the nine filled icons drawn from
geometry (`scripts/draw-filled-icons.mjs`), `Dock` / `GlassBar` / `OrgTabs` on the pads, feed kinds
`project`, `publish`, `proposal`, `zap`. In the shell (25b7cce): the icons swapped, the Recent section on
Activity, a room that appears after boot announced as a `project` item. Still daemon-side: `publish` (a file
added to a project's space), and `proposal` / `zap` once those exist.

## Round 4 (2026-11-22): the Leaf Note failure

Guy talked to the seat in "the Leaf Note room" from the phone and nothing answered. What happened: on 19 Nov at
14:32 the phone asked the MacBook for "Leaf Note by Anjou"; the daemon of that hour read the project's name
off the viewed copy of the request (`name` = the author) and made a project called "guy" under `~/Projects`,
with the Leaf Note description as its charter and the phone in its room. The fix landed two hours later and the
mistake was removed from the Mac, which told nobody: the phone kept a room called "guy" with no Mac, no seat
and no presence. The request id was already on the Mac's done list, so Leaf Note was never made.

Fixed on the branch: the request is read from the signed record only (`src/project-requests.js`); it is marked
done after it is answered, never before, and every room's requests are swept at start; the answering room's
app note carries `request` and the shell matches by it; a name already in use answers the request with that
room; the owner's removal writes a `close` control first and every holder drops the room on it (at once or at
its next start); the phone shows "Waiting on macbook" rows (`GET /api/projects/pending`) until the room
arrives, with a way to stop waiting. Tests: `test/project-requests.test.js`, the reducer tests in
`app/src/store/round2.test.ts`.

### The phone, the keyboard, and what was really wrong (2026-11-22, later)

The "Leaf Note" that would not answer was the room the MacBook had mis-made as "guy" on 19 Nov: Guy had renamed
it "Leaf Note by Anjou" from the phone, the Mac removed it the same evening, and the phone kept it, so the phone
held two rooms of that name, one dead. (Read off the phone itself: `xcrun devicectl device copy from --device
<udid> --domain-type appDataContainer --domain-identifier com.anjouinc.rkeychat --source Documents/boot.log`
gives the phone backend's whole log; `Documents/rkeychat/config.json` its room list.) The Mac re-joined the dead
room from the invite still in the Lab's log so it can close it for everyone once the phone brings the chain.

The keyboard: PearKit's `MessageList` now keeps its bottom edge anchored when its box changes height
(`anchoredScrollY`): the chat slides up as one piece, the message above the field stays there, whether at the
newest message or reading older ones. The shell drops the home-bar inset under the composer while the keyboard
is up (`useKeyboardOpen`), and the status line above the field exists only when there is something to say.

GUI tests: `app/scripts/gui.test.mjs` drives the mock in a real browser (phone and desktop): send, the keyboard
coming up and going away at the end and while reading, a reply landing while reading, Back from a project,
Enter / Shift+Enter. `npm --prefix app run test:gui`; the Mac Mini's quick run has it as "shell: gui".
