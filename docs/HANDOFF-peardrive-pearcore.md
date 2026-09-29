# Handoff: PearDrive / pearcore work from the rKey + rKeyChat session

*Written 2026-09-29 for the agent that owns the PearDrive overhaul (pearsync repo, pearcore drives integration). The source session built `~/Anjou/rKey` (the key-hierarchy protocol) and `~/Anjou/rKeyChat` (an agent/human chat app on pearcore). This document is everything that session learned that touches PearDrive and pearcore. Decide the implementation yourself; the requirements, constraints and evidence are all below.*

---

## 0. What Guy is building, and why it matters to you

- **pearcore is the foundation, not PearDrive.** Guy wants to build many small single-purpose apps on pearcore: chat, calendar, a video/"channels" app. They must not depend on PearDrive internals. Anything generic (transfers, streaming, access control, identity) belongs in pearcore. PearDrive should become one client of it: a very good file app.
- **PearDrive hosts apps' data ("App spaces").** Guy's own plan (`docs/apps-platform-plan.md`, Aug 27) stands and is now in progress. rKeyChat is its Step B/C: AgentOps extracted into its own tool.
- **rKey is the identity layer.** Keys sign for keys, revocably, with signatures in both directions. It's already used by rKeyChat. Device keys (pearcore account keys) are enrolled under a user's root; space whitelists get derived from the chain. See `~/Anjou/rKey/SPEC.md`.
- **Guy's quality bar for transfers:** "as responsive as a website delivering video." Switching videos, seeking and autoplay must be instant. Old requests must stop immediately. Content must be hash-addressed, fetchable from any seeder, and scale to 1000 seeders per popular item.

---

## 1. App spaces (PearDrive feature)

This is already specified in `docs/apps-platform-plan.md`. The additions below are what rKeyChat needs:

1. **Recognition.** `.pearmeta/app.json` = `{ app, name, icon, iconFile?, version, ui: { kind: 'external', hint } }`. rKeyChat will write `{ "app": "rkeychat", "name": "rKeyChat", ... }`. Only the space owner's manifest is trusted, the same rule as `spaceInfo`.
2. **Sidebar.** Add a fourth, lowest rail group, **Apps**, icon-first. Rail groups are rendered at `src/ui/index.html:2153-2160`, `:2230-2231` and `:2599-2601`.
3. **Isolation.** App data gets no feed cards, no thumbnails, and doesn't count in drive stats. Keep a "raw files" view. A read-only renderer for known app formats is welcome, e.g. show a rKeyChat log as a conversation, but PearDrive must **not** become a chat app.
4. **Seeding/backup is the main job.** A PearDrive device in an App space should hold and serve all of that app's files, so apps get durable history from any PearDrive device.

### rKeyChat's on-disk format in the space (so you know what you'll be seeding)

These are sealed, immutable files, so there's never a growing file to re-hash (see §4.3 for why that matters):

```
.pearmeta/app.json
archive/day/2026/09/2026-09-29.jsonl      one per UTC day, sealed after the day ends (+1h grace)
archive/month/2026-09.json                rollup: [{ day, hash, count, first, last }] + prev-month hash
archive/year/2026.json                    rollup of months
```

- Each day segment starts with a header `{ v, room, day, prev: <hash of previous day segment>, count, root }`. Every record in it is individually signed by its author's rKey key.
- The chain of hashes makes the archive a tamper-evident log. Readers hold only the rollups plus recent days; older days are fetched on demand.
- Late arrivals for a sealed day go into the next day's segment. Readers order by record `ts`.
- **The archivist is the room-owner device**, which has everything after sync. Other devices only verify. Live traffic and short-term backfill use pearcore messages, not files.

---

## 2. Transfers: move PearDrive's lane INTO pearcore

### The question Guy asked

> "Does it not make sense to use pearcore's [download system], and what all do we lose?"

**Today, switching PearDrive to pearcore's native engine would lose nearly everything that makes streaming work.** pearcore currently has:

