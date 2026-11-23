# Project agents: a folder with a seat in the room

*2026-10-28. Guy: "I want the app itself to own the process so that the session and the work is specific to
the thing we are working on … almost like we have a key right there inside the project folder."*

A **project agent** is a Claude Code conversation that belongs to one project folder and has its own
seat in rKeyChat rooms. Mention `@peardrive` and the PearDrive folder answers, with that folder's
CLAUDE.md, memory and graph, from whichever device hosts it. Nothing is carried between sessions by a
person any more.

## Set one up

```sh
cd ~/Anjou/peardrive
rkeychat agent init peardrive            # or: rkeychat agent init peardrive --dir ~/Anjou/peardrive
rkeychat agent list                      # rooms it is in, state, and the session id per room
```

That writes `~/Anjou/peardrive/.rkeychat/agent.json` (added to `.gitignore` when the folder is a git repo),
registers `@peardrive` on this device, and signs it into every room this device owns, immediately — no
daemon restart. For rooms owned by another device: `rkeychat request --room ROOM` here, and the owner
approves, like any new key.

Options: `--permission acceptEdits|plan|default` (default `acceptEdits`: it may edit inside its folder,
anything else asks, and headless "asks" means no; never bypass), `--tools lab|none|RULE,RULE…` (below),
`--model M`.

### What it may do without asking

Headless, a permission prompt has nobody to answer it, so every tool outside the permission mode is
refused. A seat left at the bare default stalls on its first `npm test` or `git log` and the room sees
"thinking" until the turn times out; that is how every seat started on the night of the 2026-11-08 audit,
and Guy unblocked each one by hand with a `.claude/settings.local.json` allowlist in the repo.

So the daemon passes an allowlist (`--allowedTools`) itself. `src/tools.js` holds it; the agent's
`tools` setting picks it:

| `tools` | the seat may, without asking |
| --- | --- |
| `lab` (default) | read, grep and glob; run `git`, `npm`, `npx`, `node`, `rkeychat`; the read-only shell (`ls cat head tail wc grep find diff du which`), `ps pgrep lsof`, `curl`, `mkdir`; **read the folders beside its own** (the other repos it works with), except the `_` business folders (`_keys`, `_deliveries`, …), which are denied outright |
| `none` | nothing beyond the permission mode: the old behaviour, every other tool asks and is refused |
| `Bash(git:*),Read,…` | exactly those Claude Code permission rules |

```sh
rkeychat agent init peardrive                      # lab preset
rkeychat agent init scratch --tools none           # a seat that may only edit its folder
rkeychat agent tools peardrive "Bash(git:*),Bash(npm test),Read"   # change it later; takes effect on the next turn
rkeychat agent list                                # shows each project agent's setting
```

The repo's own `.claude/settings.json` still applies on top (Claude Code merges allow rules), so a
project can widen or narrow its seat without touching rKeyChat. `bypassPermissions` is never used.

## What is in the folder

`<dir>/.rkeychat/agent.json` holds the agent's **session key** (what signs its posts), its **account
root** (so it can be enrolled on any device with its own consent and revoked on its own), and
**`sessions`: one Claude Code session id per room topic**. The folder is the identity: move it to another
machine and the agent moves with it, conversations included (the session transcripts live under
`~/.claude/projects/` for that folder, so copy those too for a full move).

Open a room's conversation by hand, exactly as the daemon sees it:

```sh
cd ~/Anjou/peardrive && claude --resume <session id from rkeychat agent list>
```

Don't type into it while the daemon is using it: two writers on one transcript is how a session gets
corrupted. Read it, or `--fork-session` to branch.

## How the daemon runs it

`src/agents.js`, bridge kind `claude`. On the first turn the daemon spawns
`claude -p --input-format stream-json --output-format stream-json` in the project folder, with the room's
standing rules as an appended system prompt and `--session-id` (new) or `--resume` (known). Each turn is
one JSON line on stdin; the daemon reads `assistant` events (tool use shows up in the agent's activity
log: "Bash: npm test") and one `result` per turn, posts the result under the agent's key, and records
usage. The process stays warm between turns and is stopped after 30 minutes idle; the next turn resumes
the same session. A turn is capped at 20 minutes. A session that cannot be resumed starts over once; three
failures in a row back off for five minutes. Quitting the daemon stops its agents.

Because the daemon owns the process it knows the difference between *working*, *dead* and *never
started*, which the old stream bridge (`rkeychat wait` from a terminal) never could: that is where "busy
for 15 minutes with nobody home" came from. The stream bridge stays for now; `@claude` still answers from
whichever terminal is listening until the project agents have earned their keep.

