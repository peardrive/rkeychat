# PearDrive → new pearcore: coupling map (phase 1)

**Repos used**

| Role | Path | Identity |
|---|---|---|
| PearDrive (canonical) | `/Users/guy/Claude/Projects/pearsync` | `package.json` name `peardrive`, version `0.6.101`, `src/build.js` BUILD `2026-09-10.127`, HEAD `7b9c718`. Pin: `"pearcore": "github:peardrive/Pearcore#d819780acdfed2f32bd07868107b3420a5f12eee"` |
| Old pearcore (reference copy, installed) | `/Users/guy/Anjou/peardrive/node_modules/pearcore` | same generation as the pin; `node_modules` is **not** installed under `pearsync`, so I read the old API from this copy |
| New pearcore (target) | `/Users/guy/Anjou/pearcore-mobile` | git worktree at `35dfca1` ("fix(file-registry): bind watcher handlers"), i.e. **newer than** the commit `docs/drive-migration-map.md` was written against (`32d5869`) |

`/Users/guy/Anjou/peardrive` is an older delivery of the same tree (same mtime on `package.json`); I used `/Users/guy/Claude/Projects/pearsync` as the source of truth, as instructed.

**Ignore these when porting** — they are FUSE/NFS "deleted but open" remnants of old file versions, not live code, and they contain stale `core.*` call sites that will pollute greps:
`src/.fuse_hidden0000000f00000003`, `src/engine/.fuse_hidden0000000c00000001`, `src/engine/.fuse_hidden0000000c00000002`, `src/engine/.fuse_hidden0000000d00000002`, `src/ui/.fuse_hidden0000000c00000001`, plus the whole `_to_delete/` and `Claude outputs/` directories (archived copies of `engine.js`, `swarm.manager.js`, `catalog.js`, `patch-pearcore.mjs`, …).

**Pre-existing work:** `docs/drive-migration-map.md` (Sep 27, 16 KB) already maps this against `32d5869`, and `docs/drive-migration-prep.md` is its companion. My findings agree with it except where noted in §8 — notably **§D (file-list replay) is NOT upstreamed** at `35dfca1`, and the unbound-watcher bug it reports **is** now fixed.

---

## 1. Every import/require of pearcore, grouped by PearDrive module

### 1.1 The single import surface

**`src/lib/pearcore.js`** (61 lines) is the *only* file that names a `pearcore/…` path. Deep imports (the package `main` points at a non-existent file upstream):

| Line | Import | Symbols |
|---|---|---|
| 15 | `pearcore/src/core.js` | `createCore` |
| 16 | `pearcore/src/constants/events.constants.js` | `* as EVENTS` |
| 17 | `pearcore/src/constants/global.constants.js` | `DEFAULT_CHUNK_SIZE` |
| 18 | `pearcore/src/managers/multiplexer.manager.js` | `FrameTypes` |
| 23 | `pearcore/src/utils/crypto.utils.js` | `hash`, `hex`, `randomNonce`, `signJSON`, `verifySignedJSON` |
| 27–31 | `pearcore/src/utils/files.utils.js` | `createWatcher`, `WatchTypes`, `getFileMetaHashFromSource` |
| 34 | `pearcore/src/utils/system.utils.js` | `createFileStream`, `getFileSize` |
| 37 | `pearcore/src/utils/merkleTree.utils.js` | `generateMerkleTree` |
| 40–43 | `pearcore/src/utils/space.utils.js` | `getSpaceToTopicMap`, `getTopicToSpaceMap` |
| 46 | `pearcore/src/utils/protocol.utils.js` | `verifySpaceFileRecordSignature`, `createSpaceSyncMessage` |
| 49 | `pearcore/src/utils/policy.utils.js` | `publicKeyIsAllowedToRead` |
| 55 | `pearcore/src/database/schemas/file.schema.js` | `fileRegistry`, `fileIndex` (drizzle tables — used for **direct SQL writes**) |
| 61 | `pearcore/src/utils/files.utils.js` | `deleteFileRecord`, `getFileTreeLeafs` |