| | pearcore native (HEAD `c8633de`) | PearDrive lane (`src/engine/swarm.manager.js`) |
|---|---|---|
| Request unit | 64 leaves = **16 MB** per provider (`files/components/scheduler.js:122-140`, `session.manager.js:58-64`) | 8 leaves (2 MiB), `PEER_WINDOW=2`, `MAX_PEER_INFLIGHT=4` (`:90-109`) |
| Stall handling | 5 s heartbeat; `reclaimStalled` acts only after **64 s**, and only if another idle provider covers the whole range, so **a stall with one seeder is permanent** (`scheduler.js:266-295`) | 30 s timeout, benching with decay, rate windows (`:110-116, 465-536, 1880`) |
| Cancel / seek | Cancel frame exists (provider aborts per leaf, `delivery.manager.js:320-375`) but is only invoked from `reclaimStalled`. No public cancel, no priority, no playhead | Per-reqId cancel, CancelRegistry, `setCursor` → `pump`, viewer epochs (`:553-601, 1207-1275, 2267-2312`) |
| Consumer API | **Download to disk only** (`writer.js:41-80`, `download.js:338-348`) | `task.read(start,end)` + HTTP 206 range serving |
| First byte | Mandatory full tree round trip before any leaf (`download.js:283-332`) | Leaf hashes shipped up front in `chunkHead` (`:1142`) |
| Resume | Contiguous prefix only (`writer.js:49`) | Sparse `.swarm.part` + bitfield (`partial.store.js`) |
| Accounting | Leaf counts per source (`progress.js:41-69`) | Per-peer inflight, rates, session totals |
| Mux | One FIFO write queue per socket: control frames sit behind 16 MB of data; `_waitForDrain` has no timeout (`multiplexer.manager.js:250-298`) | Own control frame `0x03`; `DRAIN_TIMEOUT_MS=45_000` |

### Recommendation

Guy wants pearcore itself to own this. **Port PearDrive's lane into pearcore as *the* engine, then have PearDrive consume it.** Don't keep two engines. In order of impact:

1. **Byte-range read API / readable stream** on a download task: `read(start, end)` with per-leaf waiters. Port from `swarm.manager.js:2274-2312`.
2. **Small requests plus per-peer windows**: about 8 leaves per request, not 16 MB assignments. Port from `:1844-1976`.
3. **Immediate, request-scoped cancel**, exposed on the task and invoked on seek or supersede. The cancel frame already exists; make it per-reqId. Port the CancelRegistry (`:1207-1275`).
4. **Playhead cursor with a cursor-forward want-set** (`:1927-1976`).
5. **Sparse partial store plus bitfield**, replacing SequentialWriter. Port `partial.store.js` wholesale.
6. **Priority tiers**: playback > prefetch > background. `src/engine/priority.js` is transport-free and drops in.
7. **Supersede semantics** (viewer epochs): opening a new stream displaces the old one. This is the "click another video and the old chunks stop" behavior (`:553-601`).
8. **Leaf hashes up front**, so the first leaf can be verified without waiting for the whole tree (`:1142`).
9. **Control-plane priority in the mux**: two write queues, or a control frame type, so cancel and control never wait behind data.
10. **Rate- and timeout-based reassignment with benching and decay**, replacing the "64 s and only if a substitute covers everything" rule.
11. **Per-seeder accounting**: bytes/sec, RTT, failures, on top of `ProgressTracker`.
12. **A drain timeout** in `_waitForDrain`.

**Interim, if the port isn't first:** PearDrive can't download from plain pearcore apps today. It only speaks `0x03` and replaces pearcore's STREAM handler (`swarm.manager.js:202-207`), so a plain pearcore peer's files, rKeyChat's archive for instance, can't be seeded by PearDrive. Pulling *from* PearDrive does work, via pearcore's native tree/content handlers. Either do the port first, or add a fallback to pearcore's native protocol for peers that don't answer `0x03`.

**The trap to avoid:** PearDrive suppresses native file events from any peer that has spoken a `cat*` op (`engine.js:2416`, `gossip.js:99-105`). Plain pearcore apps never do, so they're fine, but keep it that way when you redesign.

---

## 3. pearcore bugs found (with evidence)