### Over ACP (`rkeychat agent via NAME acp`, or `agent init --acp`), since 2026-11-18

`src/acp.js`. The same seat, driven through the [Agent Client Protocol](https://agentclientprotocol.com)
instead of `claude -p`: the daemon spawns `claude-agent-acp` (the official adapter over the Claude Agent SDK,
which runs Claude Code under this Mac's own Claude login, no API key) in the project folder, opens one ACP
session per room (`session/new`, or `session/load` by the saved id, which replays the conversation), sets
the mode to the seat's permission mode (`bypassPermissions` is turned into `acceptEdits`), and sends each
turn as `session/prompt`. The reply streams back as `session/update` chunks; tool calls show in the activity
log as before.

What is different, and why it exists:

- **Permissions are answered, not refused blind.** Claude Code asks the daemon (`session/request_permission`)
  for anything its mode does not already allow; the daemon answers from the seat's tool list (`src/tools.js`,
  same rules as the `--allowedTools` the cli path passes) and logs `allowed Bash: npm test` or `refused Bash:
  rm -rf dist` in the activity feed. Deny rules win; a chained command needs every part allowed; a `Read`
  rule covers Grep/Glob/LS and an `Edit` rule covers Write, as in Claude Code.
- **A person interrupts a turn.** A human message during a turn sends `session/cancel`; the turn comes back
  `cancelled`, nothing is posted, and the next turn is rendered with both messages. Agents do not interrupt
  agents.
- **Same conversation either way.** `rkeychat agent via NAME cli` switches back; the session id is shared.
- **Other agents later.** The bridge takes a `command` (and `args`) in the bridge config, so an ACP adapter
  for Codex, Goose or a Hermes box can sit behind the same seat without a new bridge kind.

Costs seen on the first turns: the adapter starts in under a second, a resumed session replays its history
into the SDK (a cache write the size of the transcript, ~4 s), then a turn is a few seconds. The Kimi seats
still use the Hermes HTTP bridge.

### Asking a person (2026-11-22, from Guy's debug note)

"The bot said it could not get permission to search PearKit and PearDrive, and no way to approve ever showed up
in the chat. I need that gated by my key." Over ACP, what the seat's tool list does not settle is now asked:

1. `verdict()` (src/acp.js) says `allow` (an allow rule covers it), `deny` (a deny rule hits: final, nobody is
   asked) or `ask`. On `ask` the process hands the runner `{ tool, what, input, options }`.
2. The runner (src/agents.js `#ask`) writes a signed **`ask` record** into the conversation, by the agent's own
   key: tool, one line of what it would do, the whole input, the agent's four options, and when it lapses (ten
   minutes). The seat shows as *waiting*. Agents never read asks (renderTurn takes messages only).
3. One of the owner's own devices answers with an **`answer` control** `{ ask, choice }`, choice one of
   `allow_once | allow_always | reject_once | reject_always`. The control is **account-gated** (`ACCOUNT_GATED` in
   src/room.js): only the account root or a key enrolled directly under it (the owner's Mac, phone, Mini) is
   admitted. A team member who is admin in the room sees the question and the lock line, and an answer signed by
   their key is refused on every device, theirs included. The first admitted answer wins; later ones change
   nothing. An answer must name an ask the room holds.
4. The runner, waiting on `room.awaitAnswer(id)`, passes the choice back; the process picks the agent's matching
   option and logs `allowed by guy (iphone): Bash: brew install jq` in the activity feed. No answer in ten
   minutes: refused, and the activity line says so.

In the shell the ask is PearKit's `AskCard` where it happened in the conversation (Allow once · Always · Deny for
the owner's devices, a lock line for everyone else, then "allowed once by guy (macbook)" as the record), and a
Needs-you item on Home and Activity with the same three answers in a dialog. The CLI: `rkeychat asks` lists what
agents wait on; `rkeychat answer ASK allow|deny [--always]`. API: `GET /api/asks`, `POST /api/asks/answer`.

Tests: `test/asks.test.js` (the gate: jeff's forged answer is refused with `scope`; the first answer wins; a lapse
ends the wait with null; `verdict`), `app/src/store/asks.test.ts` (the card and Needs you follow the records),
PearKit `askLogic.test.ts`, and the GUI test "an agent asks for a permission" in a real browser.

**How long an ask waits.** Ten minutes by default. `rkeychat agent ask-minutes NAME 30` sets one seat's wait
(its `bridge.askMinutes`); `rkeychat agent ask-minutes all 30` sets this device's default (`askMinutes` in
config.json); 1 to 120 minutes, live for the next ask. The turn's own 20-minute clock stops while a person is
asked, so a long wait does not time the turn out. API: `POST /api/agents/ask-minutes { name?, minutes }`.

