# PearDrive on the new pearcore: Phase 1 report

*2026-10-01, Claude. For Kimi's review (security, adversarial, bugs). Follows `peardrive-coupling-map.md` §9, agreed 2026-09-30 20:45, go from Guy 2026-10-01 09:23.*

## What this is

PearDrive runs on the drive-service generation of pearcore (upstream `c8633de` + our fixes). Nothing in PearDrive's model changed: catalog, gossip, swarm manager, agent mesh, thumbnails, policies, watcher are as they were. What changed is the **storage layer under them** (StorageManager is gone upstream) and **where PearDrive's pearcore patches live** (upstream commits instead of an install-time patch script).

| Repo | Branch | Base | Commits |
|---|---|---|---|
| pearcore (`~/Anjou/pearcore-mobile`) | `peardrive-phase1` | `mobile-bare` (= upstream `c8633de` + migrations env, watcher bind, tree spaceId) | 13, listed below |
| PearDrive (`~/Claude/Projects/pearsync`) | `pearcore-drive` | `master` `7b9c718` (build .127) | 1 (`645880f`) |

PearDrive's `package.json` points at `file:../../../Anjou/pearcore-mobile` for development. **Pin a commit before anything ships.**

## 1. Fixed in pearcore (branch `peardrive-phase1`), each its own commit for Farzam

The four §9 must-fix items, then the rest of the still-applying patch set, then two found during the lab run.

| Commit | Was | What |
|---|---|---|
| `2269805` | §1 | `merkletree.utils.js` → `merkleTree.utils.js` in 5 modules (fatal on Linux/Android). `8cbcde9` same in tests. |
| `c60b6bb` | §D | `SpaceSyncHandler` sends a topic's file list to a socket **once per socket per session** (WeakMap on the socket). Was: every direct SpaceSync, including IDENTICAL, replayed the whole list. Empty lists are not sent. Test added (`space.protocol.test.js`). |
| `31e4ff7` | §I, §D2, §Q2, item 15 | `LocalFileRegistry.init()` **keeps rows whose source is missing** (offline, not deleted; nothing announced). Boot **broadcasts only files whose metaHash changed** while down; unchanged lists reach peers through the SpaceSync push. `add()` **forwards `tree`/`metaHash`**; `generateFileTreeRecord` uses a given tree only while the metaHash still matches. `stop()` `for…in` → `for…of` (backoff timers were never cleared). 5 tests added/rewritten. |
| `2fc0e8f` | §J | `connection.join()` stores the discovery at once and lets `discovery.flushed()` finish in the background; `leave()` does not await `destroy()`. |
| `d8f2125` | §K | `FileEventBroadcaster.peerFilter(publicKey)` optional host predicate; a topic with no eligible socket sends nothing. |
| `8a188da` | §N | `SpaceFileListManager.remove()` emptiness test without `Object.keys` copies. |
| `2ac1371` | §P | pino transport gets an `'error'` listener; ENOSPC no longer kills the process. |
| `c4a5b5b` | §W | `files.watchLocalChanges` session config (default `true`). PearDrive sets `false` and drives `onChangeEvent/onDeleteEvent` from its own recursive watcher. |
| `1997f24` | §V | Native Ed25519 via `sodium-native` when importable (0.04 ms/verify vs 1.65 ms), `@noble` fallback. Signatures cross-verify both ways (checked in-session). 90 crypto/protocol tests pass. |
| `35f476e` | **new** | **Mux: a sync frame handler threw `TypeError` (`handler(...).catch` on a non-promise), which escaped `_process()` and dropped every frame after it in the buffer.** Found in the lab on the first boot: PearDrive's `0x03` control handler is sync. Handlers are now awaited inside try/catch and the error message is logged. |
| `c07441b` | | empty list is not "sent"; test rewritten with fresh nonces (the first version was dropped by the nonce dedupe before the handler and passed vacuously). |

Test suite: **no new failures** against baseline (20 pre-existing failures are DHT/network tests that time out in this environment, identical before and after), 396 pass.

## 2. Changed in PearDrive (branch `pearcore-drive`, one commit)