1. **SocketManager drops live peers after connection dedupe (CONFIRMED).** This silently kills sends.
   - `addSocket` calls `resetSocket(old)`, which unindexes without destroying (`sockets.manager.js:46-48, 70-99`).
   - If Hyperswarm then closes the *newer* socket, `removeSocket(new)` deletes the whole peer record and topic index (`:86-98`), while the older socket stays open and connected.
   - Result: `getConnectedSockets` returns nothing for that peer, so sends are silently skipped. `getPeerInfoBySocket(old)` also throws, so inbound frames on the surviving socket fail.
   - **Observed live in rKeyChat on 2026-09-29.** Controls and rKey chain updates from device A never reached device B, while B→A kept working, until restart. PearDrive only silences the warning (`scripts/patch-pearcore.mjs:341-366`), and this matches the symptom in `docs/assessment-2026-09-02-stream-failure.md`.
   - **Fix:** in `resetSocket`, bail unless `this.peers.get(peerKey)?.socket === socket`. Better: track every live socket per peer and pick one that isn't destroyed.
   - rKeyChat currently works around it (`src/room.js` `#healSockets`) by re-registering orphaned live connections every 20 s.
2. **`canonicalStringify` emits invalid JSON for `undefined`, and encrypted messages are then dropped silently (CONFIRMED 2026-09-29).**
   - `canonicalStringify({a: 1, b: undefined})` returns `{"a":1,"b":undefined}`.
   - `encryptJSON` encrypts that text happily. On the receiver, `decryptJSON`'s `JSON.parse` throws, and `decryptPayload` catches it and returns `null` (`protocol.utils.js:111-132`). `SpaceMessageHandler` then emits a `SpaceMessage` with `content: null`.
   - Net effect: any payload with an undefined field vanishes on every receiver, with no log line and no reject.
   - It cost rKeyChat hours: messages worked after restarts, since records reloaded from disk had no undefined keys, and failed for freshly created ones.
   - **Fixes:**
     - Make `canonicalStringify` skip `undefined` object values, as `JSON.stringify` does (arrays use `null`).
     - Have `decryptPayload` / `encryptPayload` log their failures instead of swallowing them.
   - rKeyChat works around it by JSON-round-tripping every payload before `messages.send` (`src/proto.js` `clean`, `envelope`).
3. **Mux head-of-line blocking** of control frames behind bulk data (see §2, item 9).
3. **`_waitForDrain` has no timeout**, so a stalled socket blocks its write queue forever.
4. **`b4a` is imported** (`crypto.utils.js:7`) but missing from `package.json`. It works by accident as a transitive dependency.
5. **Environment note:** `hyperdht/testnet.js` with two in-process swarms on this Mac only half-connects: one side gets a connection after about 8 s and the other never does. The public DHT works (about 6 s to connect). This is worth knowing for tests. Separate processes may behave differently, so test that before relying on it.

---

## 4. Constraints from rKeyChat, and what the next apps will need

1. **Access is per space today; Guy needs per-file and per-folder grants** (see §5) without creating thousands of spaces. Each space is a DHT topic plus announces, and thousands of them would be astronomical overhead.
2. **Identity.** pearcore's account key is both the swarm key and the only identity, with no separate device keys. rKey wraps this: each pearcore account key is enrolled as a `host` device under the user's root. A whitelist can then be derived from the chain (`rKeyChat src/room.js #syncWhitelist`). Consider making "whitelist = active host keys of these rKey roots" a first-class pearcore policy, so revocation propagates without the owner rewriting the space.
3. **Growing files are pathological for PearDrive.** Each change re-hashes the whole file and mints a new variant, stranding in-flight tasks (`catalog.js:676-699`, and the comment at `:692-695`). So apps must write sealed segments, as rKeyChat does (§1). If you want to support append-only logs natively, that's a pearcore feature: an append-only, Merkle-extendable file type where new leaves extend the tree without re-hashing earlier ones.
4. **Retire `src/engine/agent.js`** (Agent Mesh) once rKeyChat is running on Guy's machines. It's superseded. Guy's verdict: nobody used it, he couldn't see inside it, and he still had to copy-paste between agents.

---

## 5. Per-file / per-folder access: a proposal to evaluate

Guy's goal: grant access to one file, one folder, or one "channel", e.g. selling a file or subscribing to a channel, while everyone shares one space for transport.

**Core idea: separate transport from access.**
- A space, or even public seeding, moves **ciphertext**. **Keys** grant access.
- Any of the 1000 seeders can serve encrypted chunks without being able to read them. That's exactly what makes wide seeding safe.

