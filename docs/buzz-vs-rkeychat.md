# Buzz and rKeyChat: an audit, a comparison, and how to marry them

*Preliminary, 2026-10-14. Buzz read at block/buzz commit 67c4fe5 (same day). rKeyChat at 39d6b16.*

## 0. The short version

- **Buzz** is a Nostr relay with a team workspace on top. One server (Postgres + Redis + S3) is the single source of truth; every message, reaction, channel change and workflow step is a signed NIP-01 event dispatched by `kind`. Agents are ordinary keypairs. A separate binary, **buzz-acp**, watches the relay for @mentions and drives a coding agent (Goose, Codex, Claude Code, its own `buzz-agent`) over the **Agent Client Protocol** (JSON-RPC over the child's stdio).
- **rKeyChat** is the same idea with no server: a room is a pearcore space plus an rKey chain, records are signed JSON lines gossiped between devices and replayed from an append-only log. Agents are woken by the daemon from the shared log, with a deterministic round budget.
- **Where each is strong.** Buzz's harness is strong at *owning the agent process*: spawn, prompt, batch, steer, respawn, time out, dead-letter. rKeyChat is strong at *the record*: signed, verifiable, replicated, no authority, with turn-taking and budgets that every device computes identically from the log. Buzz has no loop breaker and no budget at all; rKeyChat's wake path is a listener someone else has to keep alive.
- **Recommendation.** Do not port Buzz onto pearcore. Take two things through their protocol boundaries: (1) an **ACP bridge** inside rKeyChat, replacing the Monitor-based "stream" bridge, which is the piece that keeps breaking; (2) later, a **NIP-01 face** on the rKeyChat daemon so `buzz-cli`, countdown-bot-style bots, and eventually buzz-acp itself can talk to a room as if it were a relay. Both are things we were going to want anyway (`docs/pear-threads.md` already maps our records onto Nostr kinds).

## 1. Size and shape

| | rKeyChat | Buzz |
|---|---|---|
| Language | Node, no build step | Rust workspace (34 crates) + Tauri/React desktop + Flutter mobile |
| Lines | ~3.6k `src/*.js`, 2.3k UI html, 0.7k CLI/hooks | ~1.18M total; desktop 346k TS + 194k Rust; mobile 103k Dart; `buzz-acp/lib.rs` alone 13.6k |
| Services to run | one daemon per device | relay + Postgres 17 + Redis 7 + S3 (Silo/MinIO); optional push gateway, Caddy, pairing sidecar |
| Age / velocity | 2 weeks, one author + agents | v0.3 → v0.5.28, PR numbers to #8319, commit today; preview-flagged: workflows, projects, forum, agent profiles |
| Protocol | own envelope inside pearcore `SpaceMessage`, rKey signatures | Nostr NIP-01/42/98/29/25/34/44/50 + ~20 custom NIP drafts, 127 kinds |
| Identity | rKey: bip340 root, ed25519 device/session keys, revocable chain | secp256k1 Schnorr keypair per human and agent; owner attests agent with a signed tag (NIP-OA) |

Buzz is a moving monorepo staffed by a team. Anything we take must come through a stable boundary (NIP-01 on the wire, ACP to the agent), never by forking crates.

## 2. Piece by piece

Verdict column: which side has the more elegant or reliable answer *for our setting* (a handful of people, many agents, no server).

| Piece | rKeyChat | Buzz | Verdict |
|---|---|---|---|
| **Identity** | rKey chain: root signs devices and session keys, consent in both directions, revoke/ban/readopt, keys roll (`src/config.js`, `src/room.js:415-536`) | Bare keypair. Agent ↔ owner link is one signed tag; relay membership inherited from owner, revoked with the owner (`nip_oa.rs`, NIP-AA). Keys made with one call. | **rKeyChat** for the model, **Buzz** for ergonomics. The rKey root is already bip340, i.e. a Nostr key; an agent minted with a bip340 suite *is* a Nostr identity. rKey `enroll … delegate` is NIP-OA with more structure. |
| **Membership / authority** | The owner device appends to the chain; others merge. pearcore read/broadcast whitelist derived from chain `host` keys (`room.js:397-412`) | Relay is the authority: Postgres rows, relay-signed state events (39000/44100), membership checked on every REQ before registration | **rKeyChat.** No relay key to trust; the same data model works offline. Cost: the owner device must be reachable to admit anyone. |
| **Transport** | pearcore spaces over Hyperswarm, encrypted with the space secret; a live lane plus 60 s anti-entropy (`hist-req` with a 48 h id set, `room.js:112-120`) | One WebSocket per client to one relay; Redis fan-out between relay pods. **Plaintext to the operator** for channels and DMs (only read-state, memory, metrics are NIP-44) | **rKeyChat** on privacy, **Buzz** on predictability. rKeyChat carries three known pearcore workarounds (`#healSockets`, `#deafCheck`, unbound watcher handlers) which are pearcore debts, not design. |
| **Record format** | `{kind, id, room, ts, author, sig, …}` domain-separated rKey signature, verifiable on replay (`src/proto.js`) | NIP-01 event: `id = sha256(canonical)`, Schnorr sig, `kind` + tags. Same shape, standard encoding, a whole ecosystem of clients | **Tie, leaning Buzz.** Our record is a Nostr event with different field names. The mapping in `docs/pear-threads.md` is mechanical. |
| **Storage / sync** | `log.jsonl` per room, all in memory; dedup by id; sealed daily archive planned (HANDOFF §1) | Postgres `events` partitioned monthly, `ON CONFLICT DO NOTHING`, soft delete, keyset cursors, 1000/page, FTS as a generated column | **rKeyChat** for simplicity and durability without a server; **Buzz** for query. "Text files being synced" is correct and robust; what we lack is an index (see §5). |
| **Agent wake** | Daemon computes `triggersFor(name)` from the log (mention, open floor, reply, turn order, backup rule) and either calls Hermes or **offers a turn to whoever is listening** on `/api/wait` (`src/agents.js`) | buzz-acp holds a REQ per channel with `#p=<agent>`; intake gate → scope → queue → 👀 reaction → dispatch. Agent process is a child of the harness. | **Buzz, clearly**, on the *delivery* half. **rKeyChat** on the *decision* half (turn order, backup, open floor, budget), which Buzz does not have at all. |
| **Turn / queue** | one turn per agent, `busy` flag, 10 min re-offer window, 15 min offer timeout, human preempts (`agents.js:127-178`) | one in-flight prompt per scope, batches up to 50 events, `steer` (cancel + re-prompt with merged framing), 500/channel backpressure, retry 5 s → 300 s, dead-letter at 10, idle 620 s, hard 7200 s, orphan backstop | **Buzz.** Everything in our 10/15-minute timers is a workaround for not owning the agent process. |
| **Loop / budget** | Deterministic from the log: depth per hop, reset by a human, extend/until/unlimited/pause, per-agent limit and tokens-per-day cap measured from reported usage (`src/turns.js`, `room.js:551-576`) | **None.** No hop count, no budget, no cap. Loops damped only by mention-only triggers, self-ignore and prompt rules. Usage is published (kind 44200) but nothing enforces it. | **rKeyChat, by a mile.** This is the thing to keep whatever else changes. |
| **Agent runtime bridge** | Hermes HTTP (works); Claude Code via `rkeychat wait --once` under Monitor + hooks that scrape the transcript (`bin/*.mjs`) | ACP over stdio: `initialize`, `session/new` (cwd, MCP servers), `session/prompt`, `session/cancel`; adapters for Goose, Codex, Claude Code, plus presets for Cursor, Pi, Kimi, Hermes… | **Buzz.** ACP is a public protocol with a TypeScript SDK (`@agentclientprotocol/sdk` 1.8.0) and a maintained Claude adapter (`@agentclientprotocol/claude-agent-acp` 0.90.0, published today). |
| **Permissions / isolation** | None (the agent is a terminal session you run) | `buzz-agent` has a fail-closed, proven permission broker, **but** buzz-acp auto-approves every request and defaults to `bypass-permissions`; no sandbox; the policy env var it documents does not exist | **Neither.** Buzz's broker is good code that is switched off. Worth copying the *shape* when we have an ACP bridge: permission requests arrive as JSON-RPC and we decide. |
| **Files / media** | Content-addressed on pearcore's drive, any size, fetched from whoever is online, fetchers become providers (`room.js:680-786`); 8 MB blobs inline | Blossom: sha256 upload to S3, 50 MB images, 500 MB video, `imeta` tags | **rKeyChat.** |
| **Voice** | Local Parakeet dictation and voice memos | Huddles: Opus over WebSocket through the relay, 25 peers; local TTS/STT crate | Different things. Buzz's is a feature we do not have; it needs the relay as mixer. |
| **UI** | One html file, phone via tailnet | 346k-line Tauri app, Flutter mobile, admin console | Buzz is a real product UI; ours is a lab UI. Running Buzz desktop against our daemon is a long tail (see §4.2). |
| **Audit** | Every record signed by its author and verifiable by anyone with the log and chain | Per-community SHA-256 chain **in the database**, not signed, verifier only called from tests; tamper-evident against non-operators only | **rKeyChat.** |
| **Scale** | Per room: one swarm topic, 20 s presence, 60 s anti-entropy with a 48 h id list, whole log in RAM, O(n) `log()`/`budget()`/`triggersFor()` per poke | 10k connections, 1024 subs/conn, DashMap `(channel, kind)` fan-out, Redis topic scoping (64× measured), partitions; "a modest VPS handles a small project" | **Buzz** today; rKeyChat has not been measured past 4 rooms. §5. |

## 3. What rKeyChat is struggling with, and why Buzz does not

The fragile piece is the **stream bridge**. Today the daemon decides a turn is due and then waits for an external listener (Claude Code running `rkeychat wait --once` under a Monitor) to show up and take it. Everything after that is an inference about a process we cannot see: `busy` until it answers, a 10-minute re-offer suppression, a 15-minute offer timeout, hooks that tail the Claude transcript to mirror what it said. The Oct 13 bug (listener died mid-turn, `busy` stayed set, the agent looked present and rude for 15 minutes) is the archetype.

buzz-acp never has that problem because **the harness is the parent of the agent process**. It sees stdout EOF the moment the agent dies, requeues the batch, respawns behind a circuit breaker (3 crashes in 60 s opens it for 5 min), and has a dedicated `recovery_wake` select arm so a quiet channel cannot strand requeued work. One prompt in flight per scope is a queue invariant, not a flag. A human's new message during a turn is `steer`: cancel, merge, re-prompt, which is the behaviour our "person preempts" code approximates by hand.

What buzz-acp lacks, and we have: the *decision* layer. It will happily let two agents mention each other forever; its only damping is prompt text. Our depth budget, turn order, backup rule, per-agent caps and tokens-per-day are the right controls and they are already computed deterministically from the log, so they survive any transport.

Other things in the harness worth copying regardless of transport:
- **Prompt framing escapes untrusted text** (`prompt_framing.rs`): our `renderTurn` interpolates raw room messages into the prompt, so a message containing something that looks like an instruction block is a prompt-injection path. Cheap fix.
- **"Error is not absence"** for memory fetches: a failed read must not read as "empty", or the agent overwrites real state.
- **Dead-letter with a ⚠️ in the room** for auth/model errors rather than silent retries; **👀 reaction** as the claim ack (we have `activity.claim`, which agents cannot see; a reaction is visible to everyone).
- **A heartbeat prompt** (lower priority than real events) for agents that should check on something periodically.
- **Edit routing**: an edit that adds a mention wakes the agent once, attached to the original.

Things in Buzz *not* to copy: permissions bypassed by default; no sandbox; delivery "not guaranteed" past a 15-minute replay floor; 13k-line files whose correctness rests on ordering comments.

## 4. Marrying them: three options

### 4.1 ACP bridge inside rKeyChat (recommended first; small)

Add a third bridge kind beside `hermes` and `stream`:

```
rkeychat add claude --acp "npx @agentclientprotocol/claude-agent-acp" --cwd ~/Anjou/rKeyChat
```

The daemon spawns the adapter, `initialize`, `session/new` per room (cwd = the project the room is about, MCP servers if any), and on a due turn sends `session/prompt` with exactly what `renderTurn` produces today. Replies come back as `session/update` text; the final text is posted with the existing `room.post`, or the agent keeps using `rkeychat send` from inside its tools (both work; the former removes the mirror hooks). Keep `turns.js` untouched.

Borrow from buzz-acp, in this order: one in-flight per room; human message during a turn = `session/cancel` + re-prompt with a "new request supersedes" frame; idle timeout on silence (not on wall clock); crash = requeue + respawn behind a breaker; permission requests answered by room policy (default deny for anything outside the room's cwd, with a control record to loosen). Roughly 300–500 lines on `@agentclientprotocol/sdk`; the Hermes bridge stays as is.

Open question to verify first: `claude-agent-acp` is built on the Claude Agent SDK. Confirm it runs under the Max login rather than requiring an API key (the SDK drives the `claude` CLI, so it should, but test it before building on it). There is a community `claude-code-acp` that wraps the CLI explicitly for subscription use if not. Codex (`codex-acp` 1.10.1) and Goose give us two more runtimes for free, which matters for Kimi on the Mini.

What this fixes: no Monitor, no `wait --once`, no transcript-scraping hooks, no 10/15-minute timers, agents visible as processes with real state, crashes handled. What it does not change: everything about rooms, keys, sync, UI.

### 4.2 A NIP-01 face on the daemon (second; medium)

The daemon already listens on 127.0.0.1:4455. Add `ws://127.0.0.1:4455/nostr` speaking NIP-01 + NIP-42, with the room as a NIP-29 group (`#h` = topic hash) and our records mapped per `docs/pear-threads.md`:

| rKeyChat | Nostr |
|---|---|
| `msg` | kind 9 with `#h`, `#p` for mentions, `e` for `re` (or 40002 for Buzz's rich form) |
| `react` | kind 7 |
| `redact` | kind 5 (own) / 9005 (admin) |
| `control` | a custom kind in the 40000s; Buzz has nothing equivalent |
| `activity` | 24200 observer frame (ephemeral) or omit |
| chain / membership | 13534 roster (NIP-43) signed by the owner root; 44100/44101 notices |
| join request / approve | 9021 / 9000 |
| files | Blossom `/upload` and `/media/<sha256>` mapped onto the pearcore drive |

The "relay key" that Buzz expects for derived events becomes the room owner's root, which is what signs our chain already. Author keys must be bip340 for Buzz clients to verify them; an ed25519 session key would need a bip340 sibling or a re-sign by the account root. The protocol audit's minimal surface for `buzz-cli` and `buzz-acp` is: NIP-01 filters (`kinds`, `authors`, `#h`, `#p`, `#e`, `since`, `until`, `limit`), NIP-42 with the NIP-OA tag, NIP-98 on `/query` `/events` `/count` `/info`, the channel command kinds, 39000/44100 derived events, and kinds 9/40002/40003/7/5 with NIP-10 thread resolution. That is a few thousand lines and gets us: `buzz-cli` as a second agent CLI, any Nostr bot as a participant, and the Nostr mirror we have wanted for the social layer.

Running **Buzz desktop** unchanged against it is a different claim: it also depends on relay-computed thread metadata, NIP-CW windows, invite REST, DM channels, presence snapshots and ~20 custom NIPs. Possible, but a long tail; treat it as "read-only view first", not a goal.

### 4.3 Buzz-relay on pearcore (not recommended)

Replacing Postgres/Redis/S3 under `buzz-relay` with pearcore keeps the relay as an authority (membership rows, relay-signed state, deletion fences, audit chain, "supported writer contract") and inherits a 1.2M-line monorepo moving at thousands of PRs a quarter. The relay-as-truth assumption is in the data model, not just the storage layer. Everything we would gain is reachable through 4.1 and 4.2 at a fraction of the cost.

## 5. Scaling: hundreds of rooms, friends and agents

Honest state: rKeyChat has four rooms and has not been measured. The costs that grow are:

1. **One swarm topic per room.** Each room is a pearcore space with its own DHT announce, discovery and sockets. Hundreds of rooms means hundreds of announcements and, per peer, a socket per shared room. This is a pearcore question (multiplex rooms over one connection per peer; the `#healSockets` workaround shows the per-peer socket table is already the fragile spot).
2. **Anti-entropy chatter.** Every 60 s every room sends `hist-req` carrying all record ids from the last 48 h, and presence every 20 s. At 300 rooms × a few peers that is constant background traffic. Fix: send a hash of the id set first and the ids only on mismatch; presence once per peer, not per room.
3. **Everything in RAM, recomputed per poke.** `log()` rebuilds the blocked set and views every record; `budget()` walks the log; `triggersFor()` walks it per agent, on every record and `changed` event. With long rooms and many agents this becomes O(rooms × agents × records) per message. Fix: incremental indexes (blocked, per-agent last-own, answered set) and the sealed daily archive so a room loads only recent days. This is the same work the sealing plan already describes.
4. **Chains per room.** Each room has its own rKey chain under the same root; the same device consents into each room separately. Hundreds of rooms = hundreds of chains to merge and verify, all small. Fine, but an account-level chain with per-room grants would be cleaner (`docs/keys-links-and-the-later-root.md` is heading there).

Buzz scales the way a server does: a 10k-connection relay, partitioned tables, Redis fan-out scoped per community. That costs a server, an operator, and plaintext at the operator. For hundreds of rooms among friends the P2P costs above are all engineering, none of them architectural, and the ACP bridge (4.1) does not touch any of them.

## 6. Good, bad, and trade-offs of tying them together

**Good**
- The record formats are isomorphic; identity is already Schnorr at the root; the harness boundary is a public protocol with SDKs. Nothing here needs a fork.
- Three agent runtimes (Claude, Codex, Goose) and Buzz's whole CLI become available to rooms through two adapters we control.
- Buzz's harness patterns (queue invariants, steer, breaker, dead-letter, escaped framing) are small to port and fix the exact class of bug we keep hitting.

**Bad / costs**
- ACP adapters are third-party moving parts (claude-agent-acp is on its 831st commit; v2 mode is behind an env flag). Pin versions.
- A Nostr face means two signing suites per participant or a re-sign step, and a kind mapping to maintain as Buzz adds kinds.
- Buzz desktop against our daemon is not a short project; do not plan around it.
- Buzz's defaults are permissive (bypass permissions, no budget). Anything we take must sit under our budget and a permission policy we write.

**Trade-offs to decide**
- Agent-posts-via-CLI (today) vs harness-posts-final-text (Buzz): the first keeps the agent's words exactly as it chose to send them and lets it stay silent; the second is simpler and removes the hooks. Buzz does the first with a prompt rule ("never a bare acknowledgement"). Suggest: keep CLI posting, use the ACP final text only as a fallback when the agent said nothing.
- Session per room (Buzz default) vs session per thread: per room matches our turn model; per thread is what Buzz is rolling out dark. Start per room.

## 7. Suggested order

1. Verify `claude-agent-acp` under the Max login (one afternoon).
2. ACP bridge with queue, steer, breaker, idle timeout; retire `wait`/Monitor/mirror hooks for Claude (days).
3. Escape untrusted text in `renderTurn`; add the dead-letter ⚠️ and the 👀 claim.
4. Incremental indexes + anti-entropy hashing (the §5 items), measured with a synthetic 200-room config.
5. NIP-01 face, scoped to what `buzz-cli` and countdown-bot need; then try buzz-acp against it as a second harness and compare with step 2.

## Appendix: pointers

- Buzz harness: `crates/buzz-acp/src/{lib.rs,queue.rs,pool.rs,acp.rs,recovery_wake.rs,prompt_framing.rs,scope.rs}`, `crates/buzz-acp/README.md`, `TASKS.md`
- Buzz protocol: `crates/buzz-core/src/kind.rs`, `NOSTR.md`, `docs/nips/NIP-{AA,OA,CW,RS,AB}.md`, `crates/buzz-relay/src/handlers/{event,req,auth,channel_authz}.rs`
- Buzz identity: `crates/buzz-sdk/src/nip_oa.rs`, `desktop/src-tauri/src/commands/agents.rs`
- rKeyChat: `src/agents.js`, `src/turns.js`, `src/room.js`, `src/proto.js`, `docs/pear-threads.md`, `docs/HANDOFF-peardrive-pearcore.md` §1
- ACP: `@agentclientprotocol/sdk` (npm, 1.8.0), `@agentclientprotocol/claude-agent-acp` (0.90.0), `codex-acp` (1.10.1), https://agentclientprotocol.com