`src/lib/pearcore.js` — the single import hub, now also the adapter:
- `attachStorage(core)`: puts `{queryFileRegistryRecords, listFileRecords, getFileRegistryRecord, querySpace, updateSpace}` back on `core.managers.storage` over the free functions. 29 call sites untouched. **Behaviour change, intentional:** `listFileRecords()` keeps row ids (the old one stripped them, which is why a 24k-file unshare once deleted nothing).
- `attachThrowingAdd(core)`: wraps `localFileRegistry.add()` so it throws again (new upstream `add()` swallows errors into `onError` and returns `undefined`). PearDrive's LAW A ("already exists is an answer, not a success") depends on the throw at 8 sites. Attached after `authenticate()` (the file managers exist only then).
- `relocateRegistryRows(core, from, to)`: `UPDATE file_registry SET file_path=? WHERE file_path=?` on the sqlite handle. Replaces two drizzle writes; **`drizzle-orm` is no longer imported by PearDrive**.
- `getFileTreeRecord` (upstream) replaces the hand-rolled `#treeOfRow`.
- `fileRegistry`/`fileIndex` table exports removed.

`src/engine/engine.js`: the two adapter calls, `files.watchLocalChanges=false`, three sites rerouted. 37 lines.

`scripts/patch-pearcore.mjs`: detects the generation. Old pearcore → runs `patch-pearcore.legacy.mjs` (the 868-line set, unchanged). New pearcore → **verifies** the nine fixes are present and exits non-zero if not; never writes (the install may be a symlink to a checkout).

## 3. Replace vs keep: the verdict, checked against the code

| PearDrive mechanism | Decision | Why |
|---|---|---|
| StorageManager calls (29) | **adapter** | upstream deleted it; free functions are the same code |
| drizzle writes (2) + `#treeOfRow` | **replaced** | SQL on the handle; upstream reader |
| patch §1 §D §D2 §I §J §K §N §P §Q2 §V §W | **moved upstream** (our branch) | all genuine fixes; none PearDrive-specific once §W is a switch and §K a hook |
| patch §2 §4 §C §E §O §R §Q1 | **dropped** | upstream fixed them (verified in coupling map) |
| patch §L (lab `firewalled:false`), §S (double-cleanup warnings) | **dropped, not carried** | §L is lab-only; §S is cosmetic log noise. Note for Farzam only. |
| catalog, gossip (`cat*` ops), swarm manager + `0x03` lane + STREAM handler, partial store, priority, thumbs, riders, spaceindex, policies, LAN beacon, primed dial, introductions, agent mesh, `.pearmeta`, `_askedTopics` | **keep, unchanged** | no upstream equivalent, or upstream's is in-memory/sequential/unprioritised (coupling map §5.6, §7.3). Not one line changed. |
| `SpaceDriveBrowser` / `SpaceFileEntry.download` / `ProgressTracker` | **not adopted yet** | §5.6 gaps stand. `ProgressTracker` is the one worth adopting next (real per-file indexing progress). |

## 4. Lab run (three PearDrive nodes on this Mac, public DHT, throwaway data dirs)

| Step | Result |
|---|---|
| Boot A on new pearcore | clean, first try |
| A creates space, shares folder (3 files: 3 MB random, md, txt) | registered after the 60 s probation; `file_registry` 3 rows; hash-once path exercised |
| B joins by sharelink | FIRST_ENCOUNTER sync; sees 3 files, A as provider |
| B policy → auto | all 3 downloaded over PearDrive's lanes on the new mux; `big.bin` **md5-identical** |
| **A restarts with the shared folder moved away** (§I) | **3 rows survive**; B still lists A as provider; folder returned, rows intact, no REMOVE |
| A and B restart with nothing changed | 3 files each side, **zero** mux warnings (there were 2+4 before `35f476e`) |
| C joins; **A killed**; C → auto | C fetches all 3 **from B**; md5-identical |

Not seen: any `Reject`, any `handler failed`, any FK or sqlite error.

## 5. Not verified (say so)

1. **§D2/§D on the wire.** Proven by unit tests, not by packet counts between PearDrive nodes. PearDrive has no pearcore event counter; rKeyChat's `/api/debug` tally would do it, or `PEARDRIVE_DEBUG=1`. Worth a Kimi run on Mini ↔ Mac after a sleep/wake.
2. **Big registries.** Lab was 3 files. The 25k-row Mac registry and the 150k-file scale pass have not been re-run on this branch.
3. **Electron app.** Only `node src/index.js` (engine + web UI) was run. `electron .` and `electron-builder` packaging (asar off, `PEARCORE_MIGRATIONS_PATH`) untested.
4. **Linux.** Case fix is by inspection + import check on macOS.
5. **PearDrive's `watchStates` showed `live` while the folder was unmounted** in step 5. `#checkVolumes` should have flipped it to offline. Pre-existing PearDrive behaviour or timing of the 10 s sweep; not pearcore. Open.
6. `peardrive.json` migration (`coreVersion`) was not needed: schema files are byte-identical, same `core-v2` dir. An existing install should open as is. **Not tried on Guy's real data dir.** Do not point this branch at `~/.peardrive` until Kimi has read §6.

