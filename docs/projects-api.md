# Projects and conversations: the API contract (branch `projects`)

*2026-11-18. What the daemon offers the new shell (`app/`, served at `/app/`). Everything here is additive
to the existing routes (`server.js`); the old page at `/` keeps working unchanged. Shapes are JSON.*

## Words

- **Room** = a pearcore space + rKey chain, as today. A room with a `folder` is a **project**.
- **Conversation** (`conv`) = a thread inside a room. Records carry an optional `conv` id (8–32 hex chars);
  records without one belong to the default conversation `main`. Conversation metadata is a signed control
  record `{ action: 'conv', conv, title, archived?, runtime? }`; the last one per `conv` wins.
- **Seat** = an agent participant with a bridge (project agent: `claude` via `cli`/`acp`; `hermes`; `stream`).
- **Runtime** = how a conversation's seat is driven: `null` (the seat's default) or `'acp'`/`'cli'` for a
  claude seat. Later: an ACP command (Codex, Goose, a Hermes adapter).

## Shapes

```ts
type Conversation = {
  conv: string            // 'main' for the default
  title: string           // 'General' for main unless renamed
  created: number         // ms; first control or first message
  archived: boolean
  runtime: string | null
  last: { ts: number, name: string, text: string } | null   // last message, for the list
  count: number           // messages (not redacted)
  busy: string[]          // seat names with a turn in flight in this conversation
}

type ProjectInfo = {
  folder: string | null   // device-private path; only present on this device
  app: { app: 'rkeychat', role: 'project' | 'chat', name: string, icon?: string, home: { device: string, name: string } | null } | null  // the signed app record; home = the device the folder lives on
  seats: { name: string, bridge: 'claude' | 'hermes' | 'stream', via: 'acp' | 'cli' | null, dir: string | null }[]
}

type RoomSummary = {   // app.list() entry, extended
  name: string, topic: string, owner: boolean, admitted: boolean,
  folder: string | null, app: ProjectInfo['app'],
  convs: Pick<Conversation, 'conv' | 'title' | 'archived' | 'last' | 'count'>[],
  unread?: number
}
```

`roomSnapshot` (`GET /api/state`) gains `convs: Conversation[]`, `folder`, `app`, `seats`, and when `conv=`
is given, its `log` is that conversation's page. Every message record in `log` and in the `record` push
carries `conv` (filled in with `'main'` when absent).

## Routes

