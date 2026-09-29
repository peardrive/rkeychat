# rKeyChat v0 plan

A room where Guy, Claude Code (MacBook) and two Hermes+Kimi agents (Mac Mini, Zorin) talk directly, with no copy-paste. It's built on pearcore, membership is rKey, and PearDrive seeds the history as an App space (pearsync `docs/apps-platform-plan.md`, Steps B/C).

## Pieces

1. **Daemon**: `rkeychat` (Node), one per machine.
   - It joins the room's pearcore space.
   - It hosts one or more *participants*, each with its own key enrolled under Guy's rKey root with the `chat` scope. The machine's pearcore key only carries traffic.
   - Every message is signed by its author's key, and membership is checked against the rKey chain on every message.
2. **Live lane**: pearcore `MessageService`, which already signs, encrypts with the space secret, and relays. Envelope: `{app:'rkeychat', v:0, type, ...}`. PearDrive ignores it because the app tag doesn't match.
   - Message types: `msg`, `chain` (the rKey chain and pending ops), `hist-req`/`hist-res` (backfill since the last message seen), `presence`, `control` (pause/resume/budget).
3. **Durable lane**: a hash-chained archive written as space files. It's sealed and immutable, so PearDrive never churns re-hashing a growing file.
   - One file per UTC day: `archive/day/YYYY/MM/YYYY-MM-DD.jsonl`, sealed a day after it ends plus 1h grace. Its header is `{ v, room, day, prev, count, root }`, where `prev` is the previous day's hash.
   - Rollups: `archive/month/YYYY-MM.json` lists the day hashes, and `archive/year/YYYY.json` lists the month hashes.
   - The index a reader keeps stays small: rollups plus recent days. Older days load on demand.
   - Late records go into the next day's file. The room-owner device is the archivist.
   - The manifest lives at `.pearmeta/app.json`.
   - Short-term backfill uses `hist-req` with a 48h id-set diff.
   - Details are in `docs/HANDOFF-peardrive-pearcore.md` §1.
4. **GUI**: `localhost` page served by the daemon, with a live event stream.
   - Shows the timeline, a composer (Guy posts as himself), who's online, and each agent's state (idle / thinking / waiting on budget).
   - Budget controls: default 3 autonomous rounds, extendable to +N, until a given time, or unlimited. A Pause-all button.
   - A keys panel: the rKey tree, enroll, revoke.
5. **Agent bridges**, run by the daemon for the participants it hosts:
   - **Hermes**: the local API server (`API_SERVER_ENABLED=true`, 127.0.0.1:8642). One Hermes session per room. New messages are batched, then `POST /api/sessions/{id}/chat/stream`, the reply streams back, and gets posted.
   - **Claude Code**: `rkeychat tail --for claude` under the Monitor tool (each line wakes the session), and `rkeychat send` to reply.
     - Fallback: `claude -p --resume`.
6. **Turn-taking and budget**:
   - A message from Guy resets the budget.
   - Each agent-to-agent reply spends one round.
   - At 0, agents stop until Guy posts or extends the budget.
   - Agents reply when mentioned or, in "open floor" mode, to any message. One turn at a time per agent, with new messages batched while it's busy.

## PearDrive work needed (separate, in pearsync)

- An Apps rail group plus `.pearmeta/app.json` recognition (Step A of the plan).
- **Transfer fallback**: today PearDrive only downloads over its own 0x03 lane, so it can't pull files from a plain pearcore peer. It should fall back to pearcore's native tree/content protocol for peers that don't speak 0x03. Without that, PearDrive can serve history to rKeyChat but can't back rKeyChat's history up.
- Retire `src/engine/agent.js` once rKeyChat works.

## Order

1. Daemon, live lane, CLI, and rKey membership: two daemons on this Mac talking.
2. GUI.
3. Claude bridge (me, via Monitor), then the Hermes bridge (Mac Mini and Zorin).
4. Budget and turn-taking controls.
5. Durable segments and backfill. PearDrive App space support comes after that.
