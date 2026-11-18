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
  app: { app: 'rkeychat', role: 'project' | 'chat', name: string, icon?: string } | null  // the signed app record
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
| `POST /api/projects` | `{ folder, name?, agent?, via? }` | `{ room: RoomSummary, seat }` | creates the room, binds the folder, writes the `app` record, adds the project agent (`via` default `acp`), names it after the folder |
| `POST /api/rooms/folder` | `{ room, folder }` | RoomSummary | bind or rebind a folder to an existing room |
| `GET /api/pick-folder` | | `{ folder }` or `{ folder: null }` | Electron only: native folder dialog (via preload IPC); 404 in a browser |
| `GET /app/*` | | static | the Vite build of `app/dist`; SPA fallback to `app/dist/index.html` |

Control actions added to the server whitelist: `conv`, `app`.

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