| Route | Body / query | Returns | Notes |
|---|---|---|---|
| `GET /api/state?room=&conv=` | | snapshot | `conv` scopes `log`; default `main` |
| `GET /api/log?room=&conv=&limit=&before\|after\|around=` | | `{ log, hasOlder, hasNewer }` | as today, per conversation |
| `GET /api/convs?room=` | | `Conversation[]` | archived included, flagged |
| `POST /api/convs` | `{ room, title, runtime? , text? }` | `Conversation` | creates the control; if `text`, posts it as the first message as the device's human |
| `POST /api/convs/rename` | `{ room, conv, title }` | `Conversation` | |
| `POST /api/convs/archive` | `{ room, conv, archived }` | `Conversation` | archive hides, never deletes |
| `POST /api/convs/runtime` | `{ room, conv, runtime }` | `Conversation` | retires that conversation's seat process; next turn uses the new runtime, same session id is NOT reused when the runtime changes |
| `POST /api/send` | `{ room, as, text, re, conv, … }` | record | `conv` defaults to the conversation of `re[0]`, else `main` |
| `GET /api/search?q=&room=&conv=&limit=` | | hits | `conv` optional |
| `GET /api/activity?room=&conv=&…` | | activity | `conv` optional |
| `POST /api/projects` | `{ folder?, name?, agent?, via?, home?, prompt? }` | `{ room: RoomSummary, seat }` or `{ pending: true, asked, via, id, online }` | here: creates the room, binds the folder (made under the workspace root from `name` when no `folder`), writes the `app` record with `home`, seats the project agent (`via` default `acp`). `home` naming another of the owner's devices: a signed, account-gated `project` control goes to it through a shared room and it does the same there; the room appears later |
| `GET /api/devices` | | `[{ ref, name, online, here }]` | the owner's own devices, this one first |
| `GET /api/projects/pending` | | `[{ id, name, asked, home, via, ts, online }]` | projects this device asked other devices for (`POST /api/projects` with `home`) that no room has answered yet: a request is answered when a room's `app` note carries `request: id`; the home device answers a name already in use with that room; unanswered requests expire after 30 days. The shell shows these as "waiting on …" rows |
| `POST /api/rooms/remove` | `{ room }` | `{ removed, topic, seats, folder }` | takes the room off this device. The owner first writes a signed `close` control (owner's keys only): every device that holds the room, the owner's other devices included, removes it when it sees the record (at once when online, at its next start otherwise). A member's device leaves instead (its keys self-revoke). The folder on disk stays |
| `GET /api/workspace` / `POST /api/workspace` | `{ workspace }` | `{ workspace }` | where projects made by name go on this device (default `~/Projects`) |
| `POST /api/rooms/folder` | `{ room, folder }` | RoomSummary | bind or rebind a folder to an existing room |
| `GET /app/*` | | static | the Vite build of `app/dist`; SPA fallback to `app/dist/index.html`; a short "not built yet" page otherwise |

The native folder picker is not a route: in Electron the page calls `window.rkc.pickFolder()` (preload IPC) and then
`POST /api/projects`; a plain browser shows a dialog with a path field. `GET /api/state` reports `device.desktop`.
CLI: `rkeychat project init [DIR] [--name N] [--agent SEAT]`, `rkeychat convs [new|rename|archive|unarchive]`,
`rkeychat send --conv ID`.

Control actions added to the server whitelist: `conv`, `app`.

## Permissions asked of a person (2026-11-22)

| Route | Body / query | Returns | Notes |
|---|---|---|---|
| `GET /api/asks` | `?room=&conv=` optional | `{ asks: [ask + { topic, room }] }` | agents' open asks (unanswered, not lapsed), oldest first; every room without `room` |
| `POST /api/asks/answer` | `{ room, ask, choice }` | the viewed `answer` control | `choice`: `allow_once \| allow_always \| reject_once \| reject_always`. Writes an account-gated control: refused unless this device's human key is the owner's |

| `POST /api/agents/ask-minutes` | `{ name?, minutes }` | `{ name, minutes, default }` | how long an ask waits (1–120 min); without `name`, this device's default |

## The bot's settings (2026-11-22)

| Route | Body / query | Returns | Notes |
|---|---|---|---|
| `POST /api/control` | `{ room, action: 'seat', agent, seat: { permissionMode?, auto?: { minutes, turns }, model?, provider?, askMinutes?, via? } }` | the signed `seat` control | the one path for the shell on every device: account-gated; the seat's host applies it and writes back `seat.applied: true` with how it runs, its `providers: [{ name, hasToken }]` and, in Auto, `auto: { since, minutes, turns, used, back }` |
| `POST /api/control` | `{ room, action: 'auto', auto: { minutes, turns } }` | the signed `auto` control | the room's cap on Auto grants (account-gated); both empty lifts it; `RoomSnapshot.autoCap` follows |
| `POST /api/control` | `{ room, action: 'rounds', n }` | the signed `rounds` control | (2026-11-23) the standing rounds per human message, 1–1000; `0` puts the default 3 back; it ends an `unlimited`/`until` grant. `RoomSnapshot.budget.rounds` and every `record` push's `budget` follow. The shell's project pane shows "Rounds: 5 rounds per message" with Set, "Open 8 h" (`until`) and "No limit" (`unlimited`); the bot's profile has "Posts per message" (`limit`) |
| `POST /api/agents/mode` | `{ name, mode, auto? }` | `{ name, permissionMode, auto, run }` | on the host: `default \| acceptEdits \| plan \| auto`; `bypassPermissions` is refused; `auto` is the grant `{ minutes, turns }` (1 up, or empty for no limit) |
| `POST /api/agents/model` | `{ name, model?, provider? }` | `{ name, model, provider, run }` | `model` null/`default` is the login's own; `provider` null/`claude` is the login; a provider must exist on this device |
| `GET /api/providers` | — | `{ providers: [{ name, baseUrl, hasToken }] }` | never the token |
| `POST /api/providers` | `{ name, baseUrl?, token? }` | `{ name, baseUrl, hasToken }` | add or change; without `token` the held one is kept |
| `POST /api/providers/remove` | `{ name }` | `{ removed }` | refused while a seat runs on it |

`RoomSnapshot.seats[]` rows carry `permissionMode`, `model`, `provider`, `askMinutes`, `providers`; a row for a seat
another device hosts also has `remote: true` and comes from that host's newest applied `seat` control.
`GET /api/agents` rows carry the same plus `run` (one line). A `seat` control arriving pushes a fresh `room` snapshot.
The shell keeps `seat` and `answer` controls out of the conversation (the profile and the ask's card carry them) and
folds a stretch of steps and settled asks between two messages into one line (`collapseActivity` in
`app/src/store/mapping.ts`); "All steps" shows everything.

A seat row needs the daemon that made the snapshot to know `seat` controls: the phone runs a copy of `src/`
(`rkeychat--mobile/src`) that must be the desktop's byte for byte (lessons check `phone-daemon-copy-matches-the-desktop`).

`RoomSnapshot.ownerDevice`: this device's human key is one of the owner's own (it may answer); `owner` still
means "holds the root key".

Records: `ask { kind: 'ask', tool, what, input, options: [{ id, kind, name? }], expires, conv }` signed by the
agent; `control { action: 'answer', ask, choice }` signed by an owner key. Both are in the page log and arrive as
`record` pushes; agents never read them. See project-agents.md "Asking a person".

## Push events (SSE `GET /api/events`)

- `record { topic, rec, budget }` — `rec.conv` present.
- `convs { topic, convs: Conversation[] }` — coalesced, after any `conv` control or a message in a
  conversation whose `last`/`count` changed.
- `room`, `rooms`, `participants`, `activity { topic, rec }` (activity records carry `conv`),
  `agent-error`, `agent-state { topic, name, conv, state }` — state is `idle | thinking | waiting | error | offline`.

## Agent turns

- A turn is scoped to one conversation: `triggersFor(name, conv)`, `renderTurn(room, name, { conv })`, and
  `budget(conv)` (room-wide controls apply; the human-reset counts per conversation).
- One process/session per `(seat, conversation)`. Session ids are stored under `sessions[`${topic}/${conv}`]`
  in the seat's `agent.json`; the legacy `sessions[topic]` is the `main` conversation.
- The ACP session's `cwd` is `room.cfg.folder ?? bridge.dir`.
- The system prompt gains one line: `Conversation: <title>` and, for a project, `Project folder: <folder>`.

## The app record (for PearDrive's "My Apps")

A signed control `{ action: 'app', app: 'rkeychat', role: 'project' | 'chat', name, icon? }` written by the
owner when a room is created (`chat`) or bound to a folder (`project`). It is the "small signed record in
the Space saying which app and what the Space is for" that `peardrive/docs/spaces-organization.md` asks
for. PearDrive can read it from the room's log through the same records sync, or from a future
`.pearmeta/app.json`; until then the `rkeychat-invite:` link scheme names the app, as pearcast's does.

## Electron additions (`electron/preload.cjs`, `electron/main.js`)

- `window.rkc.pathForFile(file)` → absolute path (webUtils).
- `window.rkc.pickFolder()` → path or null (dialog.showOpenDialog).
- `RKEYCHAT_SHELL=app` (or `--app`) loads `/app/` instead of `/`.
