# Graph Report - rKeyChat  (2026-10-20)

## Corpus Check
- 53 files · ~118,352 words
- Verdict: corpus is large enough that graph structure adds value.
- Unclassified: 2 file(s) not represented in the graph (top: (none) 1, .tgz 1)

## Summary
- 724 nodes · 1444 edges · 40 communities (31 shown, 9 thin omitted)
- Extraction: 96% EXTRACTED · 4% INFERRED · 0% AMBIGUOUS · INFERRED: 56 edges (avg confidence: 0.89)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `39d6b16a`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- Room
- jsQR.js
- daemon.js
- renderFeed (timeline bubbles, day lines, control lines, redactions)
- server.js
- room.js
- Space directories decoupled from disk
- login.js
- RoomStore
- package.json
- AgentRunner
- claude-mirror-hook.mjs
- build
- Port PearDrive's transfer lane into pearcore as the engine
- Live dictation pipe (/api/live WebSocket → Parakeet on the Mac)
- build-kit.sh
- pearcore bug: SocketManager drops live peers after dedupe
- Expiry, the lapsed key, and what a later signature can and cannot bless
- DebugNotes
- shot.mjs
- stt-bench.cjs
- Backing up an iPhone photo library over pearcore — a plan
- Identity model: one account root per person, device keys under it, agent roots per agent
- renderPanel / PAGES table / openPage
- Delegation, revocation, and the FROST argument
- Carrying key state on Nostr, and what it costs relays
- Pear Thread (signed records hanging off a subject)
- pearcore branch peardrive-phase1 (16 commits)
- dependencies
- Review: the Merkle-checkpoint proposal
- How an invitation works, step by step — and why you're right about the link
- scripts
- rkeychat Daemon
- Record kinds (msg, react, redact, activity)
- devDependencies
- electron
- build-app.sh
- wait-once.sh
- CLAUDE.md
- engines

## God Nodes (most connected - your core abstractions)
1. `Room` - 72 edges
2. `serve()` - 45 edges
3. `dataDir()` - 26 edges
4. `RoomStore` - 23 edges
5. `Login` - 21 edges
6. `decode()` - 17 edges
7. `App` - 15 edges
8. `build` - 14 edges
9. `AgentRunner` - 13 edges
10. `saveConfig()` - 13 edges

## Surprising Connections (you probably didn't know these)
- `Where the daemon comes from` --references--> `ensureDaemon()`  [INFERRED]
  rKeyChat/docs/DESKTOP.md → rKeyChat/electron/main.js
- `3. What rKeyChat is struggling with, and why Buzz does not` --references--> `renderTurn()`  [INFERRED]
  rKeyChat/docs/buzz-vs-rkeychat.md → rKeyChat/src/agents.js
- `7. Suggested order` --references--> `renderTurn()`  [INFERRED]
  rKeyChat/docs/buzz-vs-rkeychat.md → rKeyChat/src/agents.js
- `Where the daemon comes from` --references--> `bootDaemon()`  [INFERRED]
  rKeyChat/docs/DESKTOP.md → rKeyChat/src/daemon.js
- `Share by hash across spaces, one content store per device` --semantically_similar_to--> `Dedupe by hash (content-identity view, reclaim, cross-space reconnect)`  [INFERRED] [semantically similar]
  rKeyChat/docs/HANDOFF-peardrive-pearcore.md → rKeyChat/docs/peardrive-coupling-map.md

## Import Cycles
- None detected.

## Hyperedges (group relationships)
- **rKeyChat two-lane architecture: live messages, sealed archive, rKey membership** — rkeychat_plan_live_lane, rkeychat_plan_durable_lane, rkeychat_plan_participant, rkeychat_plan_archivist, rkeychat_plan_hist_req_backfill [EXTRACTED 1.00]
- **Pear Threads: rKeyChat records and UI extracted for PearDrive file comments** — rkeychat_docs_pear_threads_thread, rkeychat_docs_pear_threads_threads_js, rkeychat_docs_pear_threads_pear_ui_elements, src_ui_index_reactions_ui, rkeychat_docs_peardrive_space_directories_space_directory_model [EXTRACTED 1.00]
- **PearDrive onto new pearcore: coupling map → patch set upstreamed → adapter → lab run** — rkeychat_docs_peardrive_coupling_map_patch_pearcore_script, rkeychat_docs_peardrive_coupling_map_storage_manager_removed, rkeychat_docs_peardrive_coupling_map_phase1_plan, rkeychat_docs_peardrive_migration_report_peardrive_phase1_branch, rkeychat_docs_peardrive_migration_report_storage_adapter, rkeychat_docs_peardrive_migration_report_lab_run [EXTRACTED 1.00]

