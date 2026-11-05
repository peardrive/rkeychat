# Pear Threads: signed conversations attachable to anything

*Draft, 2026-09-29. It comes out of rKeyChat. Its second consumer is PearDrive: comments and reactions on files and folders (`feed-posts-plan.md`: "Comments/reactions … design with the Nostr interop Q&A"). By the Pear UI rule, that second consumer is what justifies extracting it now.*

## The idea

A **thread** is a set of signed records that hang off a **subject**. The subject can be anything with a stable id:

| Subject | id | Example |
|---|---|---|
| a chat room | `room:<topic>` | rKeyChat "lab" |
| a file (exact version) | `blob:<sha256>` | comments on one cut of a video |
| a file path in a space | `path:<spaceTopic>/<path>` | the "notes.md" thread across versions |
| a folder | `path:<spaceTopic>/<dir>/` | discussion on a whole folder |
| a post | `rec:<id>` | reactions on a feed post |

A chat room is just a thread whose subject is the room. PearDrive comments are threads whose subject is a file. **The protocol, storage, reactions and UI are the same code.**

## Records (what rKeyChat already ships, generalized)

Every record is signed by its author's rKey key, and verified against the space's rKey chain, so it's trusted when relayed or replayed from history.

- **comment** `{ kind: 'msg', id, subject, ts, text, mentions, re, att?, via? }`
  - `re`: what it replies to.
  - `att`: content-addressed attachments (voice memos, files).
- **reaction** `{ kind: 'react', id, subject, ts, target, emoji, on }`: toggled; the last toggle per author/emoji wins.
- **redact** `{ kind: 'redact', id, subject, ts, target, hashes, reason }`: admin-only moderation. Blanks the target and blocks its hashes in this subject. Moderation history is just more signed records: auditable, replicated, no side channel.
- **activity** `{ kind: 'activity', ... }`: agent side channel, shown to people and never fed to agents. Chat-specific; optional elsewhere.

**Rule:** strip `undefined` fields before signing or sending. pearcore's `canonicalStringify` emits invalid JSON for them, and the whole message is silently dropped (see HANDOFF §3).

## Nostr mapping (so mirroring later is mechanical)

The shapes are chosen to map 1:1 onto Nostr events:

| Pear Threads | Nostr |
|---|---|
| comment on an external subject (file/folder) | **NIP-22 kind 1111**, with the subject as an external-content id (**NIP-73** `I`/`K` tags, e.g. a blob hash) |
| comment in a room | kind 1111 rooted at the room id, or kind 9 / NIP-29 group chat if we go that way |
| reaction | **NIP-25 kind 7**, `content` = emoji, `e`/`k`/`i` tags for the target |
| attachment | NIP-94 / NIP-92 `imeta` with the sha256 |
| author | the rKey-bound key. A Nostr mirror signs with the account's bip340 key, or a key it delegates to |

rKey's own signature (domain-separated) stays the source of truth. A Nostr mirror is a re-encoding, not a second authority.

## What gets extracted

1. **`threads.js`** (no framework, no pearcore dependency):
   - make, verify and aggregate records;
   - `reactions(records)`, `replies(records, id)`, rounds/turn logic for agent threads.
   - Transport-agnostic: rKeyChat gossips records over room messages; PearDrive can carry them in its existing gossip, or as `.pearmeta/social` files.
2. **Pear UI elements** (CSS tokens + template functions, Pearcast look), as `pear-ui.css` / `pear-ui.js`, living in the Pearkit library repo (`github.com/peardrive/pearkit`):
   - message bubble (mine right, others left, continuation grouping);
   - **reaction row** on the bubble's bottom edge: [add-emoji on hover, sticky once used] [chips] [reply, always shown];
   - emoji picker; who-reacted popover (right-click or long-press);
   - verified lock with expandable technical details;
   - detail/thinking overlay (dimmed backdrop, copyable);
   - composer with live dictation mic and voice-memo recorder; inline memo player.
3. **Voice** (optional module): local STT via sherpa-onnx/Parakeet, dictation glossary with learn-from-edits.

## PearDrive use

- A file's detail pane shows its thread: comments and reactions, with the same reaction row.
- Tiles show a small reaction or comment count.
- Reacting to a file in the feed = a `react` record whose target is the file post, or whose subject is the file itself.
- History and backup: records are small signed JSON. PearDrive syncs them like any other space data (sealed daily segments, as in rKeyChat's archive plan), so a file's discussion travels with it.

## Sequencing

1. Extract `threads.js` and the Pear UI pieces inside rKeyChat first (rKeyChat keeps working on them).
2. PearDrive consumes them for file comments and reactions.
3. Lift to a shared package once both are live.
