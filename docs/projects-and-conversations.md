# Projects and conversations: what rKeyChat is for

*2026-11-18, from Guy and Jeffrey's brainstorm (working title that came out of it: "telagent"). The ask:
"my Obsidian, my LM Studio and my Telegram as one thing", "project first, agent is there", "replace my
terminal windows".*

## What the brainstorm says, in six sentences

1. **Context poisons as often as it helps.** The main way Guy uses an agent is a fresh conversation for one
   thing, then throw it away. A long-lived room per topic is the wrong unit; it is why the pearcore bot is
   not the place to argue about pearcast.
2. **The project is the unit that persists; the conversation is disposable.** A project is a folder (a
   pearcore space) with its prompt, its files, its members, its tasks. Under it, as many conversations as
   you like, each with its own clean context, each recoverable later by any agent.
3. **The agent is a plug, not the owner.** Because the project prompt, the files and the conversation live
   in the space and not inside one agent's memory, you swap the runtime mid-conversation (Claude Code,
   Kimi, DeepSeek, a PPQ model, an image or video model, GenBuddy) and it re-reads the same context.
4. **Creating a project is one gesture.** Drop a folder, it becomes a project; "which agent?"; go. Removing
   one leaves nothing dragging behind.
5. **The screen is plain.** Obsidian's shape: a left list grouped by project, the conversation or note in
   the middle, the project prompt and members on the right, two columns on a desktop so two conversations
   under one project can run side by side. Markdown everywhere, so a task list is a file the agent edits
   and the task view reads. Nothing added for its own sake.
6. **It has to scale to the terminal.** Twenty-two Claude Code sessions on this Mac, four on the Linux box,
   three on the Mini: the app must make creating, finding and dropping sessions faster than tabs do, and
   stay readable on a phone. Overnight runs ("you have two hours, go") must not die because a listener
   fell out.

pearcast's project folders are already spaces, so this is the same module that pearcast needs for an
agent on a project's files. PearDrive comments on files are the same records (Pear Threads).

## What already exists, mapped onto it

| Brainstorm | Today in rKeyChat | Gap |
|---|---|---|
| Project = folder + space + prompt + members | A room: pearcore space, rKey chain, "room purpose", members | A room is not tied to a folder; a project agent (`rkeychat agent init`) is tied to a folder but not to a room |
| Conversations under a project, disposable, each with clean context | One log per room; one agent session per room | Threads inside a space (`pear-threads.md`: subject `conv:<id>`); one ACP session per conversation (`session/new` in the project folder gives exactly a fresh context) |
| Swap the agent mid-conversation | Bridge kinds claude (cli/acp), hermes, stream; fixed per seat | A conversation names its runtime; ACP makes Claude, Codex, Goose and a Hermes/PPQ adapter the same call; the turn is rendered from the thread, so any runtime gets the same context |
| Drop a folder, it is a project | `rkeychat create` (room) and `rkeychat agent init` (seat) are two commands | One flow: folder → space + chain + seat, in the app |
| Left list grouped by project, prompt on the right, two columns | One flat room list, purpose hidden in settings, one pane | The whole shell, phone first (Silver Surfer's panel work is the base) |
| Tasks per project, agent-maintained | nothing | `TASKS.md` in the project folder, rendered as a list; agents edit it with their normal tools |
| Reliable overnight runs | Daemon-owned seats, now over ACP | Finish ACP for every seat; retire the terminal listener for `@claude` |
| Files and their comments travel together | Files on the pearcore drive, hashed, with threads designed | Done in design, not in the UI |

## The shape, concretely

- **Project** = one pearcore space + rKey chain (today's room), plus `folder`, `prompt` (today's purpose,
  editable in the right pane), `TASKS.md`, and seats. One project per folder; the project agent is its
  default seat.
- **Conversation** = a thread in that space (`subject: conv:<id>`, title, created, runtime). All signed
  records as now. A conversation can be archived (hidden, kept) or deleted (redacted). Members of the
  project see every conversation; per-conversation keys come later, as Guy said.
- **Session** = one ACP session per (conversation, seat), `cwd` = the project folder, system prompt = the
  project prompt + the room rules. New conversation = `session/new`, so context starts clean every time.
  Resumed by id while the conversation lives. Switching the runtime closes one session and opens another;
  the turn is re-rendered from the thread, so the new agent reads the same history.
- **Runtimes** = ACP adapters: Claude Code (done), Codex and Goose (adapters exist), Hermes/PPQ/Ollama
  behind a thin OpenAI-compatible ACP agent (one file). Image and video models and GenBuddy arrive as MCP
  servers handed to the session, not as seats.
- **Shell** = left: projects, each with its conversations and a "+"; middle: the conversation; right:
  prompt, members, seats, tasks; desktop can open a second column. Phone: the same three as pages.

## Order of work

1. **Conversations inside a room** (3–4 days). Thread subject on records, `hist-req` per thread, one ACP
   session per conversation in `agents.js`, "+ New conversation" and archive in the UI. This alone gives
   Guy the fresh-context button inside the rooms he has.
2. **Project = room + folder** (1–2 days). `rkeychat project init DIR` creates space, chain and seat; the
   room settings gain `folder` and the prompt becomes the project prompt; drag a folder onto the app to run
   it. Existing rooms keep working as projects without a folder.
3. **The shell** (3–4 days, with Silver Surfer). Grouped left list, right pane, two columns, phone pages.
4. **Runtime per conversation** (2–3 days). Pick the agent when creating a conversation or switch it in the
   right pane; the OpenAI-compatible ACP agent for Hermes and PPQ.
5. **Tasks** (1 day). `TASKS.md` rendered and editable; agents already have the tools to change it.
6. **MCP into the session** (2 days). The rKeyChat server (read the thread, fetch a file, post) handed to
   every ACP session, so no seat shells out to the CLI.

What this leaves alone: rKey, the chain, the budget and turn rules, the file sync. The security work from
the 2026-11-15 audit (H1–H3) still comes first, since projects invite more people and more agents into
folders.