## 6. For Kimi: where to push

- **Once-per-socket file list (`c60b6bb`, `c07441b`).** An empty list is not counted as sent (a peer that syncs before our first registration gets the list on a later sync; test proves the pre-fix handler replays and the fixed one doesn't). After that one push a peer stays current only through SpaceFileEvents, which §K's `peerFilter` can suppress. Today PearDrive's filter excludes only `gossip.deltaPeers` (peers that spoke `cat*`), so a plain pearcore peer such as rKeyChat still gets events, but **this is the seam**: a PearDrive node that mis-classifies a peer as a delta peer would starve it. Also note: receivers drop repeated nonces, so a sender re-using a content-derived nonce was already limited to one delivery per receiver session; PearDrive deliberately sends fresh nonces (engine.js ~1643), which is the storm case this fixes.
- **Non-blocking join (`2fc0e8f`).** `space.create()` now returns before the DHT announce lands. Anything that assumed "created ⇒ discoverable" (tests, rKeyChat login) should be re-read. The lab's join-by-sharelink still worked because the connected peer hands over the record; cold DHT-only discovery wasn't timed.
- **Native Ed25519 (`1997f24`).** Same primitives, but a mixed network (one side native, one noble) is now real. Cross-verification checked in-session for one vector; a fuzz over sizes (32/64-byte secret, hex vs bytes publicKey) is the test to add.
- **Offline rows (`31e4ff7`).** A row kept for a missing file is still *served* if asked? No: `spaceFileListManager.add(record)` is skipped for missing sources, so we never advertise it; but `queryFileRegistryRecords({rootHash})` on the serve path still returns the row. PearDrive's own serve path stats the file; pearcore's `files.protocol` tree/chunk handlers may try to open it and fail. Check what the requester sees (a reject, a hang?).
- **`attachThrowingAdd`.** It converts `onError` into a throw and *also* calls the caller's `onError`. If a future PearDrive site passes `onError` and expects no throw, it gets both. Grep before adding one.
- **Mux (`35f476e`).** With the loop no longer aborting, a *malicious* frame that makes a handler throw repeatedly now costs one warning per frame instead of a dropped buffer. Rate of `logger.warn` under attack: there's no throttle on that log line.
- Items from the coupling map §7.4 **not** fixed here, still open upstream: #1 `removeLocalFile` bare id, #6 SpaceSync deletes *all* pending sharelinks (PearDrive's `_askedTopics` still defends), #12 no registry indexes (PearDrive creates `pd_file_registry_*`), #14 §S warnings, and the new `frameSizeLimit` is fine for PearDrive (one 256 KiB leaf per STREAM frame, limit 1.5× that).

## 7. How to run it

```
cd ~/Claude/Projects/pearsync          # branch pearcore-drive
PEARDRIVE_DATA=/tmp/pd-a PORT=3091 node src/index.js
PEARDRIVE_DATA=/tmp/pd-b PORT=3092 node src/index.js
curl -X POST localhost:3091/api/space/create -H 'content-type: application/json' -d '{"name":"lab","saveDir":"/tmp/save-a"}'
curl -X POST localhost:3091/api/folders/add -H 'content-type: application/json' -d '{"path":"/tmp/share","topic":"<topicHash>"}'
curl -X POST localhost:3092/api/space/join -H 'content-type: application/json' -d '{"sharelink":"<link>","saveDir":"/tmp/save-b"}'
curl -X POST localhost:3092/api/policy -H 'content-type: application/json' -d '{"topic":"<topicHash>","mode":"auto"}'
```
New files wait 60 s (probation) before they register. `node scripts/patch-pearcore.mjs` tells you whether the installed pearcore carries the fixes.

## 8. Next

1. Kimi's pass on §6; a Mini ↔ Mac run with real registries and a sleep/wake.
2. Pin pearcore to a commit; offer the 12 commits upstream as a PR series (they're independent).
3. Adopt `ProgressTracker` for ingest progress (§5.6, the one clear win).
4. Then Phase 2 of `peardrive-space-directories.md`: the local index and space-directory records, which is where the StorageManager adapter becomes the seam for the new model.