1. **Per-file content key.** Each file gets a random content key (CK). What's addressed and seeded is the ciphertext, and the Merkle tree is over the ciphertext, so seeders verify leaves without keys.
2. **Folder keys, Cryptree-style.** Each folder has a folder key (FK). A child's CK/FK is stored in the folder manifest, wrapped (encrypted) under the parent FK. Handing someone an FK grants that subtree; a CK grants one file. (Prior art: Cryptree/Wuala, Tahoe-LAFS read-caps, Peergos, which is Cryptree on IPFS.)
3. **Grants are capability records.** The CK/FK is wrapped to the recipient's encryption key. rKey can bind an encryption key (X25519) per member, as another key type in the chain. Revoking the rKey binding stops *future* grants.
4. **Channels and subscriptions.**
   - Each channel has an epoch key, e.g. rotated monthly, and each new item's CK is wrapped under the current epoch key.
   - Subscribers receive each epoch key wrapped to them. Unsubscribing = not receiving the next epoch key.
   - What they paid for stays readable, which is the correct semantics.
5. **Selling a single file.** Payment releases the wrapped CK. It could even be atomic over Lightning: make the invoice's payment hash commit to the key-release secret, so paying reveals it.
6. **Honest limits.**
   - You can't un-share bytes someone already decrypted.
   - Access patterns and sizes stay visible to seeders.
   - MLS/Marmot suits small groups; large subscriber sets want epoch keys, not MLS trees.

**Where it lives:** pearcore, as an optional encryption layer under the file registry. Apps and PearDrive share it.

---

## 6. Loose ends and open questions for you

- Should App-space recognition trust only the owner's manifest, or anyone with broadcast permission? rKeyChat assumes owner-only.
- Is a "pin/back up this app space on these devices" policy per device, or per space?
- Should PearDrive's apps panel launch the app's own GUI? rKeyChat serves its GUI at `http://127.0.0.1:<port>` (default 4455).

Contact: the rKey/rKeyChat session. Code lives in `~/Anjou/rKey` and `~/Anjou/rKeyChat`, with plans in their `SPEC.md` and `PLAN.md`.

---

## 7. Comments & reactions on files: reuse rKeyChat's thread system

Guy's direction (2026-09-29): the signed-message, reaction and history system built for rKeyChat should become PearDrive's comments and reactions on files and folders. It should not be a separate design. See `~/Anjou/rKeyChat/docs/pear-threads.md`. In short:
- A thread is signed records attached to a *subject*: a room, a file hash, a path, or a post.
- Record shapes map 1:1 onto Nostr: NIP-22 comments, NIP-25 reactions, NIP-73 external ids.
- The UI elements (reaction row, picker, verified lock, detail overlay, voice composer) go into the Pear UI library.

Coordinate with the rKeyChat session before building PearDrive's comment UI, so both use one extracted module.

## 8. Share by hash across spaces, with no copies (Guy, 2026-09-29)

Idea: posting a file from space A into space B (e.g. a rKeyChat room) shouldn't copy it or open up A. It should just make that one piece of content available in B too.
- **One content store per device.** `hash → where the bytes already live on disk` (the original path in A's folder, a cache file, etc.). Spaces hold *references* to hashes, not copies.
- **Per-space exposure list.** A device serves a hash inside space B only if that hash was explicitly shared into B, never just because the device happens to hold it. Otherwise anyone could probe "do you have file X?".
- **Dedupe for free.** If the bytes are already on disk from any space (a recently used emoji, a file from your drive), the reference points at them and nothing downloads. If not, it downloads once into the store and every space that references it can use it.
- **Access stays scoped.** Sharing one file into B grants B that file, not A's folder. With per-file keys (§5), sharing = re-wrapping that file's key for B.
- **Use one hash everywhere.** rKeyChat attachments are currently flat sha256; PearDrive and pearcore use Merkle root hashes (verifiable per leaf, streamable). When integrating, content ids should be the pearcore Merkle root, so the same file has the same id in every app and can stream from any seeder.
- **Moderation is a signed record in the thread, not a side channel** (built in rKeyChat 2026-09-29, suggested independently by Kimi).
  - An admin posts `{ kind: 'redact', target, hashes, reason }`. The target message is blanked in every view, and its hashes join the room's block list.
  - Blocked hashes are never served in that space (HTTP 410, blob requests ignored), and new messages carrying them are rejected.
  - Local copies are untouched. Repeat offenders get their key revoked in the rKey chain.
  - Because redactions are ordinary signed records, the moderation history is auditable and replicates like everything else.