## Communities (40 total, 9 thin omitted)

### Community 0 - "Room"
Cohesion: 0.07
Nodes (7): 4.2 A NIP-01 face on the daemon (second; medium), makeRedaction(), verifyRecord(), deviceOf(), edRef(), nameOf(), Room

### Community 1 - "jsQR.js"
Cohesion: 0.07
Nodes (40): What a note is, The fix is expiry, not smarter revocation, binarize(), BitMatrix(), BitStream(), buildFunctionPatternMask(), computeDimension(), countBlackWhiteRun() (+32 more)

### Community 2 - "daemon.js"
Cohesion: 0.08
Nodes (37): api(), base(), cfgOrDie(), cmd, die(), fmt(), hhmm(), nextStep() (+29 more)

### Community 3 - "renderFeed (timeline bubbles, day lines, control lines, redactions)"
Cohesion: 0.20
Nodes (12): Moderation as a signed redact record, Pear UI elements (pear-ui.css / pear-ui.js), Thumbnails for shared media as room blobs, api() fetch helper and REST surface, EventSource /api/events push stream, Files by hash (attachFile, getFile, openFile viewer, paintRing progress), load(topic): fetch /api/state and renderAll, openThinking / activity overlay (+4 more)

### Community 4 - "server.js"
Cohesion: 0.07
Nodes (69): dataDir(), applyGlossary(), COMMON, escape(), learn(), loadGlossary(), loadSettings(), path() (+61 more)

### Community 5 - "room.js"
Cohesion: 0.09
Nodes (27): APP, clean(), cleanAgentRules(), cleanUsage(), isOurs(), makeActivity(), makeControl(), makeInvite() (+19 more)

### Community 6 - "Space directories decoupled from disk"
Cohesion: 0.17
Nodes (8): PearDrive Catalog (persistent twin of spaceFileList), Dedupe by hash (content-identity view, reclaim, cross-space reconnect), src/lib/pearcore.js single import surface, StorageManager deleted upstream (29 call sites), attachStorage / attachThrowingAdd adapter, Connection (watch folder → space directory; collect/mirror, flatten/subtree), dir-entry record, Local index (hash → disk location, per device)

### Community 7 - "login.js"
Cohesion: 0.10
Nodes (16): pearcore, rkey, b64(), decodeInvite(), encodeInvite(), unb64(), checkProof(), INVITE (+8 more)

### Community 9 - "package.json"
Cohesion: 0.12
Nodes (16): allowScripts, better-sqlite3@12.11.1, bin, rkeychat, description, license, main, name (+8 more)

### Community 10 - "AgentRunner"
Cohesion: 0.11
Nodes (18): 0. The short version, 1. Size and shape, 2. Piece by piece, 3. What rKeyChat is struggling with, and why Buzz does not, 4.1 ACP bridge inside rKeyChat (recommended first; small), 4.3 Buzz-relay on pearcore (not recommended), 4. Marrying them: three options, 5. Scaling: hundreds of rooms, friends and agents (+10 more)

### Community 11 - "claude-mirror-hook.mjs"
Cohesion: 0.13
Nodes (13): describe(), file(), newNarration(), short(), answeredInRoomNow(), cfg, finalReply(), tail() (+5 more)

### Community 12 - "build"
Cohesion: 0.06
Nodes (31): build, appId, artifactName, asar, deb, directories, dmg, extraMetadata (+23 more)

