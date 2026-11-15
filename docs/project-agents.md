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
anything else asks, and headless "asks" means no; never bypass), `--tools Read,Edit,Bash` to narrow the
tool set, `--model M`.

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

## What it does not do yet

- Interrupt a turn in flight when a person posts something new (Buzz's "steer"). The new message is
  simply the next turn.
- Run on the phone. A project agent lives where its folder is.
- Ask a person for a permission. Headless, anything outside the permission mode is refused; widen the
  mode or the tool list per agent if a project needs more.
