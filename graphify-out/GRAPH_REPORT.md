# Graph Report - .  (2026-10-02)

## Corpus Check
- 33 files · ~89,809 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 451 nodes · 915 edges · 17 communities (13 shown, 4 thin omitted)
- Extraction: 97% EXTRACTED · 3% INFERRED · 0% AMBIGUOUS · INFERRED: 26 edges (avg confidence: 0.84)
- Token cost: 0 input · 0 output

## Community Hubs (Navigation)
- [[_COMMUNITY_Community 0|Community 0]]
- [[_COMMUNITY_Community 1|Community 1]]
- [[_COMMUNITY_Community 2|Community 2]]
- [[_COMMUNITY_Community 3|Community 3]]
- [[_COMMUNITY_Community 4|Community 4]]
- [[_COMMUNITY_Community 5|Community 5]]
- [[_COMMUNITY_Community 6|Community 6]]
- [[_COMMUNITY_Community 7|Community 7]]
- [[_COMMUNITY_Community 8|Community 8]]
- [[_COMMUNITY_Community 9|Community 9]]
- [[_COMMUNITY_Community 10|Community 10]]
- [[_COMMUNITY_Community 11|Community 11]]
- [[_COMMUNITY_Community 12|Community 12]]
- [[_COMMUNITY_Community 13|Community 13]]
- [[_COMMUNITY_Community 14|Community 14]]
- [[_COMMUNITY_Community 15|Community 15]]
- [[_COMMUNITY_Community 16|Community 16]]

## God Nodes (most connected - your core abstractions)
1. `Room` - 68 edges
2. `RoomStore` - 21 edges
3. `dataDir()` - 19 edges
4. `decode()` - 17 edges
5. `App` - 14 edges
6. `AgentRunner` - 12 edges
7. `saveConfig()` - 12 edges
8. `Login` - 11 edges
9. `runEuclideanAlgorithm()` - 11 edges
10. `transcribe()` - 9 edges

## Surprising Connections (you probably didn't know these)
- `Agent Mesh (src/engine/agent.js, AgentOps space)` --semantically_similar_to--> `rkeychat Daemon`  [INFERRED] [semantically similar]
  docs/peardrive-coupling-map.md → PLAN.md
- `trace()` --indirect_call--> `dataDir()`  [INFERRED]
  bin/claude-mirror-hook.mjs → src/config.js
- `Durable lane (hash-chained archive)` --rationale_for--> `Growing files are pathological for PearDrive`  [INFERRED]
  PLAN.md → docs/HANDOFF-peardrive-pearcore.md
- `Share by hash across spaces, one content store per device` --semantically_similar_to--> `Dedupe by hash (content-identity view, reclaim, cross-space reconnect)`  [INFERRED] [semantically similar]
  docs/HANDOFF-peardrive-pearcore.md → docs/peardrive-coupling-map.md
- `Phone layout (chat owns the screen, sheets for panels)` --implements--> `renderPanel / PAGES table / openPage`  [INFERRED]
  docs/MOBILE.md → src/ui/index.html

## Import Cycles
- None detected.

## Hyperedges (group relationships)
- **rKeyChat two-lane architecture: live messages, sealed archive, rKey membership** — plan_live_lane, plan_durable_lane, plan_participant, plan_archivist, plan_hist_req_backfill [EXTRACTED 1.00]
- **Pear Threads: rKeyChat records and UI extracted for PearDrive file comments** — docs_pear_threads_thread, docs_pear_threads_threads_js, docs_pear_threads_pear_ui_elements, src_ui_index_reactions_ui, docs_peardrive_space_directories_space_directory_model [EXTRACTED 1.00]
- **PearDrive onto new pearcore: coupling map → patch set upstreamed → adapter → lab run** — docs_peardrive_coupling_map_patch_pearcore_script, docs_peardrive_coupling_map_storage_manager_removed, docs_peardrive_coupling_map_phase1_plan, docs_peardrive_migration_report_peardrive_phase1_branch, docs_peardrive_migration_report_storage_adapter, docs_peardrive_migration_report_lab_run [EXTRACTED 1.00]

## Communities (17 total, 4 thin omitted)

### Community 0 - "Community 0"
Cohesion: 0.06
Nodes (7): verifyBody(), verifyRecord(), deviceOf(), edRef(), mimeOf(), nameOf(), Room