**Who may answer, as the shell sees it.** The room snapshot's `ownerDevice` is the daemon's own test
(`isOwnerKey` on this device's human key), true on the owner's phone as well as the Mac; the older `owner` flag
means "this device holds the root key" and is false on a phone, which is why the first phone build showed the
lock line to Guy himself (2026-11-22).

Not yet: `allow_always` is the agent's own memory (Claude Code stops asking for that rule within the session);
the seat's tool list on disk is not widened.

### The bot's settings: mode, model, provider (2026-11-22, the rest of the same memo)

"Auto mode, or approval mode, whatever the three modes are … the ability to change the model and provider, so that
if I have a PPQ API I can switch straight to that … change the model from Fable to Opus 5.5 … right there in the
settings for the bot when I click on it … click on the bot's little profile icon and get straight to those details."

`src/seat-settings.js` holds the lists; the daemon writes them into the seat's bridge in config.json; the shell shows
them on the bot's profile, which opens from the bot's picture or name in any message (PearKit `onAuthorPress`), from
the project's seat list, and from the "is thinking" line.

| Setting | Values | Where it bites |
| --- | --- | --- |
| permission mode | `default` (Ask), `acceptEdits` (Edits, the default), `plan`, `auto` — never `bypassPermissions`, refused by name and alias | ACP: `session/set_mode` on the open session, at once; cli: the process is retired and the next turn starts with `--permission-mode` |
| model | `null` (the login's own) or an id; the profile offers Fable 5.1, Opus 5.5, Sonnet 5.5, Haiku 5.5 and takes any id | ACP: `session/set_config_option` "model" at once, and `ANTHROPIC_MODEL` for the next process; cli: `--model` |
| provider | `null` (this computer's Claude login) or a provider on the host | the process environment: `ANTHROPIC_BASE_URL` and `ANTHROPIC_AUTH_TOKEN`; a change retires the process |
| ask minutes | 1–120, or the device default | the next ask |

**Providers** are a device setting on the host (`providers` in config.json: `{ ppq: { baseUrl, token } }`), because the
token is a secret that stays where the seat runs. `rkeychat provider set ppq https://api.ppq.ai --token-stdin < key.txt`
(the key never sits in the shell history), `rkeychat provider` lists names and URLs and whether a key is held,
`GET /api/providers` says the same and never the token; Settings › Providers on the computer takes the key in a
password field. PPQ wants the root URL, not `/v1`; `checkBaseUrl` trims it. A seat on a provider the host no longer
has does not fall back to the login and its bill: the turn fails with the reason in the activity.

**From the phone, and the team.** Seats live on computers; the phone hosts none, so its snapshot used to show a bot
with no settings. Now the settings travel as a signed **`seat` control** (`{ action: 'seat', agent, seat: {…} }`),
account-gated like `answer`: any of the owner's own devices writes a request with only the fields that change; the
device hosting the seat applies it and writes back how the seat now runs (`seat.applied: true`, with the host's
provider names and whether each has a key). A request from a team member's key is refused on arrival everywhere. The
snapshot's `seats` rows are the host's own config on the host and the newest applied control elsewhere
(`room.seatsFromLog()`), so the phone's profile shows the truth and changes it; the shell's one path for a change
is `POST /api/control { action: 'seat', agent, seat }` on every device, the host included. At start a host writes a
fresh description into any room whose newest one is stale or missing. Both records read as lines in the
conversation: "guy changed @pear's settings", "@pear now runs: Ask · Opus 5.5 · via ppq".

CLI: `rkeychat agent mode NAME default|acceptEdits|plan|auto`, `rkeychat agent model NAME MODEL|default
[--provider P|claude]`, `rkeychat agent list` prints the run line. Tests: `test/seat-settings.test.js` (the lists,
bypass refused, the environment, the URL, nothing prints a token), `test/seat-control.test.js` (the phone's request
is heard and jeff's refused; the host's echo is what the room reads; a newer echo wins), the shell's
`seatSettings.test.ts` and the seat lines in `asks.test.ts`, and the GUI test "the bot's profile opens from its
picture in the chat".

## What it does not do yet

- Interrupt a turn in flight when a person posts something new (Buzz's "steer"). Done on the ACP path; the
  cli path still takes the new message as the next turn.
- Run on the phone. A project agent lives where its folder is.
- Ask a person for a permission on the cli path. Over ACP it does (below); the cli path still refuses what the
  mode does not cover.
- Give the seat an rKeyChat MCP server (read the room, fetch a file, post mid-turn). ACP's `session/new`
  takes a list of MCP servers, so this is the natural next step; today the seat uses the `rkeychat` CLI.