### Community 13 - "Port PearDrive's transfer lane into pearcore as the engine"
Cohesion: 0.53
Nodes (4): PearDrive 0x03 control lane + STREAM data plane, PartialFileStore (sparse .swarm.part + bitfield), Priority tiers (INTERACTIVE / SELECTED / BACKGROUND) and viewer epochs, PearDrive transfer fallback to pearcore native protocol

### Community 17 - "Expiry, the lapsed key, and what a later signature can and cannot bless"
Cohesion: 0.07
Nodes (24): 1. The layering you described is the right one, 2. "Does the October 7th signature validate the 3rd through the 6th?", 3. Quarantine: expired is a third state, not a flavour of revoked, 4. Doing it on purpose, 5. "After 90 days can we ignore the history and start fresh?", 6. So, in order, 7. What this costs at 100s of devices over 10 years, 8. Could a Fedimint-style federation give us the clock? (+16 more)

### Community 18 - "DebugNotes"
Cohesion: 0.12
Nodes (13): Adding it to the next app (about an hour), Debug notes: the one module every app gets, Reading a note, The two halves, and where they live today, Where it goes, Debugging it while you use it, Not yet, rKeyChat as its own app (+5 more)

### Community 19 - "shot.mjs"
Cohesion: 0.11
Nodes (16): args, chrome, clip, errors, height, page(), params, pending (+8 more)

### Community 20 - "stt-bench.cjs"
Cohesion: 0.16
Nodes (10): files(), fs, MODELS, offline(), online(), os, path, sherpa (+2 more)

### Community 21 - "Backing up an iPhone photo library over pearcore — a plan"
Cohesion: 0.18
Nodes (10): 1. What already exists, 2. Staying awake, 3. Getting the originals out of iCloud, 4. The batch controller, which is the whole app, 5. The arithmetic, which reframes everything, 6. The viewer, 7. Spike order — what to prove before committing, 8. Security constraints — settled (+2 more)

### Community 22 - "Identity model: one account root per person, device keys under it, agent roots per agent"
Cohesion: 0.25
Nodes (9): rKey identity layer, Phone as a paired browser on the tailnet, Posting-device badge (iPhone, desktop, PearDrive), Roll keys in place as a live kick/invite test, Participant (rKey chat-scope key), Invite / request / approve enrollment flow, openScanner (camera QR scan for login/pairing), renderKeysPage (Verified: signature details, voice memo transcripts) (+1 more)

### Community 23 - "renderPanel / PAGES table / openPage"
Cohesion: 0.22
Nodes (10): Phone layout (chat owns the screen, sheets for panels), Claim-based soft turn order for agents, Dock: Rooms · Contacts · Agents · Profile, Room details panel (right side, resizable; sheet on phone), rKeyChat GUI (localhost page + event stream), renderAgentsPage (budget, pause, limits), renderPanel / PAGES table / openPage, renderRoomPage (room details: people/agents, key rows, remove/ban/unban, charter order) (+2 more)

### Community 24 - "Delegation, revocation, and the FROST argument"
Cohesion: 0.20
Nodes (9): 1. What the post gets right, 2. The conflation: hierarchy is not rotation when the verifier holds state, 3. Where the ordering burden is real — and how big it actually is, 4. What FROST costs, which the post undersells, 5. Nostr: concede, and route around it, 6. They compose — and that's the design, 7. What I'd actually change because of this post, 8. The one-paragraph reply, if you want one (+1 more)

### Community 25 - "Carrying key state on Nostr, and what it costs relays"
Cohesion: 0.22
Nodes (8): 1. The shape, 2. Not in the profile, 3. What it costs a relay, 4. What this does not fix, 5. The honest weakness: freshness gets worse, not better, 6. Adoption, stated plainly, 7. What I'd build, Carrying key state on Nostr, and what it costs relays

### Community 26 - "Pear Thread (signed records hanging off a subject)"
Cohesion: 0.28
Nodes (8): App spaces (.pearmeta/app.json), Subject (room:, blob:, path:, rec: ids), Pear Thread (signed records hanging off a subject), Archivist (room-owner device), Durable lane (hash-chained archive), hist-req 48h id-set backfill, Live lane (pearcore MessageService), Live message types (msg, chain, hist-req/res, presence, control)

