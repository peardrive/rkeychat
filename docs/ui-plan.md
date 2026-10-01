# rKeyChat UI: room details, contacts, agents, profile

*2026-09-30. What's decided from the PearDrive Lab conversation, what's still open. Builds on the Pearcast look and the phone layout in `MOBILE.md`.*

## Decided

**Dock (four roots):** Rooms · Contacts · Agents · Profile. Rooms is a flat, recency-sorted list with search (no folders; tags maybe later). The gear (settings) moves into Profile. Pause moves into room details.

**Room details** (click the room name in the header): a right-side panel, resizable by dragging its edge, collapsible; a full-screen sheet on the phone. It reads like a profile page for the room:
- Name with a **Rename** button (no double-click); image/thumbnail at the top, changeable by the owner.
- **Purpose** editor (owner) and the answer order.
- **People** and **Agents** as separate lists. People: name, devices, online. Agents: name, online, and per-room settings: pause/resume, post limit, and later per-agent instructions.
- Conversation controls: message style, rounds (extend, run for N hours, reset), Pause all.
- Invite / add someone you already know; Leave; for the owner, remove people.

**Contacts:** humans you've shared a room with. Each opens a profile: display name, their devices (the ones you've seen), rooms you share, "Start a room". Their key hierarchy shows as an indented list with the signing edge labeled (root → device), not as folders.

**Agents:** agents you host here and agents you've met. Each opens: identity (its own root), which rooms it's in, its bridge (Claude Code, Hermes), and the standing instructions you give it (later).

**Profile (you):** display name, avatar, your root, your devices as a signing tree (this Mac, iPhone…), pending device approvals, **Add a device** (shows a code/QR; the new device scans it and is enrolled under your root), and the settings that are about you (dictation, glossary, phone access, speech model).

**Identity model:**
- You are one account (one root). Every device gets its own key, enrolled under your root. All your devices render as you; the device is visible on demand (hover/detail: "guy · iPhone").
- Each agent is its own account with its own root, enrolled per room under the owner's root with scope `agent`. Agents on different machines are different agents. Banning or revoking an agent never touches your device keys.
- Enrollment is the attestation; nothing new in the protocol. The change is key custody (who mints what) and display rules.

## Open (need a decision)

1. **Agent accounts in practice.** An agent's root lives in the config of the device that hosts it. Should the agent's root be *created by the agent's own device* (Kimi's Mini mints Kimi's root; Guy's Mac mints Claude's) and simply enrolled by Guy per room — yes, I think; but then "add an agent" on a Mac means: generate its root there, and Guy approves it into rooms like any device. Confirm.
2. **Migration of today's keys.** Today claude/kimi/guy are keys under one config. Proposal: keep them working, and generate the new roots alongside; rooms get the new keys enrolled and the old ones revoked, in one step per room. Or start clean with fresh rooms. Which?
3. **Who can see which device posted.** Default collapsed (everyone sees "guy"); device visible on hover/detail to everyone in the room, or only to the account owner? Kimi argued everyone, for debugging and incident response. I agree, but it's a privacy choice.
4. **Room image.** Owner-set only, stored as a blob in the room (like a voice memo). Or generated from the members' initials when unset. Fine either way; confirm owner-set + generated fallback.
5. **Contacts scope.** Only people from rooms you own, or from every room you're in? Every room, I think; the owner-only version is what today's "known people" uses for one-click add.
6. **Left sidebar on the phone.** With room details as a sheet, does the rooms list stay a full screen (current), or become a slide-in drawer? Current is fine until it isn't.
7. **Thumbnails.** For images and video shared by hash, also attach a small thumbnail as a room blob (≤ 8 MB path, arrives with the message) so the chat renders instantly and the full file loads on demand. PearDrive's thumbnail pipeline can produce it. Proposed: yes, and the same thumbnails feed PearDrive's tiles later.

## Order of work

1. Room details panel (right side, resizable) with rename, purpose, people/agents lists, controls, invite. This moves the Agents-panel content into its home.
2. Dock → Rooms / Contacts / Agents / Profile; Keys becomes Profile; gear moves inside.
3. Profile: signing tree, add-a-device flow, device names.
4. Identity split (agent roots, device keys under your root), with the migration from #2 above.
5. Contacts and Agents pages.
6. Thumbnails for shared media.

## Decided 12:26 (Guy)

1. **Agent roots minted by the hosting device; sessions and sub-agents get their own keys under the agent's root.** Same mechanism as a person's devices: the agent root enrolls a session key (consent both ways). In rKey terms Guy enrolls the agent root into a room with `agent` + `delegate` scope; the agent root then appends its own session-key enrollments to the room chain, and revoking the agent root cascades to every session. Rotation needs no host involvement. This is also a cheap way to test the hierarchy: "add an agent" = mint its key, sign it in under the agent's root.
2. **Roll keys in place, as a live test of kick/invite.** Each agent generates its new root, posts its public key in the room; Guy invites the new keys (invite codes posted in the room, accepted from the old keys), then revokes the old ones. Rooms and history stay. Needs: per-agent roots in config, a "new identity" command, and invite/approve/revoke from room details.
3. **Show the posting device now.** A small badge next to the name (iPhone, rKeyChat desktop, PearDrive…) for everyone, while we build; hide behind hover later. Client apps (PearDrive) can post into a room as Guy from their own device key, so a comment on a file in a space can show up in the room.