Note: `createWatcher` / `WatchTypes` are **re-exported but never imported by any PearDrive module** (dead re-exports since the §W patch made PearCore's watcher inert).

Also a hard dependency on **drizzle-orm** (`src/engine/engine.js:63 import { eq } from 'drizzle-orm'`) — PearDrive writes pearcore's SQLite with pearcore's own ORM objects.

### 1.2 Consumers of the shim (static imports)

| File | Line | Symbols imported from `../lib/pearcore.js` |
|---|---|---|
| `src/engine/engine.js` | 43–62, 78 | `createCore`, `EVENTS`, `getSpaceToTopicMap`, `getTopicToSpaceMap`, `verifySpaceFileRecordSignature`, `createSpaceSyncMessage`, `fileRegistry`, `fileIndex`, `deleteFileRecord`, `getFileTreeLeafs`, `hash as pcHash`, `hex`, `randomNonce`, `generateMerkleTree`, `getFileMetaHashFromSource`, `createFileStream`, `getFileSize`, `DEFAULT_CHUNK_SIZE`, `signJSON`, `verifySignedJSON` |
| `src/engine/swarm.manager.js` | 40–48 | `hash`, `hex`, `randomNonce`, `DEFAULT_CHUNK_SIZE`, `FrameTypes`, `publicKeyIsAllowedToRead`, `getFileMetaHashFromSource` |
| `src/engine/verify.js` | 11 | `generateMerkleTree`, `DEFAULT_CHUNK_SIZE` |
| `src/engine/agent.js` | 35 | `signJSON`, `verifySignedJSON` |

Everything else receives the live `core` container by injection (`gossip.js`, `introduce.js`, `server.js` via `engine.core`). `catalog.js`, `spaceindex.js`, `config.js`, `ignore.js`, `policies.js`, `priority.js`, `wire.js`, `partial.store.js`, `thumbs.js`, `riders.js`, `lan.js`, `notify.js`, `filter.js`, `debuglog.js` have **zero** pearcore coupling by design (documented as "universal toolkit modules" — see `docs/pearcore-toolkit.md`).

Tests (not shipped): `test/route-race.test.mjs:13`, `test/route-race2.test.mjs:16`, `test/two-node-wire.test.mjs:16` import `pearcore/src/managers/multiplexer.manager.js` directly (`MuxManager`, `FrameTypes`).

### 1.3 Runtime surface: `core.*` call sites (147 total)

Tally of distinct accessors (live `src/` + `electron/` only):

```
40  core.emitter.on                          12  core.managers.storage.listFileRecords
25  core.managers.storage.*                  12  core.managers.spaceFiles.localFileRegistry.add
17  core.managers.spaceFiles.localFileRegistry.*   9  core.managers.session.getDatabase
13  core.managers.sockets.peers.get            9  core.managers.connection.*
 8  core.managers.storage.queryFileRegistryRecords  8  core.space.leave
 8  core.managers.session.setMessageConfig     7  core.managers.session.getCredentials
 6  core.space.getCurrentState                 6  core.managers.spaceFileList.get
 5  core.managers.spaceFiles.localFileRegistry.delete
 5  core.managers.connection.swarmInstance / .leave
 4  core.space.list / join / create            4  core.managers.spaceFiles.fileEventBroadcaster.flush
 4  core.accounts.logout / create / authenticate
 3  core.managers.connection.connectWith       2  core.messages.send
 2  core.managers.mux (+ .send)                1  core.profile.update / .list / .getCurrentProfile
 1  core.managers.storage.updateSpace          1  core.managers.storage.querySpace
 1  core.managers.message.sendMessageToSocket  1  core.managers.spaceFiles.localFileRegistry.onChangeEvent
```

**`src/engine/engine.js`** — the bulk. Grouped:

- **Boot / identity**: `createCore({rootPath: <dataDir>/core-v2, bootstrap})` 1003… actually `1004`-area → **line 1003** is `accounts.authenticate`; `createCore` at **~1002** (`this.core = await createCore({ rootPath: path.join(this.dataDir, 'core-v2'), bootstrap: this.bootstrap })`), `accounts.create` **812**, `accounts.authenticate` **1003**, `accounts.logout` **1374**, `session.getCredentials()` **1505, 1636, 4000** (+`#ownerSecret` 1504), `session.getDatabase().db` **1387** (`get db()`), `session.getDatabase?.().sqlite` **1041**, `session.setMessageConfig` **1058, 1063**.
- **Events** (`core.emitter.on`): `Handshake` **828**, `Connection` **833**, `Disconnect` **839**, `ProfileUpdate` **1071**, `SpaceFileEvent` **1088**, `SpaceSync` **1093**, `SpaceHashList` **1124** (+ debug dup **1184**), `General` **1152**, `Reject` **1170**. `EVENTS.SpaceFileEventOptions.ADD/REMOVE` consumed at **2388–2420**.
- **Spaces**: `space.list()` **1395**, `space.create()` **1474**, `space.join()` **2048**, `space.leave(space)` **2162**, `space.getCurrentState()` **6257**, `storage.updateSpace(payload, secretKey)` **1531**, `storage.querySpace(...)` **1628**, `getSpaceToTopicMap`/`getTopicToSpaceMap` **1416–1417**.
- **Connection / swarm internals**: `connection.update()` **2031, 2112, 2175**, `connection.leave(topic)` **2111, 2174**, `connection.swarmInstance` **4117, 4146, 5724, 6242**, `connection.connectWith` **4146-area** (`#primedDial` fallback), `connection.discoveryMap` **1335–1350** (`refreshConnections`), `swarmInstance._handlePeer` **4094** (private Hyperswarm entry point), `swarmInstance.dht.connect` monkey-patched **4114–4138**, `swarmInstance.dht.io._boundServerPort` **4048**.
- **File registry writes**: `spaceFiles.localFileRegistry.add({spaceId, spacePath, spaceFilename, fileSourcePath, tree?, metaHash?})` **3324, 3414, 3504, 3518, 4627, 4669, 4911**; `.delete({registryId})` **2143, 3344, 3354, 3517, 3560**; `.onChangeEvent(abs)` / `.onDeleteEvent(abs)` **2807, 2812** (inside `#onFsEvent`); `.watcher` **4448** (`pcWatcher?.unwatch/add` during relocation); `spaceFiles.fileEventBroadcaster.flush()` **2147**; `fileEventBroadcaster.peerFilter = …` **1027–1028**.
- **Registry reads**: `storage.queryFileRegistryRecords(filters)` **2862, 3362, 3428, 3509, 3520, 3548, 3575, 4420, 4535, 4873, 4909, 4916, 5007, 6319, 6379, 6497**; `storage.listFileRecords()` **410, 2573, 6361**.
- **Direct SQLite / ORM**: `db.update(fileRegistry).set({fileSourcePath}).where(eq(...))` **4426, 4479**; `db.select().from(fileIndex).where(eq(fileIndex.registryId, …))` **4892** (`#treeOfRow`); `deleteFileRecord(this.db, row.id)` **3555**; `getFileTreeLeafs(this.db, row.id)` **4540**; raw `sqlite.prepare(...)` FK-ordered wipe **2203–2229** (`#forceLeave`); `sqlite.exec("CREATE INDEX IF NOT EXISTS pd_file_registry_*")` **1041–1050**.
- **File list**: `managers.spaceFileList.get(topic)` **2555** (`#seedCatalog`).
- **Sockets**: `managers.sockets.peers.get(pk)?.socket` **1634, 1920, 1940, 2338**.
- **Message**: `managers.message.sendMessageToSocket(msg, sock)` **1652** (hand-built `createSpaceSyncMessage` with a random nonce).
- **Profiles**: `profile.getCurrentProfile()` **1237**, `profile.update({username, tag:'peardrive'})` **1239**, `profile.list({publicKey, limit:1})` **1977**.
- **Crypto**: `pcHash`/`hex`/`randomNonce` **1646** (nonce), `generateMerkleTree`+`createFileStream`+`getFileSize`+`DEFAULT_CHUNK_SIZE` **3138–3144** (`#precompute`), `getFileMetaHashFromSource` **3137**, `signJSON`/`verifySignedJSON` **4000, 4001** (introducer wiring), `verifySpaceFileRecordSignature` **2478**.

**`src/engine/swarm.manager.js`**
- `core.managers.mux.routingMap.set(0x03, …)` **190–195**; `.set(FrameTypes.STREAM, …)` **204–207** (takes over pearcore's STREAM lane); `core.managers.mux.send(socket, frame, 0x03)` **1422**.
- `core.managers.sockets.peers.get(pk)?.socket` **384, 405, 409, 492, 1270, 1294, 1328, 1428**; iterate `.peers` **982** (`peersInTopic`, reads `rec.topics`), **1807**.
- `core.managers.storage.queryFileRegistryRecords({rootHash})` **425, 1009, 1061** (serve path: tree + chunks).
- `core.managers.spaceFiles.localFileRegistry.onChangeEvent(record.fileSourcePath)` **436** (hashCheck self-heal).
- `publicKeyIsAllowedToRead(sender, space)` **1434** (`#senderMayRead`).
- `DEFAULT_CHUNK_SIZE` asserted equal to `LEAF_SIZE` at construction **183–186**.
- `hash`, `hex`, `randomNonce` for leaf hashes and reqIds (**1134, 1260, 1294…**).

**`src/engine/gossip.js`**
- `core.emitter.on(EVENTS.SpaceMessage)` **123**, `on(EVENTS.Handshake)` **129**.
- `core.managers.session.getCredentials().publicKey` **187, 307, 837**.
- `core.managers.sockets.peers` (keys/get) **341, 349, 374, 385, 504**.
- `core.messages.send(space, payload)` **814** — the *only* use of the message service; comment at 808–811 notes it must be handed the **SpaceInstance**, not a hand-built `{spaceName, publicKey, nonce}` subset.

**`src/engine/introduce.js`**
- `core.emitter.on/off(EVENTS.Handshake)` **72, 76**.
- `core.managers.connection?.swarmInstance?.dht` **84** (and `dht.io._boundServerPort` **89**).
- `core.managers.sockets?.peers?.get(pk)?.socket` **156**.

**`src/engine/agent.js`** (AgentSidecar)
- `engine.core.managers.storage.queryFileRegistryRecords({rootHash})` **94**; `({spaceId, spacePath, spaceFilename})` **204**; `({fileSourcePath})` **224**.
- `core.managers.spaceFiles.localFileRegistry.delete({registryId})` **208**, `.add({...})` **215**.
- `engine.core.managers.session.getCredentials()` **259**.
- `signJSON` **260**, `verifySignedJSON` **469**.

**`src/server.js`**
- `engine.core.space.getCurrentState()` **179**.
- `engine.core.managers.spaceFileList.get(topic)` **197**.
- `engine.core.managers.sockets.peers.entries()` **208**, `.size` **225**.

**`electron/main.js`**, **`src/index.js`** — no pearcore use; they construct `SyncEngine` and read `PEARDRIVE_MAX_MSG_MB` / `PEARDRIVE_MSG_PER_SEC` which engine forwards to `session.setMessageConfig`.

---

## 2. On-disk format assumptions

### 2.1 Directories pearcore owns, that PearDrive reaches into

| Path | Owner | PearDrive's assumption | Site |
|---|---|---|---|
| `<dataDir>/core-v2/` | pearcore (`createCore({rootPath})`) | the account root name `core-v2` is PearDrive's own versioning scheme, deliberately distinct from the v0.1 `<dataDir>/pearcore/` dir so a stale DB can never be half-migrated | `engine.js` ~1002; `config.js:12–19` |
| `<dataDir>/core-v2/<username>/.account/spacebook.sqlite` (+ `-wal`, `-shm`) | pearcore | **PearDrive writes it directly** — see below. Username is the literal `'device'` (`ACCOUNT_USERNAME`, `engine.js:82`) | |
| `<dataDir>/core-v2/<username>/.account/credentials.enc.json`, `meta.json` | pearcore | not touched; the password/mnemonic are mirrored into `peardrive.json.account` | `engine.js:812–821` |
| `<dataDir>/core-v2/<username>/drive/` | pearcore (download temp root) | **unused by PearDrive** — PearDrive never calls pearcore's downloader, so this tree stays empty. New pearcore's `getTemporarySourcePathForSpaceFile` would put partials at `<drive>/<topic>/<rootHash>/<filename>` — a second, conflicting partial convention | `pearcore-mobile/src/utils/files.utils.js:40–50` |
| `<pearcore DEFAULT_ACCOUNT_DIR>/.logs` | pearcore pino | PearDrive's `installDebugLog` tees pearcore's logger into its own file; patch §P makes a failed transport non-fatal | `src/lib/debuglog.js:26` |

### 2.2 pearcore SQLite tables PearDrive reads and writes directly

Through drizzle (`fileRegistry`, `fileIndex` from `file.schema.js`) and raw `better-sqlite3`:

- **`file_registry`** — `UPDATE … SET file_path = ?` on relocation (`engine.js:4426, 4479`), row delete without broadcast (`deleteFileRecord(db, id)`, `engine.js:3555`), and three custom indexes created at boot:
  ```sql
  CREATE INDEX IF NOT EXISTS pd_file_registry_path  ON file_registry(file_path);
  CREATE INDEX IF NOT EXISTS pd_file_registry_root  ON file_registry(root_hash);
  CREATE INDEX IF NOT EXISTS pd_file_registry_space ON file_registry(space_id, space_path, space_filename);
  ```
  (`engine.js:1030–1052`; comment: "13–15 ms per full-table scan at 115k rows … a 30k-file add ran at 42 ms/file, a third of it these scans").
- **`file_index`** — read back to reconstruct a precomputed Merkle tree in pearcore's own shape (`#treeOfRow`, `engine.js:4891–4902`): `{rootHash, height: levels.length-1, levels[level][] = {level, nodeIndex, hash, parentHash, leftChildHash, rightChildHash, leafIndex}}`. Also `getFileTreeLeafs(db, registryId)` for the cross-device move leaf check (`engine.js:4540`).
- **`spaces`, `sharelinks`, `space_members`, `read_whitelist`, `broadcast_whitelist`, `partial_download_record`** — raw FK-ordered `DELETE` in one transaction in `#forceLeave` (`engine.js:2202–2230`). The order is hard-coded: `file_index` → `partial_download_record` → `file_registry` → `space_members` → `broadcast_whitelist` → `read_whitelist` → `spaces`, then `sharelinks`. Column names are spelled literally (`space_name`, `public_key`, `nonce`, `file_registry_id`, `registry_id`).
- Record-shape assumptions on query results: `r.id`, `r.fileSourcePath`, `r.spacePath`, `r.spaceFilename`, `r.rootHash`, `r.metaHash`, `r.spaceId`, `r.timestamp`. Also the documented quirk that `listFileRecords()` **strips row ids** while `queryFileRegistryRecords()` keeps them (`engine.js:3541–3547`, `6379–6386`).

### 2.3 Files PearDrive owns in its data dir (`~/.peardrive` by default)

| File | Format | Written by |
|---|---|---|
| `peardrive.json` | pretty JSON, whole-file rewrite on every `saveConfig()` (710 KB live) | `config.js:64–67` |
| `peardrive.v1.json`, `catalog.v1.json`, `spaces.v1.json` | migration archives (coreVersion mismatch) | `config.js:42–59` |
| `catalog.json` | compact JSON snapshot, temp+rename `${file}.${pid}.tmp` (48 MB live) | `catalog.js:200–330` |
| `catalog.journal` | newline-delimited JSON append log; replayed over the snapshot at load; torn last line skipped; folded into a snapshot every 15 min / 24 MB | `catalog.js:46–135, 307` |
| `spaces.json` | pretty JSON, debounced 250 ms | `spaceindex.js:34–44` |
| `activity.json` | the social feed (`{seq, events[]}`) | `engine.js:213–244, 438` |
| `catsync-history.json` | delta-chain links per topic (bounded 30k keys) | `gossip.js:56, 115–121` |
| `thumbs/<rootHash>.jpg` | ~320 px JPEG, content-addressed (23 615 files live) | `thumbs.js:49` |
| `thumbs-failed.json` | `rootHash → nextTryAt` persisted backoff | `thumbs.js:57–61` |
| `agent-processed.json` | answered request ids (last 2000) | `agent.js:54, 69–75` |
| `agent-asks/*.json`, `agent-asks/done/`, `agent-replies/*.json`, `agent-mesh.json` | the ask-drop protocol | `agent.js:327–395` |
| `peardrive-debug.log`, `peardrive-debug.prev.log` | tee of stdout+pearcore logger | `src/lib/debuglog.js` |
| `heap-<ts>.heapsnapshot` | on `/api/debug?heap=1` | `server.js:171` |

### 2.4 Files PearDrive writes inside *shared folders* (the `.pearmeta` system)

All under a space folder's root, and all excluded from scans/announcements by `ignore.js` (`'.*'` then `'!.pearmeta'` then `'.pearmeta/cache/'`):

| Path | Format |
|---|---|
| `<folder>/.pearmeta/thumbs/<fileRootHash>.jpg` | a real, *registered*, hidden space file — thumbnails travel as index entries, not as a side channel (`engine.js:4575–4577, 4649–4706`) |
| `<folder>/.pearmeta/thumbs/<fileRootHash>.none` | the NO-THUMBNAIL marker, content `{"none":true,"subject":"<hash>","at":<ms>}` — unique per subject so content-identity dedupe never merges markers (`engine.js:4580–4586, 4611–4645`) |
| `<folder>/.pearmeta/cache/<rootHash12>` | stream partial destination (never beside user files); `+ .swarm.part` and the sidecar live here too (`engine.js:4265–4273`) |
| `<folder>/.pearmeta/agents/<host>/status.json`, `inbox/<id>.json`, `outbox/<id>.json` | the Agent Mesh bus; `<host>` = `sanitize(hostname)-<pk[0:8]>` (`agent.js:10–12, 81–86`) |
| `<folder>/.pearignore` | gitignore-subset rules, last match wins (`ignore.js`) |

### 2.5 Transfer litter conventions (PearDrive's own, must survive the port)

- `<destination>.swarm.part` — sparse data file (`partial.store.js:52`)
- `<dir>/.pd-partial-<rootHash12>.json` — `{rootHash, size, leafCount, destination, have: <hex bitfield>}` (`partial.store.js:53–57`)
- `<dest>.failed-verify` — bytes parked after an assembled-root mismatch, never deleted (`swarm.manager.js:2216`)
- `<to>.pdmove-<pid>` — cross-device relocation temp (`engine.js:4474`)
- `<newDir>/.pd-probe-<pid>` — writability probe (`engine.js:4317–4319`)
- `.<basename>.<pid>.tmp` — agent atomic publish (`agent.js:192`)
- `<name>.part` → rename — `/api/upload` (`server.js` upload route)
- All of these are matched by `isTransferLitter()` (`ignore.js:215–224`) so no peer's announcement can get them into any index.

**`metaHash` semantics are load-bearing:** `metaHash = hash({size, mtime})`. The relocation code therefore *restores mtime* on cross-device copies, because a changed mtime would read as content drift on every file (`engine.js:4300–4303, 4470`).

---

## 3. PearDrive state that duplicates or extends pearcore state

| PearDrive store | File / shape | Duplicates / extends |
|---|---|---|
| **Catalog** | `src/engine/catalog.js` → `<dataDir>/catalog.json` + `.journal`.<br>`{spaces: {<topic>: {files: {<spaceFilePath>: {variants: {<rootHash>: {size, mtime, providers: {<pk>: {state:'has'\|'deleted', updatedAt, at}}, firstSeen, localHidden, localTombstone}}}}, devices: {<pk>: {hostname, alias, firstSeen, lastSeen, member?, left?, offline?[]}}, tombstones: {"path\|hash": ts}, purged: {"path\|hash": ts}, hiddenLocal: {"path\|hash": ts}, providerSig: {<pk>: sig}}}}` | **The persistent twin of `managers.spaceFileList`** (which is in-memory, per-session, `{path: {rootHash: {peers: {pk: {timestamp}}}}}`, forgets offline providers, carries no size/mtime). Catalog adds: persistence, offline providers, per-provider `deleted` state, owner purges, local tombstones/hides, device roster + membership history, metadata, a revision ring (`rev`/`changedSince`) and a content-identity index `rootHash → Set(paths)`. Header comment at `catalog.js:1–22` states exactly this. |
| **Download ledger** | `peardrive.json.downloaded`: `{<rootHash>: {spaceFilePath, localPath, at, verified, deletedAt?}}` (`config.js:29`) | Replaces pearcore's `partial_download_record` table (which PearDrive never writes). `#ledgerCheck` (`engine.js:6946`) keeps it honest against the disk; law "a receipt whose bytes are gone is NOT forgotten" (otherwise the policy pass re-downloads). |
| **Shared-folder bindings** | `peardrive.json.sharedFolders`: `[{localPath, spaceFolder, topic, managed?}]` | pearcore has **no folder concept** — only per-file `(fileSourcePath ↔ spacePath/spaceFilename)` rows. The folder↔space-prefix mapping is entirely PearDrive's. |
| **Disk-base overrides** | `folderDirs: {"<topic>/<spaceFolder>": absBase}`, `spaceDirs: {<topic>: absDir}` | pearcore has no download-destination model; `destFor()` resolves these. |
| **Space decoration** | `src/engine/spaceindex.js` → `spaces.json`: `{focus, spaces: {<topic>: {localName, officialName, officialNameTs, thumbnail, order, addedAt, handle, isOwner, ownerKey, isPrivate}}}` | Extends pearcore's immutable `spaceName` handle with local nickname + owner-published official name (LWW by ts) + a cached identity snapshot so the pre-network boot paints the sidebar. |
| **Policy tree** | `peardrive.json.policyTree`: `{<topic>: {mode, devices: {<pk>: {mode, folders: {<name>: {mode}}}}}}`, modes `view\|selective\|auto` (`policies.js:18–21`) | No pearcore equivalent. |
| **Rider policy** | `riderPolicy: {<topic>: 'auto'\|'selective'}` | previews/metadata sync gate, independent of Downloads policy. |
| **Local arrangement** | `arrange: {<topic>: {folders: [...], moves: {<rootHash>: destDir}}}` (`engine.js:5057–5115`) | A *view* remap of the shared index — folders as an index abstraction, never synced. |
| **Peer / roster state** | `peerAliases`, `peerStars`, `peerProfiles: {<pk>: name}`, `peerAddrs: {<pk>: {host, port, at, via}}`, `peerCards: {<pk>: signed card}`; in-memory `_onlineSet`, `_names`, `_peerHashlists`, `_dialState`, `_lastDial` | Duplicates/extends `managers.sockets.peers` (live only) and `profile.list()` (network only). `peerAddrs` is a persisted address book pearcore has nothing like; it feeds `#primedDial`. |
| **Access / membership** | `accessLog: {<topic>: {<pk>: {status:'pending'\|'approved'\|'denied'\|'banned', hostname, at}}}`, `membership: {<topic>: {status:'waiting', at}}`, `askedTopics: {<topic>: ts}`, `agentAdmins: [pk]` | pearcore stores the whitelist inside the signed space record only. `askedTopics` is PearDrive's memory of "we pasted this link", the defence against unasked space records. |
| **Index quarantine** | in-memory `precomputed: Map<abs, {metaHash, tree, size}>` (bounded 250 000) + persisted intent `pendingShares: [{localPath, topic}]` | Pre-hashes Merkle trees before the user commits; handed to `localFileRegistry.add` as `{tree, metaHash}` (patch §Q). |
| **Unreadable ledger** | in-memory `unreadable: Map<abs, {code, at, ctimeMs}>` (bounded 100 000) | State, not a retry queue — re-considered only when the inode's ctime moves. |
| **Registry version / touch set** | `_regVer`, `_regTouched: Map<srcPath, Set<"topic\|spacePath">>`, `_regFull`, `_knownCache: Map<topic, {regVer, set<absPath>}>` | A change-detection layer over pearcore's registry so the 10 s sweep doesn't re-read every row (`engine.js:6295–6313`). |
| **Listing caches** | `_lst: Map<topic, listing>`, `_counts`, `_viewVer`, `_arrVer`, `_polRev`, `_machRev`, `_thumbRecheck` | Derived views keyed by catalog revision. |
| **Thumbnail repo** | `thumbs/<rootHash>.jpg` + `thumbs-failed.json` | Content-addressed previews, generated by whoever holds the bytes; also *published* as hidden space files so existence is a catalog fact. |
| **Transfer state** | `swarm.tasks: Map<"topic\|rootHash", SpaceSwarmTask>`, `_queue[]`, `_failures: Map<key, {spaceFilePath, dest, error, attempts, retryAt}>`, `_recent[]`, `_suppressed: Set`, `_cancelReg`, partial stores on disk | Entirely replaces pearcore's `downloadTasks` map + `partial_download_record`. |
| **Gossip sync state** | `deltaPeers: Set<pk>`, `peerTopics: Map<pk, Set<topic>>`, `_lastAnnounced: Map<topic, {sig, n, map}>`, `_history` (persisted) | The signed catalog-sync layer that *replaces* pearcore's file-list replay for modern peers. |

---

## 4. Where PearDrive papers over a pearcore quirk or bug

### 4.1 `scripts/patch-pearcore.mjs` (868 lines, runs as `postinstall`, patches the **installed copy only**)

Header states the target is `github.com/peardrive/Pearcore @ 8221447` and lists patches already retired because upstream fixed them (`deleteSpace` FK, `add()` watcher-null, `onChangeEvent` crash, broadcast peerInfo throw, unbounded message persistence / "the 14GB sqlite", chunked tree insert / ">~455MB could never register: SQLite's 32,766-var cap", un-awaited SpaceHashList loop).

| § | File | What it fixes | Status at new pearcore `35dfca1` |
|---|---|---|---|
| **§1** | `utils/merkletree.utils.js` | case-mismatch shim: four modules `import '.../merkletree.utils.js'` but the file is `merkleTree.utils.js`. "Loads on case-insensitive filesystems (macOS), dies on Linux." | **STILL NEEDED** — new tree still imports lowercase from 5 sites (`registry.js:17`, `trees.js:2`, `files.utils.js:10`, `files.protocol.js:8`, `protocol.utils.js:5`) while the file is `merkleTree.utils.js` |
| **§2** (4 steps) | `managers/storage.manager.js` | phantom imports (`generateFileRecord`, `listFileRegisteryRecords` don't exist), `createFileRecord` rewired to `generateFileTreeRecord`, `listFileRecords` rewired, `for (const record in query)` → `of` | **DELETE** — StorageManager no longer exists |
| **§4** (2 steps) | `managers/multiplexer.manager.js` | `route()` is not concurrency-safe: *"awaits async handlers mid-parse while new events re-run route() against the same per-peer buffer. The resumed call re-dispatches frames from its stale local buffer (duplicate messages → spurious Rejects) and overwrites the shared buffer, erasing bytes accumulated meanwhile (STREAM frames silently lost — field-observed: downloads stuck at 0%, mid-stream stalls)."* Fix = one strictly-ordered promise chain per peer + clear the tail in `cleanup`. Repro: `test/route-race2.test.mjs` | **UPSTREAMED** — new mux has per-socket `state.readQueue` (`multiplexer.manager.js:125–141`) |
| **§C** | `utils/general.utils.js` | `validateFilePath` whitelist `[a-zA-Z0-9_.-]` rejects spaces/brackets/unicode → *"Every SpaceFileEvent for such a file bounces off the receiving peer ('event actions should be valid'), the sender's broadcaster retries, and the pair drips rejects forever."* Also: *"PearCore's OWN sender builds event paths with path.posix.join — which never yields a leading slash — while this validator demanded one: every file event ever sent by the file manager failed its own protocol validation."* | **UPSTREAMED** (`general.utils.js:77–`) |
| **§L** (2 steps) | `utils/network.utils.js` | lab-only `firewalled:false` DHT — loopback bootstrap can't complete firewall detection | **STILL APPLIES** |
| **§S** (3 steps) | `connection.manager.js`, `sockets.manager.js` | *"P2P peers close idle connections CONSTANTLY: every cycle produced a WARN pair … the second is the 'close' handler double-cleaning what the 'error' handler already removed. Field logs were a wall of scary-looking routine."* | **§S2/§S3 still apply** (`sockets.manager.js:73, 79`); **§S1 anchor gone** (cosmetic) |
| **§R** | `protocol/files.protocol.js` | *"`diff()` returns an OBJECT … but the REMOVE branch calls `diff.forEach(...)` as if it were a record array. Any incoming REMOVE that survives the diff THROWS … so the receiver neither updates its list NOR informs the application. Every live deletion broadcast was silently discarded at every receiver (field, Aug 28: the immortal deleted-file claims)."* | **UPSTREAMED** (`protocols/files.protocol.js:114–132`) |
| **§E** | `managers/delivery.manager.js` | missing `.js` extension → `ERR_MODULE_NOT_FOUND` on plain Node. *"Same disease as the merkletree case shim: the tests pass, the runtime dies."* | **UPSTREAMED** |
| **§W** | `utils/files.utils.js` | `createWatcher` → an inert API-compatible stand-in. *"chokidar 5: no native recursion, no fsevents, no ignores. PearCore's LocalFileRegistry calls it for EVERY registered file path (plus watcher.add per registration, behind an O(n) getWatched() scan) — one fs.watch handle per directory of the share and O(n²) registration on a big folder. FIELD (Sep 2): sharing ~/Projects hit EMFILE, flooded one error per directory, and froze the app on every boot."* | **STILL NEEDED** (`files.utils.js:63–73` unchanged chokidar) |
| **§Q** (2 steps) | `utils/files.utils.js` + `managers/file.manager.js` | HASH ONCE: `generateFileTreeRecord` accepts `params.tree` when `params.metaHash` still matches; `LocalFileRegistry.add` forwards it | **§Q1 upstreamed** (`files.utils.js:532 if (params.tree)`); **§Q2 must be RE-TARGETED** — `registry.add()` destructures only `{spaceId, spacePath, spaceFilename, fileSourcePath, onIndexingStart, onCompletion, onError}` (`registry.js:261–271`) and never forwards `tree`/`metaHash`, so the quarantine's precomputed trees would be thrown away and every file hashed twice |
| **§O** | `utils/files.utils.js` | `getFileMetaHashFromSource` opened the file `'r+'` just to hash metadata → EACCES on any read-only file. *"Guy, Sep 2: 1,800 files under ~/Projects/…/ios/Pods."* | **UPSTREAMED** (`system.utils.js:11 fs.open(filePath,'r')`) |
| **§D** (3 steps) | `protocol/space.protocol.js` | *"SpaceSyncHandler answered EVERY direct SpaceSync — even IDENTICAL — with the topic's ENTIRE file list (all providers' records). One reconnect or wake = one full list per topic each way (Sep 2–4: 5MB in 50s after a laptop wake, the stream queued behind it)."* Keeps the push for FIRST_ENCOUNTER only | **STILL NEEDED — correction to `drive-migration-map.md`.** At `35dfca1` `sendSpaceFileListContextToSocket` is still called in `LOCAL_SPACE_REQUIRE_UPDATE` (`protocols/space.protocol.js:200`), `PEER_REQUIRE_UPDATE` (**218**) and `IDENTICAL` (**233**). Only the folder renamed (`protocol/` → `protocols/`) |
| **§D2** | `managers/file.manager.js` | *"LocalFileRegistry.start() re-signed EVERY registered file at boot and broadcast the whole registry to every connected peer (lab: 611 records / 190KB per boot; the Mac's 25k-row registry would be megabytes)."* | **STILL NEEDED, re-target** to `managers/files/components/registry.js:269–275` (`init()` still does `spaceFileListManager.add(record)` **and** `fileEventBroadcaster.add(ADD, record)` per row) |
| **§V** (3 steps) | `utils/crypto.utils.js` | sodium-native Ed25519. *"1.65ms per verify … Every file record is verified TWICE on receipt (PearCore, then PearDrive) — the '2ms per record' that pinned the Mac's loop for 27 of the 45 seconds after a wake (5,000-record list = 10s frozen). sodium-native … 0.058ms — 28x."* | **STILL APPLIES** — new `crypto.utils.js` is pure `@noble/curves` |
| **§J** (2 steps) | `connection.manager.js` | *"join() awaited discovery.flushed() (the DHT announce reaching the network — unbounded on a slow DHT; six minutes on Sep 6) BEFORE storing the discovery, so until then the topic was absent from every hashlist update() sent and space.join()/create() did not return."* Also un-blocks `leave()` | **STILL NEEDED** — `joinSwarmTopic` still `await discovery.flushed()` (`network.utils.js:157`) and `connection.join` awaits it before storing (`connection.manager.js:112–113`); `leave` still `await discovery.destroy()` (**133**) |
| **§P** | `logger.js` | *"pino's transport is a ThreadStream; on a write error (ENOSPC, Sep 9) it emits 'error' with no listener, Node throws, the process dies. Logging must degrade, never kill a running sync."* | **STILL APPLIES** |
| **§I** (2 steps) | `managers/file.manager.js` | (a) *"a registry row whose file is not on disk at boot was DELETED. With an external volume that is simply not mounted yet, that is every file on it — gone from the index (and REMOVEs to every peer) for being unavailable for a minute."* (b) one throw in the per-file loop took down `init()` and engine start | **MANDATORY RE-TARGET** — `registry.js:113–124` still deletes rows for missing sources. (b) is partly covered by the new per-group try/catch around hashing |
| **§K** | `managers/file.manager.js` | host-settable `peerFilter` on `FileEventBroadcaster.broadcast()`. *"PearCore's SpaceFileEvent for the same registration is a second copy of the same news on the same socket (lab: 400 KB / 1,300 records every 10 s during a 30k-file add), which the receiver verifies, diffs, merges and RELAYS to every other peer before the host app throws it away — 300–480 ms of pinned loop per batch."* Also skips the send when `sockets.length === 0` | **RE-TARGET** to `managers/files/components/events.js:116–124` (no `peerFilter` hook) |
| **§N** | `managers/file.manager.js` | `SpaceFileListManager.remove()` emptiness test was `Object.keys(spaceFiles).length === 0`. *"Unsharing a 30k-file folder from a 250k-file space is 30k × 250k key copies — the lab pinned the event loop for half an hour (and every peer's REMOVE receipt pays the same)."* | **RE-TARGET** to `managers/files/files.manager.js:237–240` (unchanged) |

### 4.2 Workarounds inside PearDrive's own code (not patches)

| Where | Quirk papered over (quoted) |
|---|---|
| `engine.js:3324–3340, 3414, 4627, 4911`, `agent.js:215–223` | every `localFileRegistry.add` is wrapped: `if (/already exists/i.test(String(err?.message))) return null; // idempotent` — the error message *is* the API |
| `engine.js:3341–3360` | registration race guard: stat before/after the add; *"merkle-hashing a big file takes time — a file that changes DURING hashing gets a stale hash with a fresh timestamp that no drift check can catch"* → delete the row and retry |
| `engine.js:3487–3534` (`onDownloaded`) | *"LAW A: A CLAIM COMES ONLY FROM A REGISTRY ROW. 'already exists' is an answer, not a success: the row at this path may carry an OLDER rootHash … the registry kept the first hash forever, the catalog claimed the new one, reconcile flipped them every 10s and both machines re-downloaded the file every 15s: 359 verify-fails in 45h on Linux."* |
| `engine.js:3541–3547` | *"queryFileRegistryRecords keeps row ids; listFileRecords STRIPS them — and an id-less record makes every unregister throw. Field (Sep 2): 'unshare' of a 24k-file folder reported ok, deleted nothing."* |
| `engine.js:3552–3557` + `lib/pearcore.js:56–61` | `#retireRow` uses raw `deleteFileRecord` to avoid pearcore's REMOVE broadcast: *"Going through localFileRegistry.delete() told every peer we no longer have the file; they dropped the claim, cancelled their downloads, and — our share being unchanged — never got it back (Sep 5–6, reason-WATCH)."* |
| `engine.js:6330–6400` | registry hygiene: duplicate rows per space path are *"POISON: the catalog allows one variant claim per provider, so two live rows for one path make this reconcile re-claim them ALTERNATELY — every pass 'adjusts' … (field, Aug 29: the AgentOps status.json had rows at two historical disk locations — a 10-second manifest storm across the whole mesh)."* Newest row wins; twins retired silently |
| `engine.js:2155–2186` (`leaveSpace`) | *"THE INSTANCE, not its sharelink string: PearCore's leave(space) reads space.topicHash / isSync / id. Handed a string it left no topic, deleted nothing, swallowed its own error and returned."* Then: *"PearCore's leave catches its own delete failure and returns as if it succeeded. Leaving must be bulletproof: VERIFY the row is gone and finish by hand if it is not."* → `#forceLeave` raw SQL |
| `engine.js:1093–1118` | *"PearCore promotes a peer's space record into a new space of ours on 'first encounter' when we hold ANY unredeemed sharelink — not the sharelink for THAT space (it queries the sharelinks table unfiltered). So while one link of ours waits for approval, any owner-signed record for any topic the sender advertises becomes a space we are in, secret and all (field, Sep 15: the mini was put into a private space it had never held a link to)."* → `_askedTopics` + `#refuseUnaskedRecord` |
| `engine.js:1643–1653` | *"FRESH NONCE, NOT the default payload-derived one. PearCore derives SpaceSync nonces from the record content, and receivers dedupe by nonce — so an UNCHANGED record can be delivered at most ONCE per receiver session … every re-send is silently swallowed forever and the joiner sits at 'syncing…' until a restart."* |
| `engine.js:1536–1546` | *"ENCRYPTION SECRET, the flip gap: PearCore auto-generates a secret at CREATE time when permissionRead is false … but the UPDATE path only carries whatever secret the record already has."* → mint/shed the 64-hex secret by hand |
| `engine.js:1327–1352` (`refreshConnections`) | *"The old leave+join per topic awaited a DHT flush twelve times in series (minutes after a sleep), emptied discoveryMap topic by topic so every hashlist sent meanwhile was missing topics (Kimi's 'flicker'), and made the peer re-dial ('Duplicate connection') — killing whatever was being served."* → `discovery.refresh()` in place, not awaited |
| `engine.js:4070–4106` (`#primedDial`) | *"Hyperswarm dials a key through the DHT: findPeer, then a handshake relayed by a DHT node … Two freshly restarted nodes behind one NAT never get that far: the relayed handshake hairpins and dies (HOLEPUNCH_ABORTED after ~11 s) … `joinPeer(key)` has no address parameter and OVERWRITES them with null (index.js:414)."* → calls Hyperswarm's **private** `swarm._handlePeer({publicKey, relayAddresses})`, feature-checked, plain dial as fallback |
| `engine.js:4108–4138` (`#watchDials`) | *"Hyperswarm surfaces no per-dial failure — the socket closes inside it and only the attempt counter moves."* → monkey-patches `dht.connect` for diagnostics |
| `engine.js:1256–1312` (wake watcher) | *"The first fix compared the wall clock with process.hrtime, on the belief that the monotonic clock stops during a sleep. It does not: Node's hrtime is libuv's uv_hrtime, which on macOS is mach_continuous_time — it counts sleep."* → CPU-time test distinguishes sleep from a pinned loop |
| `engine.js:1170–1182` | Reject handler: *"'event actions should be valid' = the SENDER of this Reject runs an unpatched PearCore validator (pre-§C …). OUR machine already accepted the event — the reject is THEIR problem."* |
| `engine.js:1027–1028` + `2412–2418` | §K's two halves at the app level: broadcaster `peerFilter` on send; `gossip.deltaPeers` skip on receive — *"a REMOVE from a registry twin stripped a live claim on every peer, and no delta ever restored it"* |
| `engine.js:4448, 4487` | relocation order: rewrite the DB row **first**, then move bytes, *"safe against PearCore's registry watcher (which DELETES rows and broadcasts REMOVE when a watched file disappears)"*; plus `pcWatcher?.unwatch?.(from); pcWatcher?.add?.(to)` (cosmetic once §W is applied) |
| `engine.js:885–895` (comment) | *"THE TRANSFER CORE AND CATALOG SYNC ARE WIRED BEFORE THE SWARM JOINS ANYTHING. authenticate() joins every topic and LAN peers connect inside it; a control frame that lands before the mux route exists is dropped ('No handler registered for frame type 3')."* |
| `engine.js:824–832` (comment) | listeners attached **before** `authenticate()`: *"a listener attached afterwards misses the first Connection — which left `_onlineSet` empty at the first sweep and fired 'No peers for a while' (a full reconnect replay) on EVERY boot."* |
| `swarm.manager.js:54–62` | the whole `0x03` control lane exists because *"only handleIncomingMessage (the JSON lane) throttles; the mux dispatches other frame types straight to their handler. (Bug report §2.10.)"* |
| `swarm.manager.js:91–96` | *"The socket is shared and has no backpressure (PearCore), so unbounded concurrency saturates it and a new stream's tiny treeReq queues behind gigabytes of other chunk data (field-observed: 28s to start a stream while a download ran)."* → `MAX_PEER_INFLIGHT = 4` |
| `swarm.manager.js:853–876` | *"PearCore relays space messages to all topic peers, so third parties see copies of our requests and may err them ('unknown rootHash') — honoring those failed real requests and benched the actual provider."* → only the addressed peer may fail a request |
| `swarm.manager.js:877–898` | `chunkErr` must be routed to the pending **tree** promise first: *"the request waited out its full timeout and the task retried a hash that exists nowhere, forever."* |
| `swarm.manager.js:1041–1049` | *"Law B: an EMPTY file has ZERO leaves. The old `size === 0 ? 1` made every requester ask for leaf 0 of nothing, get 'range out of bounds', bench, retry — forever (field, Sep 2: af1349b9, the empty-content hash shared by every 0-byte file, looped 26 times in 25 minutes)."* `EMPTY_ROOT_HASH` is hard-coded at `swarm.manager.js:132` |
| `swarm.manager.js:183–186` | `if (DEFAULT_CHUNK_SIZE !== LEAF_SIZE) throw` — an upstream chunk-size change is a startup failure, by design |
| `swarm.manager.js:826–845` | DEAD-SERVE NAK: *"the SOURCE keeps queueing and sending every leaf of every dead range until it drains naturally — field (Sep 1): a peer spent the whole morning shoveling a night's worth of epoch-war corpses into the socket."* |
| `wire.js:26–35` | *"Uses streamx's Writable.drained() promise … NOT the 'drain' event. Lab-verified: on live stacked NoiseSecretStream sockets the event routinely never fires even though the queue reaches zero, which made every serve of a >highWaterMark leaf abort before its EOF frame (downloads stuck at 0% with all bytes already delivered)."* |
| `gossip.js:806–812` | *"Pass the SpaceInstance itself — the d819780 services refactor resolves topicHash/secret via its getters (the old hand-built {spaceName, publicKey, nonce} subset now fails 'topic is required', and would also skip encryption for private spaces)."* |
| `lib/debuglog.js:26` | *"never let logging break the app (ENOSPC on Sep 9 killed PearCore's own logger)"* |
| `engine.js:3020–3022` (walker) | `.pearmeta` pruned from the walk: *"walking it every 30 s was a rescan that 'found' 16k thumbnails each time and registered none."* |
| `engine.js:3166–3171` | `.pearmeta` content must register once at space-root paths: *"lab: every thumb appeared twice, once as .pearmeta/… and once as `<folder>/.pearmeta/…`."* |

---

## 5. The "drive" model as PearDrive implements it today

### 5.1 Space → folders → disk

- A **space** is a pearcore space (topic hash = identity). PearDrive binds *N* local directories into it: `config.sharedFolders = [{localPath, spaceFolder, topic, managed?}]`. `spaceFolder` is the **first path segment** of every space path contributed by that directory; name collisions get `-2`, `-3` suffixes (`engine.js:2653–2657`).
- A file at `<localPath>/<rel>` registers as `spacePath = <spaceFolder>[/<relDir>]`, `spaceFilename = basename`, `spaceFilePath = posix.join(spacePath, spaceFilename)` (`engine.js:3278–3284`).
- **Reverse resolution** `destFor(topic, spaceFilePath)` (`engine.js:4237–4256`): take `top = spaceFilePath.split('/')[0]`, then `#folderBaseFor(topic, top)` = `config.folderDirs["<topic>/<top>"]` → the shared folder's `localPath` → `config.spaceDirs[topic]/<top>` → `~/PearDrive/<top>`.
- **Managed folder**: `ensureManagedFolder(topic)` creates/adopts `config.spaceDirs[topic]` or `~/PearDrive/<sanitized display name>` and shares it like any other (`engine.js:2609–2638`). Everything the Add flow and `.pearmeta` publishing writes lands there.
- **Save-dir relocation** (`setSaveDir` / `#relocate`, `engine.js:4309–4528`): bytes first (atomic `rename`, or copy-to-`.pdmove-<pid>` + size/mtime check + first/last-leaf verify across devices), then `UPDATE file_registry SET file_path`, then unlink the source; `config.downloaded[*].localPath` and `folderDirs` follow; resumable via `config.jobs.relocate` and a boot "heal pass" that re-points rows whose bytes already moved.
- **Volumes**: `#roots()` + `#checkVolumes()` (`engine.js:6845–6935`) track `st.dev` per root in `config.rootDev`; a missing root or a changed device id = **offline**, not deleted. Offline folders ride `catState` to peers; watchers close; `applyPolicies` re-runs when a volume returns.
- **Local arrangement** (`arrange`, `engine.js:5066`): per-user folders and `rootHash → destDir` moves stored only in `config.arrange`; the shared index is untouched.

### 5.2 Watching

- **One** `fs.watch(root, {recursive: true, persistent: true})` per shared folder (`#watchFolder`, `engine.js:2729–2770`). FSEvents on macOS, kernel-managed elsewhere — *"ONE handle per shared folder, zero tree walk to arm it."*
- Event filtering happens **before** any stat: `.pearignore` edits set `needsRescan`; `/.pearmeta/` paths return; `loadIgnore(root).test(rel)` drops ignored paths.
- **750 ms per-path coalescing**; a `pending` map above 20 000 entries is dumped wholesale and the folder falls back to the heartbeat.
- Watcher failure (`EMFILE`/`ENOSPC`/network mount) → `#watchFailed`: close, log **once** per code, `watchStates[key] = {state:'fallback', code}`, surfaced in `state()`, a one-time user notice for `ENOSPC`.
- `#onFsEvent` decides from the filesystem's **current truth**, never the event type: gone → `reg.onDeleteEvent(abs)` + `#regTouch(…, 'delete')` + reconcile (unless the whole root vanished → `#checkVolumes`); directory → `#scanFolder({announce:true})`; file → `reg.onChangeEvent(abs)` (re-hash if registered) then `#registerFile`. If registration was refused by the probation gate it re-checks at exactly `mtime + 60 s`.
- **Heartbeat rescan** every 30 s (`#sweep`, every 3rd 10 s tick) plus on `needsRescan`. Cheapness contract: one `queryFileRegistryRecords({spaceId})` per space per pass, cached in `_knownCache` keyed by `_regVer`, so a quiet machine does readdirs only.
- `#walkFolder` is async and **sequential** (one readdir in flight), prunes ignored directories and `.pearmeta` before entering.
- PearCore's own per-file chokidar watcher is **inert** (patch §W); PearDrive calls `onChangeEvent`/`onDeleteEvent` itself. One mechanism, two consumers.

### 5.3 Registration gates (`#registerFile`, `engine.js:3166–3396`)

In order: reject `/.pearmeta/` under a folder prefix → `.pearignore` test → unconditional machinery refusal (`isMachineryPath && !isSanctionedMachinery`) → **probation** (`REGISTER_PROBATION_MS = 60 000`: *"sixty quiet seconds before an announcement, for every tool we never heard of"*) → for files ≥ 4 MiB younger than 10 min, `lsof -F a` write-lock check (`true` → wait; `null` → two-identical-stat fallback) → tombstone/owner-purge check (logged once per path per boot) → stat snapshot → `localFileRegistry.add({…, tree?, metaHash?})` with the quarantine's precomputed tree → stat again (changed → delete the row, retry) → re-query the row for its `rootHash` → `catalog.fileAdded` + `catalog.setMeta({size, mtime})` → `queueThumb` → `gossip.announceSoon()`.

**Index quarantine** (`prepareFolder` → `#runPrepare` → `#precompute`, `engine.js:3065–3148`): walk + `generateMerkleTree` into `this.precomputed` before the user commits; intent persisted in `config.pendingShares` and resumed at boot; `addFolder` hands the job's `pending` map over as `_pendingHandoff` so the folder never blinks empty; `discardFolder` drops the trees. The whole point is **hash once** (patch §Q).

**Ingest jobs** (`state.ingest.jobs`, keyed `"<topic>/<spaceFolder>"`): phases `discover → index → done`, counters `{found, total, done, added, skipped, failed, unreadable, current, pending: Map<rel,{st,size,why}>}`; `silent` for rescans, `quiet` under 50 files; *"the registry is the checkpoint"* so a job is interruptible.

### 5.4 Dedupe by hash

Three distinct mechanisms:

1. **Content-identity view** — `#dedupeContent(files)` (`engine.js:5184–5225`), purely derived: group a `catalog.files()` list by `rootHash`; the **official** entry is the one with the oldest evidence (`min(earliestAt, firstSeen)`); other names become `altNames[]`; `providers`/`onlineProviders` are the **union** across names; `own`/`have` are OR-ed. Nothing is stored or synced — *"the alternates were already in the index (that WAS the duplicate bug)."*
2. **Reclaim duplicates** — `reclaimDuplicates(topic)` (`engine.js:5137–5176`): for each multi-name hash group, move OUR local copies under alternate names to the OS Trash and withdraw those claims, keeping the official name. Hard rule: if the alternate is our **only** local copy of the bytes it is never touched.
3. **Cross-space reconnect (no copies)** — `#reconnectHeld` (`engine.js:4827–4866`) + `#heldSource` + `#treeOfRow` + `#registerHeld`: a content a peer claims in space B that we already hold anywhere (own claim in any space, or a live download receipt) is registered into B **at the existing disk path**, with the Merkle tree *read back from `file_index`* rather than recomputed. Gates: must have tree rows (*"a row we cannot serve is the orphan trap"*), source must exist/be readable/not offline, no real file already at that space path, not tombstoned, not machinery; if the registered row's hash ≠ the claimed hash the row is retired silently.
4. Plus `applyPolicies` refuses to download when `queryFileRegistryRecords({rootHash})` already returns rows — *"same content already registered locally"* (`engine.js:5008–5010`), and `localPathOf` has a content-identity fallback across alternate names (`engine.js:3966–3976`).

`catalog.fileAdded` also enforces **one variant claim per provider per path**: a new hash from the same provider deletes their claim on the other variants (`catalog.js:686–689`), which is what makes a re-hash a *replacement*, not a duplicate.

### 5.5 Downloads: queue, limits, verification (`swarm.manager.js`)

**Unit of work** = one 256 KiB merkle leaf (`LEAF_SIZE === DEFAULT_CHUNK_SIZE`, asserted). **Control plane** = mux frame `0x03`, direct, unrelayed, unthrottled, sender from `info.publicKey`. **Data plane** = `FrameTypes.STREAM`, framed `[1-byte reqIdLen][reqId utf8][leaf bytes]`, empty body = EOF; PearDrive **owns** the STREAM handler.

Ops: `treeReq/treeRes` (metadata only: `{size, leafCount}` — *"The full leaf list (≈550KB for a 2GB file) used to ship here and clog the single message socket"*), `chunkReq` → `chunkHead` (per-leaf verification hashes) → STREAM frames, `chunkErr`, `cancel`, `hashCheck`, `thumbReq/thumbRes`, `knockStatus`, `left`, plus registered ops (`catState/catSig/catReq/catSnap/catDelta` from gossip, `cards/whoIs` from introduce).

**Tiers** (`priority.js`): `INTERACTIVE(0)` / `SELECTED(1)` / `BACKGROUND(2)`. A viewer read within `VIEWER_HOT_MS = 10 000` promotes any task to INTERACTIVE. A starved interactive job (contiguous runway < `BUFFER_TARGET_S = 60` s at the measured consumption rate) owns the pipe **exclusively**; once buffered it shares. Viewer displacement is by **epoch**, not arrival (`?v=` from the UI, fenced in `server.js`), and displacement is `coolDown()`, never teardown.

**Queue and caps**:
- `MAX_ACTIVE_DOWNLOADS = 3` — applies to **BACKGROUND only**; SELECTED and INTERACTIVE never queue.
- `MAX_PEER_INFLIGHT = 4` global per-peer chunk requests, with INTERACTIVE metered on its own sub-budget; `PEER_WINDOW = 2` per task per peer.
- `REQUEST_LEAF_COUNT = 8` leaves (2 MiB) per `chunkReq`; provider guard `MAX_REQUEST_LEAF_COUNT = 32`.
- Queue order: `applyPolicies` enqueues in **display order** (path ascending); machinery (`.pearmeta/…`) always goes to the **back**, user content inserts ahead of any queued machinery; a user click on a queued task upgrades it to SELECTED and starts it immediately.
- **Admission gate** at start time, not enqueue time: `#variantAlive(task)` requires a living `state:'has'` provider in the catalog; `catalog.onVariantDead` → `swarm.dropVariant` closes queued/live/parked tasks *"that SECOND (field: 613 ghost tasks on one box)"*.
- `_suppressed` keeps a user-cancelled download cancelled across policy sweeps; a direct click lifts it.

**Timeouts / retries / benching**: `REQUEST_TIMEOUT_MS = 30 000` (sized for the serialized bulk lane — *"12s was cancelling batches the provider was still faithfully serving"*), `TREE_TIMEOUT_MS = 20 000` × `TREE_FETCH_ROUNDS = 3` across providers, `SESSION_IDLE_MS = 30 000`, `PEER_BAD_LIMIT = 2` with `BENCH_DECAY_MS = 30 000` (*"A permanent bench turned every transient stall into an infinite spinner"*), retry backoff `15 s · 2^n` capped at `10 min`, `RETRY_GIVE_UP = 8` → **PARKED** with `RETRY_PARK_MS = 6 h` (*"The old behavior (retry every 10 min FOREVER) … re-transferred the entire file six times an hour for zero result"*), `DRAIN_TIMEOUT_MS = 45 000`, `SCHEDULER_TICK_MS = 5 000` (re-pumps tasks whose in-flight count hit zero — *"this is what made downloads stall"*).

**Verification**: per-leaf against `chunkHead` hashes in flight; on completion `rootHashOf(dest)` (`verify.js`, pearcore's own `generateMerkleTree`) rebuilds the root. A mismatch **never destroys bytes** — renames to `<dest>.failed-verify`, fires `requestHashCheck` to every source, and if there was exactly **one** source retracts that provider's claim (*"the verify-fail twin of the 'unknown rootHash' retraction"*). Mid-stream, `MISMATCH_RETRACT_LIMIT = 2` consecutive leaf-hash failures from a sole provider also retracts.

**Resume**: `PartialFileStore` (sparse `<dest>.swarm.part` + `.pd-partial-<hash12>.json` hex bitfield, rewritten within 500 ms of every stored leaf). Every close keeps buffered leaves; abandonment is decided **only** by age in `#partialsJanitor` (`PARTIAL_MAX_AGE_MS = 14 d`), which also migrates legacy visible partials into `<folder>/.pearmeta/cache/`.

**Stream cache hierarchy** (`#cacheJanitor`, every 60 s): `CACHE_BUDGET_DEFAULT = 1 GiB` (`config.cacheBudget`), everything younger than `CACHE_RECENT_MS = 5 min` kept whole, older trimmed to `CACHE_HEAD_LEAVES = 20` + `CACHE_TAIL_LEAVES = 8` (*"mp4 moov probes — what makes opens instant"*), oldest evicted in `CACHE_EVICT_BYTES = 100 MiB` waves, `CACHE_MAX_AGE_MS = 14 d` backstop. A promoted stream materializes out of the cache into `destFor()` at completion (`engine.js` `onFileComplete`).

**Serve side**: permission gate `publicKeyIsAllowedToRead(sender, space)` on `treeReq`, `chunkReq`, `thumbReq`, `hashCheck`; lazy single-pass range read (only the requested ≤ few MB, hashed just for those leaves); `CancelRegistry` checked before and between writes; `awaitDrain` after a false `write()`; per-peer ordered bulk lane with hot-job insertion; debug log suppression at one line per (kind, peer, file) per minute.

### 5.6 Comparison hooks for the new drive service

| New pearcore | PearDrive equivalent | Gap |
|---|---|---|
| `drives.get(space)` → `SpaceDriveBrowser{path:'/'}`; `.files({recursive})`, `.folders({recursive})`, `.cd()`, `.local()` (`browsers.js`) | `engine.listing(topic)`, `dirView(topic, dir)`, `#buildListing`, folder map, revision ring | `browsers.js:82–135` scans **every** path in the space on every `files()`/`folders()` call → O(files) per navigation. PearDrive caches by catalog revision and patches by changed key. Also: no sizes, no mtimes, no availability, no offline state, no dedupe, no local arrangement, no pending-ingest overlay. |
| `SpaceFileEntry.variants`, `.getProvidersForVariant(rootHash)`, `.download(rootHash, destination)` (`entries.js`) | `catalog.files()` view (`providers`, `onlineProviders`, `have`, `own`, `altNames`, `size`, `mtime`, `hidden`, `deletedByAll`) + `swarm.download({topic, spaceFilePath, rootHash, dest, cacheDest, priority})` | providers come from the in-memory list → offline providers invisible; `download()` has no tier, no queue, no cancel, no range read, no resume we control |
| `LocalFileEntry` + `ProgressTracker` (`onIndexing`, `onComplete`, `onError`, `indexingProgress`) | `_ingestCurrent` + ingest job counters + `_settlePending` | **Adoptable** — real per-file indexing progress would replace PearDrive's polling |
| `SpaceDownloadTask` + `LeafDeliveryScheduler` + `SequentialWriter` + `partial_download_record` (`managers/files/*`) | `SpaceSwarmManager` / `SpaceSwarmTask` / `PartialFileStore` / `PriorityGate` / `wire.js` | New task: **sequential** writer (`stage()` refuses `leafIndex < nextExpectedLeaf`) so no random-access seek/stream; `stop()` leaves the record and map entry (no cancel); per-task `heartbeat` interval; no priority tiers, no per-peer inflight budget, no backoff/park, no bench decay, no cancel-at-source, no `failed-verify` parking. Its temp path is `<root>/<username>/drive/<topic>/<rootHash>/<filename>` — a *different* partial convention from `<dest>.swarm.part`. `SpaceFileManager.handleIncomingStream` uses a **12-byte binary key + UInt32BE leafIndex** frame layout, incompatible with PearDrive's `[len][reqId]` framing — and PearDrive overwrites that handler. |
| `spaceFileList.query(topic, filter)` (new) | `#seedCatalog` iterating `spaceFileList.get(topic)` (`engine.js:2555`), `/api/debug` (`server.js:197`) | **Adoptable**, cheap |

---

## 6. Old API → new API

| Old pearcore API (as PearDrive uses it) | Nearest new equivalent | Notes |
|---|---|---|
| `createCore({rootPath, bootstrap})` → `{emitter, managers, space, messages, profile, accounts}` | `createCore({rootPath, bootstrap, user})` → `{emitter, managers, space, drives, messages, profile, accounts, getPublicKey}` | adds `drives` + `getPublicKey()`; signature compatible |
| `EVENTS.*` (`events.constants.js`) | identical file, **byte-for-byte** (`diff` clean) | zero work: `Handshake`, `Connection`, `Disconnect`, `ProfileUpdate`, `SpaceFileEvent(+Options.ADD/REMOVE)`, `SpaceSync`, `SpaceHashList`, `SpaceMessage`, `General`, `Reject` all survive |
| `core.managers.storage` (StorageManager) | **NONE — deleted** | the single biggest break: 29 sites. All replaced by free functions taking `db`: `queryFileRegistryRecords(db, filters)` (`utils/files.utils.js:298`), `getFileRegistryRecord(db, id)` (**221**), `querySpace(db, f)`, `updateSpaceForPublicKey(db, …)` / `core.space.update(space, params)`. `listFileRecords()` has **no** replacement → use `queryFileRegistryRecords(db, {})` (which, as a bonus, *keeps row ids* — removing the quirk at `engine.js:3541`). PearDrive already has `get db()` at `engine.js:1387`; add adapters in `src/lib/pearcore.js`. |
| `core.managers.storage.updateSpace(payload, secretKey)` | `core.space.update(space, params)` (new, `space.service.js:193`) or `updateSpaceForPublicKey(db, …)` | `space.update` also re-joins and broadcasts; PearDrive's `#rewriteSpace` needs its own secret mint/shed and a *targeted* push, so keep PearDrive's sequencing over the free function |
| `core.managers.spaceFiles.localFileRegistry.add({spaceId, spacePath, spaceFilename, fileSourcePath, tree?, metaHash?})` | `LocalFileRegistry.add(params)` (`files/components/registry.js:261`) | **behaviour change**: the new `add` swallows errors internally and reports via `params.onError`, so the `/already exists/` catch at 8 sites stops working and the return can be `undefined`. **And it drops `tree`/`metaHash`** → re-carry patch §Q2 or the hash-once quarantine dies. New extras: `onIndexingStart(tracker)`, `onCompletion`, `onError` |
| `localFileRegistry.delete({registryId})` | unchanged (`registry.js:358`) | do **not** switch to `spaceFiles.removeLocalFile(id)` — it passes a bare id into a function that destructures `{registryId}` (`files.manager.js:436`); still broken at `35dfca1` |
| `localFileRegistry.onChangeEvent(path)` / `.onDeleteEvent(path)` | unchanged (`registry.js:412, 459`) | handlers are now `.bind(this)`-ed at `registry.js:244–245` (the unbound-`this` bug reported in `drive-migration-map.md §7.2` is **fixed** at `35dfca1`) |
| `localFileRegistry.watcher` (`.add`/`.unwatch`) | unchanged | cosmetic once §W makes it inert |
| `spaceFiles.fileEventBroadcaster.flush()` | `FileEventBroadcaster.flush()` (`files/components/events.js:68`) | unchanged |
| `fileEventBroadcaster.peerFilter = fn` (PearDrive-added) | **NONE** | re-target patch §K to `events.js:116–124` |
| `core.managers.spaceFileList.get(topic)` | unchanged, **plus** `query(topic, filter)` (`files.manager.js:99`) | shape unchanged: `{path: {rootHash: {peers: {pk: {timestamp}}}}}` |
| `core.managers.session.*` (`getDatabase`, `getCredentials`, `setMessageConfig`, `setBootstrapperEndpoint`) | unchanged (`session.manager.js:75, 88, 95, 124`); **new** `getAccount()` | — |
| `core.managers.sockets.peers` (Map pk → `{socket, topics}`) | unchanged (`sockets.manager.js:15, 50`) | 22 sites across 6 modules — free |
| `core.managers.mux.routingMap.set(type, handler)` / `.send(socket, data, frameType)` | unchanged names (`multiplexer.manager.js:82, 95, 289`) | but the mux was **rewritten**: per-socket state, `readQueue` serialization (patch §4 now redundant), per-type `frameSizeLimit` with a `_penalty(socket)` that **destroys the socket** on violation. PearDrive's `0x03` frames and 2 MiB STREAM ranges must be checked against those limits. `cleanup(socket, info)` signature changed. Re-run `test/route-race2.test.mjs` before dropping §4. |
| `core.managers.connection.{join, leave, update, connectWith, swarmInstance, discoveryMap}` | unchanged (`connection.manager.js:108–150`) | still awaits `discovery.flushed()` → keep patch §J. `#primedDial`'s `swarm._handlePeer` is Hyperswarm-internal, unaffected |
| `core.managers.message.sendMessageToSocket(msg, socket)` | unchanged | — |
| `core.space.{list, create, join, leave, getCurrentState}` | all present (`space.service.js:161, 236, 265, 288, 315`) | `SpaceInstance` (getters) moved from `services/interface.js` into `space.service.js`; PearDrive never does `instanceof` and never spreads a space, so no change. `permissionRead/Broadcast` are now booleans (were `1/0`) — audit the 12 read sites |
| `core.messages.send(space, payload)` | unchanged (`message.service.js:103`) | pass the SpaceInstance, as today |
| `core.profile.{getCurrentProfile, update, list}` | unchanged (`profile.service.js`) | — |
| `core.accounts.{create, authenticate, logout}` | unchanged (`accounts.service.js:38, 95, 135`) | usernames are no longer lower-cased upstream — check the stored `'device'` casing for existing installs. `logout()` now stops the file managers before closing the DB |
| `utils/crypto.utils.js`: `hash`, `hex`, `randomNonce`, `signJSON`, `verifySignedJSON` | all present (`crypto.utils.js:80, 38, 119, 222, 252`) | pure `@noble` again → keep patch §V (28× verify speed-up) |
| `utils/files.utils.js`: `getFileMetaHashFromSource`, `deleteFileRecord`, `getFileTreeLeafs`, `createWatcher`, `WatchTypes` | all present (`92, 421, 434, 63, 53`) | `getFileMetaHashFromSource` now opens read-only (patch §O retired); `createWatcher` still chokidar (keep §W) |
| `utils/system.utils.js`: `createFileStream`, `getFileSize` | present (`39, 83`) | `readFile` now returns a FileHandle; `createFileStreamFromHandler` and `pathJoin` are gone → PearDrive uses none of them |
| `utils/merkleTree.utils.js`: `generateMerkleTree` | present (`44`), now takes an `onLeaf` callback | file is still `merkleTree.utils.js` while 5 modules import `merkletree.utils.js` → **keep patch §1** |
| `utils/space.utils.js`: `getSpaceToTopicMap`, `getTopicToSpaceMap` | present (`638, 655`) | — |
| `utils/protocol.utils.js`: `verifySpaceFileRecordSignature`, `createSpaceSyncMessage` | present (`696, 406`) | — |
| `utils/policy.utils.js`: `publicKeyIsAllowedToRead` | present (`21`) | — |
| `database/schemas/file.schema.js`: `fileRegistry`, `fileIndex` | **identical file** (`diff` clean), `downloadRecord` also unchanged | PearDrive's drizzle writes and raw SQL keep working. Still **no index** on `file_path` / `root_hash` / `space_id` → keep PearDrive's `pd_file_registry_*` |
| `src/protocol/` | `src/protocols/` (renamed) | patches §D and §R target this folder; nothing in `src/` imports it |
| `services/interface.js` | deleted (`SpaceInstance` in `space.service.js`) | no PearDrive reference |
| `managers/file.manager.js` | split: `managers/files/files.manager.js` + `files/components/{registry,events,download,scheduler,writer,trees,progress,providers}.js` | patches §Q2, §D2, §I, §K, §N must be re-targeted |
| *(nothing)* | `core.drives` → `SpaceDriveService` / `SpaceDriveBrowser` / `SpaceFileEntry` / `LocalFileEntry` | the new surface PearDrive would consume; see §5.6 |
| *(nothing)* | `core.getPublicKey()` | cosmetic replacement for `session.getCredentials().publicKey` (gossip 187/307/837, agent 259) |
| *(nothing)* | `PEARCORE_MIGRATIONS_PATH` env (added at `aa84dd4`) | relevant for the Electron/asar packaging path |

---

## 7. The Agent Mesh, and what rKeyChat / new pearcore now covers

### 7.1 What `src/engine/agent.js` is (491 lines)

A diagnostics mesh with **no wire protocol of its own**: any synced space whose immutable pearcore `spaceName` is exactly `"AgentOps"` becomes the bus (`MESH_HANDLE`, `agent.js:37`, matched at `#mesh()` **105–108**). Mailboxes are ordinary (hidden, sanctioned-machinery) space files:

```
.pearmeta/agents/<host>/status.json       heartbeat
.pearmeta/agents/<host>/inbox/<id>.json   requests TO this machine
.pearmeta/agents/<host>/outbox/<id>.json  replies FROM this machine
```
`<host> = sanitize(os.hostname())-<publicKey[0:8]>` (`agent.js:81–86`) — *"two machines can share a hostname — the lab's twin VMs did."*

- **Transport is pearcore's ordinary file sync** plus the riders/previews policy (`.pearmeta` auto-syncs when `riderPolicy[topic] === 'auto'`, `engine.js:5000–5004`).
- **Publishing** (`#publish`, **183–231**): atomic `.<name>.<pid>.tmp` + rename (*"A mirror that reads a half-written status file hashes garbage and fails verification against our claim (field: status.json verify-fail loops on both machines)"*), then drop **every** stale registry row for that *space path* via `queryFileRegistryRecords({spaceId, spacePath, spaceFilename})` (*"Field, Aug 29: the managed folder moved once; the row at the old location survived a fileSourcePath-only cleanup and the duplicate fed a mesh-wide manifest storm via reconcile"*), then `localFileRegistry.add`, then `catalog.fileAdded`, then `gossip.announceSoon()`.
- **Heartbeat is derived state, not a counter** (**406–432**): the payload is `{host, publicKey, build, spaces: [...topics].sort()}` — no timestamps, no uptime, no log tail. *"Same state → same bytes → same hash → silence."* 10-minute keepalive; a reader marks a status `stale` if older than 2× cadence.
- **Security**: probes are a **fixed read-only menu** — `version`, `census`, `state`, `tail-log`, `thumbs-failed` (**139–178**), all served by GETting PearDrive's own localhost API so the sidecar needs no engine internals. Authentication is **cryptographic**: `signJSON`/`verifySignedJSON` against an admin set `{space.publicKey, this.engine.myKey, ...config.agentAdmins}` (**451–474**). The comment explains why provider attribution was not enough: *"this machine auto-downloads every inbox file and becomes a provider itself — the lab's negative test bypassed a provider check that way."*
- **Two admin doors**: the localhost API (`POST /api/agent/ask`, `GET /api/agent/reply`, `GET /api/agent/mesh` — `server.js:401–406`) and the **ask-drop** (`<dataDir>/agent-asks/*.json` → signed + published; replies mirrored to `agent-replies/`; `agent-mesh.json` snapshot) for an agent that can reach the disk but not the port.
- `_done` ids persisted in `agent-processed.json` so a restart never re-answers.

### 7.2 Overlap with rKeyChat / new pearcore

- **No part of the Agent Mesh exists in new pearcore.** It is pure PearDrive application code over `localFileRegistry.add/delete` + `queryFileRegistryRecords` + `signJSON/verifySignedJSON`. Its migration cost is exactly the `managers.storage` → free-function change (3 sites) and the `add()` error-handling change (1 site).
- Its *dependencies* on PearDrive, however, are real: `engine.ensureManagedFolder`, `engine.catalog.files`, `engine.localPathOf`, `engine.spaceIdOfTopic`, `engine.gossip.announceSoon`. If the catalog or the managed-folder model is replaced by the new drive service, the mesh follows.
- A plausible rebuild on the new surface: `core.drives.get(space).local().addFile(rel, tmpPath)` + `entry.onComplete()` for publishing, and `SpaceDriveBrowser.files({recursive:true})` filtered on the `.pearmeta/agents/` prefix for reading. That loses the offline-provider and local-path resolution the catalog provides today (`#localFile` falls back to a registry query for exactly that reason, `agent.js:91–101`).

### 7.3 Everything else PearDrive built that is now (partly) covered upstream

| PearDrive mechanism | New pearcore coverage | Verdict |
|---|---|---|
| per-peer mux route serialization (patch §4) | `multiplexer.manager.js` `readQueue` | **drop ours** after re-running `route-race2` |
| REMOVE-event handling (patch §R) | `protocols/files.protocol.js:114–132` | **drop ours** |
| permissive `validateFilePath` (patch §C) | `general.utils.js:77` | **drop ours** |
| read-only metadata hash (patch §O) | `system.utils.js:11` | **drop ours** |
| precomputed-tree acceptance (patch §Q1) | `files.utils.js:532` | **drop §Q1, keep §Q2 plumbing** |
| `.js` ESM extension (patch §E) | fixed | **drop ours** |
| indexing progress (`_ingestCurrent`, `_settlePending`) | `ProgressTracker` + `LocalFileEntry.onIndexing/onComplete/onError` | **adopt** — a genuine improvement |
| folder/file navigation (`#buildListing`, `dirView`) | `SpaceDriveBrowser.files()/folders()/cd()` | **keep ours** — the new browser is O(space) per call and carries no metadata/availability |
| per-file download (`swarm.download`) | `SpaceFileEntry.download()` + `SpaceDownloadTask` | **keep ours** — sequential writer, no cancel/priority/range/resume-we-control; adopt only when it grows them |
| filtered file-list reads | `spaceFileList.query(topic, filter)` | **adopt** at `engine.js:2555` and `server.js:197` |
| `session.getCredentials().publicKey` | `core.getPublicKey()` | **adopt** (cosmetic, 4 sites) |
| persistent index, offline providers, tombstones, owner purges, size/mtime, device roster | **none** | **keep** — `SpaceFileListManager` is still in-memory and per-session |
| one native recursive watcher, probation/`lsof` settle gate, `.pearignore`, prepare→commit quarantine, unreadable ledger | **none** (and upstream's own watcher is chokidar-per-file) | **keep + keep patch §W** |
| registry indexes, `#retireRow`, relocate-by-row-rewrite, `#treeOfRow`, `#forceLeave` | **none** | **keep** |
| LAN beacon, primed dial, introductions (`cards`/`whoIs`), roster/backoff dialer, address book | **none** | **keep** |
| thumbs/riders, spaceindex, policies, `netIngest` batching queue, catalog sync (`catState/catSig/catReq/catSnap/catDelta`) | **none** | **keep** |
| `_askedTopics` / `#refuseUnaskedRecord` | **still needed** — `queryShareLink(db, {})` is still unfiltered (`protocols/space.protocol.js:144`) and the new code now deletes **every** pending sharelink on any SpaceSync (**159–161, 175–177**) | **keep, and report upstream** |

### 7.4 New-pearcore bugs to report (verified at `35dfca1`)

1. `SpaceFileManager.removeLocalFile(registryId)` passes a bare id to `LocalFileRegistry.delete({registryId})` → throws; `LocalFileEntry.remove()` is therefore broken (`files.manager.js:436`, `registry.js:358–359`).
2. `LocalFileRegistry.init()` deletes rows whose source file is missing at boot (`registry.js:113–124`) — an unmounted volume = index loss + REMOVE to every peer. (PearDrive's F11 / patch §I.)
3. `LocalFileRegistry.init()` still broadcasts the **whole** registry at boot (`registry.js:267–275`). (Patch §D2.)
4. `LocalFileRegistry.add()` ignores `params.tree`/`params.metaHash` even though `generateFileTreeRecord` accepts them (`registry.js:261–271` vs `files.utils.js:532`) — no hash-once.
5. `SpaceSyncHandler` still replays the entire topic file list on `LOCAL_SPACE_REQUIRE_UPDATE` / `PEER_REQUIRE_UPDATE` / `IDENTICAL` (`protocols/space.protocol.js:200, 218, 233`). (Patch §D — **not** upstreamed, contrary to `drive-migration-map.md §3.4`.)
6. `SpaceSyncHandler` deletes **all** pending sharelinks, not the matching one (`protocols/space.protocol.js:159–161, 175–177`).
7. `connection.join()` still blocks on `discovery.flushed()` (`network.utils.js:157`, `connection.manager.js:112`); `leave()` blocks on `destroy()` (**133**). (Patch §J.)
8. `SpaceFileListManager.remove()` still does `Object.keys(...)` emptiness tests on every removal (`files.manager.js:237–240`). (Patch §N.)
9. No `peerFilter` hook on `FileEventBroadcaster.broadcast()` (`events.js:116–124`). (Patch §K.)
10. `createWatcher` is still chokidar-per-file with `awaitWriteFinish` (`files.utils.js:63–73`). (Patch §W.)
11. Five modules still import `merkletree.utils.js` while the file is `merkleTree.utils.js` — fatal on case-sensitive filesystems (`registry.js:17`, `trees.js:2`, `files.utils.js:10`, `files.protocol.js:8`, `protocol.utils.js:5`). (Patch §1.)
12. No index on `file_registry(file_path)`, `(root_hash)` or `(space_id, space_path, space_filename)` (`database/schemas/file.schema.js:22–40`). (PearDrive creates `pd_file_registry_*` itself.)
13. `pino` transport has no `'error'` listener → an ENOSPC write kills the process (`logger.js:23–89`). (Patch §P.)
14. `sockets.manager.js:73, 79` still log the expected error/close double-cleanup as warnings. (Patch §S.)
15. `registry.stop()` has `for (const [filePath, entry] in this.backoffStates.entries())` — `in` over an iterator, so the loop body never runs and backoff timers are never cleared (`registry.js:396–398`). Same `for…in`-over-array family as the old `storage.deleteFileRecords` bug patch §2 fixed.

**Fixed since `32d5869`:** the unbound `onChangeEvent`/`onDeleteEvent` handlers (`registry.js:244–245` now `.bind(this)`), and `PEARCORE_MIGRATIONS_PATH` is now overridable.

---

## 8. Deltas vs. the existing `docs/drive-migration-map.md`

That doc is accurate and should be the base; three corrections for `35dfca1`:

1. **§3.4 / §4 "§D1–3 upstreamed → delete" is wrong.** All three file-list-replay sites are still there. Keep §D, re-pointed at `src/protocols/space.protocol.js` (anchors should still match; only the folder name changed).
2. **§7.2 (unbound watcher handlers) is fixed** at `35dfca1` — drop it from the Farzam list.
3. **§3.7 "check whether `registry.add` forwards `tree`"** — answer: **it does not**. §Q2 is a mandatory re-target, not an optional one, or the whole prepare→commit quarantine silently doubles every hash.

Also worth adding to its §4 table: `registry.stop()`'s `for…in` bug (item 15 above), and the new mux's `frameSizeLimit` + `_penalty(socket)` as a risk to PearDrive's `0x03` control frames and 2 MiB STREAM ranges.