### Community 27 - "pearcore branch peardrive-phase1 (16 commits)"
Cohesion: 0.25
Nodes (8): Bare port of pearcore (rKeyChat-mobile/bare), pearcore gap: file lists don't reach late peers, New-pearcore bugs at 35dfca1 (15 items), scripts/patch-pearcore.mjs (install-time patch set), Phase 1 lab run (three nodes, public DHT), Non-blocking join (2fc0e8f), Once-per-socket file list push (c60b6bb), pearcore branch peardrive-phase1 (16 commits)

### Community 28 - "dependencies"
Cohesion: 0.25
Nodes (8): dependencies, hyperdht, @noble/hashes, pearcore, qrcode, rkey, sherpa-onnx-node, ws

### Community 29 - "Review: the Merkle-checkpoint proposal"
Cohesion: 0.29
Nodes (6): Review: the Merkle-checkpoint proposal, Take these, The Merkle tree is premature at our size, The "only signatures" alternative is what we already chose, The structural mismatch: it's an auth system, not a log, What I'd actually do with this

### Community 30 - "How an invitation works, step by step — and why you're right about the link"
Cohesion: 0.29
Nodes (6): 1. What happens today, step by step, 2. Is the nonce the one-time token? Essentially yes, 3. So why anything more than a pearcore link?, 4. What the change looks like, 5. The gap: "the user we're expecting", How an invitation works, step by step — and why you're right about the link

### Community 31 - "scripts"
Cohesion: 0.33
Nodes (6): scripts, app, dist, dist:linux, dist:mac, test

### Community 32 - "rkeychat Daemon"
Cohesion: 0.47
Nodes (6): Agent Mesh (src/engine/agent.js, AgentOps space), Claude Code bridge (tail/wait under Monitor, send), Hermes bridge, Retire src/engine/agent.js (Agent Mesh), rkeychat Daemon, rkeychat CLI (init, add, start, join, request, invite, status, wait, send)

### Community 33 - "Record kinds (msg, react, redact, activity)"
Cohesion: 0.40
Nodes (5): pearcore bug: canonicalStringify emits invalid JSON for undefined, Nostr mapping (NIP-22, NIP-25, NIP-73, NIP-94), Record kinds (msg, react, redact, activity), threads.js (transport-agnostic record library), Mac Mini update procedure (rkeychat-kit)

### Community 34 - "devDependencies"
Cohesion: 0.50
Nodes (4): devDependencies, electron, electron-builder, @electron/rebuild

## Knowledge Gaps
- **21 isolated node(s):** `hyperdht`, `@electron/rebuild`, `electron-builder`, `Archivist (room-owner device)`, `Retire src/engine/agent.js (Agent Mesh)` (+16 more)
  These have ≤1 connection - possible missing edges or undocumented components. (Counts symbols only; 238 node(s) total have ≤1 connection when file, concept and rationale nodes are included.)
- **9 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `Room` connect `Room` to `daemon.js`, `server.js`, `room.js`?**
  _High betweenness centrality (0.127) - this node is a cross-community bridge._
- **Are the 3 inferred relationships involving `serve()` (e.g. with `.info()` and `.list()`) actually correct?**
  _`serve()` has 3 INFERRED edges - model-reasoned connections that need verification._
- **What connects `hyperdht`, `@electron/rebuild`, `electron-builder` to the rest of the system?**
  _21 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Room` be split into smaller, more focused modules?**
  _Cohesion score 0.06702702702702702 - nodes in this community are weakly interconnected._
- **Why does `RoomStore` connect `RoomStore` to `Expiry, the lapsed key, and what a later signature can and cannot bless`, `daemon.js`, `server.js`?**
  _High betweenness centrality (0.112) - this node is a cross-community bridge._
- **Are the 3 inferred relationships involving `dataDir()` (e.g. with `trace()` and `trace()`) actually correct?**
  _`dataDir()` has 3 INFERRED edges - model-reasoned connections that need verification._
- **Should `jsQR.js` be split into smaller, more focused modules?**
  _Cohesion score 0.07093253968253968 - nodes in this community are weakly interconnected._