### Community 1 - "Community 1"
Cohesion: 0.07
Nodes (38): binarize(), BitMatrix(), BitStream(), buildFunctionPatternMask(), computeDimension(), countBlackWhiteRun(), countBlackWhiteRunTowardsPoint(), decode() (+30 more)

### Community 2 - "Community 2"
Cohesion: 0.10
Nodes (30): api(), base(), cfgOrDie(), cmd, die(), fmt(), hhmm(), nextStep() (+22 more)

### Community 3 - "Community 3"
Cohesion: 0.07
Nodes (42): pearcore bug: canonicalStringify emits invalid JSON for undefined, Per-file / per-folder access: separate transport from access (Cryptree-style keys), Moderation as a signed redact record, rKey identity layer, Share by hash across spaces, one content store per device, Phone as a paired browser on the tailnet, Phone layout (chat owns the screen, sheets for panels), Nostr mapping (NIP-22, NIP-25, NIP-73, NIP-94) (+34 more)

### Community 4 - "Community 4"
Cohesion: 0.09
Nodes (35): COMMON, escape(), learn(), loadGlossary(), loadSettings(), path(), saveGlossary(), saveSettings() (+27 more)

### Community 5 - "Community 5"
Cohesion: 0.10
Nodes (24): b64(), decodeLogin(), encodeLogin(), Login, unb64(), clean(), cleanAgentRules(), envelope() (+16 more)

### Community 6 - "Community 6"
Cohesion: 0.07
Nodes (36): App spaces (.pearmeta/app.json), Bare port of pearcore (rKeyChat-mobile/bare), pearcore gap: file lists don't reach late peers, Growing files are pathological for PearDrive, Subject (room:, blob:, path:, rec: ids), Pear Thread (signed records hanging off a subject), Agent Mesh (src/engine/agent.js, AgentOps space), PearDrive Catalog (persistent twin of spaceFileList) (+28 more)

### Community 7 - "Community 7"
Cohesion: 0.17
Nodes (21): applyGlossary(), rolling(), sherpaLive(), decodeFile(), installModel(), load(), modelPath(), MODELS (+13 more)

### Community 9 - "Community 9"
Cohesion: 0.10
Nodes (19): bin, rkeychat, dependencies, hyperdht, @noble/hashes, pearcore, qrcode, rkey (+11 more)

### Community 10 - "Community 10"
Cohesion: 0.21
Nodes (4): AgentRunner, fmtTime(), renderTurn(), replyDepth()

### Community 11 - "Community 11"
Cohesion: 0.32
Nodes (5): answeredInRoomNow(), cfg, finalReply(), tail(), trace()

### Community 12 - "Community 12"
Cohesion: 0.47
Nodes (3): describe(), file(), short()

### Community 13 - "Community 13"
Cohesion: 0.53
Nodes (6): pearcore is the foundation, PearDrive one client, Port PearDrive's transfer lane into pearcore as the engine, PearDrive 0x03 control lane + STREAM data plane, PartialFileStore (sparse .swarm.part + bitfield), Priority tiers (INTERACTIVE / SELECTED / BACKGROUND) and viewer epochs, PearDrive transfer fallback to pearcore native protocol

## Knowledge Gaps
- **46 isolated node(s):** `cfg`, `{ values: opt, positionals: pos }`, `cmd`, `name`, `version` (+41 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **4 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `Room` connect `Community 0` to `Community 2`, `Community 5`?**
  _High betweenness centrality (0.144) - this node is a cross-community bridge._
- **Why does `RoomStore` connect `Community 8` to `Community 2`?**
  _High betweenness centrality (0.049) - this node is a cross-community bridge._
- **Why does `dataDir()` connect `Community 2` to `Community 11`, `Community 4`, `Community 7`?**
  _High betweenness centrality (0.045) - this node is a cross-community bridge._
- **What connects `cfg`, `{ values: opt, positionals: pos }`, `cmd` to the rest of the system?**
  _51 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Community 0` be split into smaller, more focused modules?**
  _Cohesion score 0.0593607305936073 - nodes in this community are weakly interconnected._
- **Should `Community 1` be split into smaller, more focused modules?**
  _Cohesion score 0.074034902168165 - nodes in this community are weakly interconnected._
- **Should `Community 2` be split into smaller, more focused modules?**
  _Cohesion score 0.09948979591836735 - nodes in this community are weakly interconnected._