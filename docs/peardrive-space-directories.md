# PearDrive: space directories, decoupled from disk

*2026-09-30. Guy's proposal from the lab room, with edge cases and an implementation plan. Companion to `HANDOFF-peardrive-pearcore.md` and `pear-threads.md`.*

## The model in one paragraph

A **space** is its own root: opening it shows its files, with no folder of the same name inside. Inside a space, **space directories** are a hierarchy that lives *in the space* (signed records, synced to every member) and has nothing to do with folders on disk. A file in a space directory is a **link to content by hash** (name, size, hash), never a path. Each device keeps a private **local index**: hash → where that content is on this disk. **Connections** are the only bridge between the two worlds: "watch this disk folder (or these files) and link what appears into that space directory". Many-to-many: one folder can feed several space directories in several spaces; one space directory can collect from several folders. One copy on disk, any number of links. Copies across the *network* are wanted (resilience); copies across *one disk* are the user's business, made in Finder, never by PearDrive.

This fixes the problems seen so far: the redundant folder inside every space, "same folder name on two machines" collisions (disk names no longer matter), and the 20 GB dedupe that made the second space directory look empty (a link is cheap; the content is stored once).

## Edge cases and the call on each

1. **Same file, different names in two places.** The name belongs to the link, not the content. Renaming in one space directory doesn't touch the other. Fine by design.
2. **Same file twice in one space directory** (two people add it, or two watched folders contain it). Merge: one entry, note "also from …". Never two rows with the same hash in one directory.
3. **File changes on disk** (new hash at a watched path). A link has **versions**: the entry advances to the new hash and keeps the old one in its history, so anyone who still holds the old content can serve it. Manually linked files (no watcher) don't change on their own; the UI offers "update to the new version".
4. **Deleting** is three different things and must look different: *remove from space directory* (never touches disk), *delete on disk* (Finder's job), *disconnect a watcher*. When a file disappears from a watched folder, the link stays by default; the space is the archive, the folder is just an inbox. Per connection: **collect** (additions only, the default) or **mirror** (removals propagate too, for people who want a true two-way folder).
5. **Subfolders inside a watched folder.** Per connection: **flatten** (genre folders vanish, everything lands in the target) or **keep the subtree** (subfolders become nested space directories). Ask at connect time with a preview of what will appear.
6. **Name clashes inside one space directory** (two watched folders each have `notes.md`, different content). Both exist (different hashes). Show both, disambiguated by source; the user can rename either link.
7. **Moved or renamed files on disk (self-healing).** The local index stores hash, size, inode, volume id and a cheap fingerprint (size + hash of first and last 64 KB). macOS FSEvents and Linux inotify report renames with inodes, so most moves resolve instantly with no scan. When that fails, PearDrive scans watched folders and known volumes for the fingerprint, then confirms with the full hash. Only after that does a link go **missing on this device**. A missing file isn't a broken space: other members may still have it.
8. **Volume offline** (external drive unplugged) is **offline**, not missing. Don't rescan, don't warn, wait for the volume.
9. **Nobody online has the content.** The link stays, shown as **unavailable**, with who last had it. This is the honest state of a P2P drive and should be visible, not hidden.
10. **Overlapping watchers** (folder A and A/B both watched, into different places). Both links are made; the watcher dedupes events by hash so nothing is hashed twice.
11. **Files still being written** (a download in progress, a render). Hash only when the size has been stable for a few seconds; otherwise link with a "pending" mark.
12. **Private paths never leave the device.** Space records carry name, size, hash, versions, who and when. Never a local path, volume or user name.
13. **Who may edit the hierarchy.** Space directory records are signed. Permissions per space (owner, admin, contributor, reader) map straight onto rKey scopes. Concurrent edits: last-writer-wins per entry, deletions as tombstones, all in the same signed log as everything else.
14. **The same person on two devices.** The local index is per device. The same content may sit on both; both serve it. No conflict, since links are by hash.
15. **Conversations stay in their space.** A comment or reaction is attached to (space, hash), which is exactly the Pear Threads subject. The same movie in a public space and in the private space with your brother has two separate threads. Copying a thread across spaces is an explicit act, never automatic.
16. **Existing spaces migrate cheaply.** Each becomes a root space directory with one **mirror + keep-subtree** connection to its old folder. Behavior is unchanged until the user changes it.
17. **Finder and file-manager badges.** On macOS, a Finder Sync extension can overlay a small badge on watched folders and linked files (connected, watching, unavailable); it needs the app bundle signed, which Electron supports. On Linux, Nautilus emblems via a small extension. Nice, but separate from the core model; sequence last.

## Implementation plan (slots into Kimi's phases)

**A. Records in the space (pearcore, small).** A `dir-entry` record: `{ id, parent, name, kind: 'dir' | 'file', hash?, size?, versions: [{hash, size, ts}], by, ts, sig }`, plus tombstones. Gossiped and replayed like every other space record. The space itself is the root; nothing is auto-created.

**B. Local index (PearDrive, SQLite).** Tables: `content(hash, size, fingerprint)`, `locations(hash, device, volume, inode, path, state: present | offline | missing)`, `connections(id, localPath, filter, spaceId, dirId, mode: collect | mirror, layout: flatten | subtree)`, `links(entryId → hash)`.

**C. Watcher and locator services.** Watcher: filesystem events → stable-size check → hash → upsert links, honoring mode and layout. Locator: inode and fingerprint search for moved files, volume online/offline tracking.

**D. Transfer stays as is.** Content is fetched by hash from whoever has it. Nothing here changes pearcore's file transfer; it only changes what the hierarchy is and where it lives.

**E. UI.** Sidebar space opens as its root. "New space directory" like New Folder. "Connect…" on a directory: pick folders or files, choose collect/mirror and flatten/subtree, see a preview. Badges on entries: watching, linked, pending, unavailable, offline. Drag a file from Finder onto a directory or into the feed = link it.

**F. CLI (`pd`, from Kimi's phase 2).** `pd connect <folder> <space>/<dir> [--mirror] [--flatten]`, `pd links <file>` (every place a hash appears), `pd locate <hash>`, `pd tree <space>`, `pd doctor` checks index vs disk.

**G. Threads.** Comments and reactions keyed by (space, hash) via Pear Threads. Already the plan; this model makes the scoping explicit.

**H. Badges in Finder and Nautilus.** Last.

Order: A and B together (they define everything), then C, then E and F in parallel, then G, then H. Phase 0 of the migration report (the coupling map) should be done first regardless, because it tells us which existing PearDrive state becomes the local index.

## Decisions from Guy (2026-09-30, 10:41)

- **Names are labels on hashes, decided per space by the owner.** Import sets the initial name. People with edit rights *propose* alternatives ("Johnny proposes: Matrix (1999).mp4"); the owner adopts one as canonical; everyone may adopt any alternative locally for their own copy. So a 10,000-member movie space can have 10,000 local naming schemes and one canonical index. Replaces edge cases 1, 6 and 13 above: no last-writer-wins on names; rename records are proposals until the owner adopts them.
- **Moves between watched folders are silent.** No record, no network traffic, no notification. It's just how the tool works.
- **Disconnects are normal, not errors.** Guy will routinely upload to the Linux box and delete locally. When files stop being visible on disk: a calm notification ("25 files no longer on this Mac, all still available in the space") with details on click: reconnect, locate, or ignore. On the network a locally missing file is simply *unavailable from this device*; if others hold it, nothing changes for anyone.
- **Watch folders: files at the top level always; ask about subfolders** ("watch inside folders recursively, or just this folder?"). `.pearignore` already handles exclusions; use it, don't invent another mechanism.
- **Non-destructive, like a nonlinear editor.** PearDrive never touches disk unless explicitly told. Three distinct actions with escalating confirmation: *remove from space* (stops sharing in that space, disk untouched), *delete locally* (disk only; the space still lists it, now unavailable from here), *delete from everywhere* (asks about the space and about the disk, separately, BitTorrent-style).
- **Versions are not PearDrive's job.** A different hash is a different file. Version history is a policy layer built on top: a collaborative space type keeps canonical files plus a hidden history folder; PearDrive just sees files and backs them up. Drop the per-entry `versions` list from the record. Kimi's retention concern moves to that layer.
- **Threads:** comments and reactions keyed by (space, hash). One's own interface may show all threads on a hash across spaces one is in; nobody else sees across spaces.
- **Study before building.** Read pearcore (including Farzam's new drive service) and PearDrive closely for what already exists; extend rather than rebuild; follow Farzam's naming and structure so this lands in tandem with pearcore, not as a parallel hierarchy.

## Agreed with Kimi (10:43)

- **Serve rule (hard protocol rule, not policy):** a device serves hash H to a peer only through a space where a valid signed link record for H exists and the peer is a member. Global hash knowledge is never authorization. This closes the hash-oracle, presence-correlation, probing and malicious-claim cases in Kimi's threat model. Per-space counters only (no cross-space "has comments" aggregates).
- **Files in chat:** apply the space's download policy before rendering. Small media renders inline; big content shows a card and fetches on tap.
- **Turn order (rKeyChat):** claim-based soft order. The lead agent has a short window to post a hidden claim marker; silence passes the floor down the room's list. No single point of silence.
