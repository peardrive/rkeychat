# rKey in rKeyChat: audit of signing, logging in and revoking (2026-11-15)

*Claude, for Guy, on his request in the room. Checked against the code as it runs today: rKey 66862ba
(`SPEC.md`, `src/{canon,keys,ops,chain,state}.js`, 450 lines) and rKeyChat master 8a8f09d
(`src/room.js`, `src/login.js`, `src/proto.js`, `src/config.js`). Every finding names the line it was read at.
Kimi-mini's `rkey-security-audit.md` (shared in the room the same day) is read alongside; §5 says where it holds
and where the current code already answers it. The five October design notes in `docs/` are not repeated, only
pointed at.*

## 1. What the system is today

**One room = one pearcore space + one rKey chain.** The chain's root is the room owner's account root. Every
key that may read, carry or post in the room is enrolled under that root (`room.js:1-6`).

**Three kinds of key, two layers of trust.**

| key | scope | what it is |
|---|---|---|
| `device:<name>` | `bind host` | a machine's pearcore key. Being `host` = being on the space's read/broadcast whitelist (`#syncWhitelist`, room.js:479) |
| person on this device | `bind chat admin` (+`delegate` if it is an account root) | a human; `admin` may post controls, redactions, invites |
| agent | `bind chat agent` (+`delegate` for its account root) | an AI participant; its account root enrolls its own per-device session keys |

Transport trust is pearcore's whitelist, derived from the `host` keys. Author trust is per record:
`#admits` (room.js:349) verifies the record's own signature, that it is for this room, `trustedAt(author, ts)`
against the chain, and the scope the kind needs. Both layers are recomputed from the chain, never stored.

**Signing.** Every op, entry, consent, message and control is `sign(sha256("rkey/v0/<domain>\n" + canonical JSON))`
(`canon.js`). Domains are distinct, so nothing signed for one purpose verifies as another. Pure-JS `@noble`.

**Logging in / inviting** (`login.js`). The invitation is a bare pearcore sharelink to a throwaway space named
`rkeychat-invite:` or `rkeychat-login:`. The joiner proves it holds the link's nonce (`signProof`, 59), the host
answers with root, host name and room name (`handover-hello`, 286), the joiner sends a signed join request
(consents for its device and participants, `joinRequest`, room.js:1041), and **the host must say yes**
(`approve: 'ask'`, 69; the asking device is shown as its name and key prefix, 300). Only then does `approve()`
append enrolls. A login enrolls the device into every room the host owns; a room invite into that room only. The
space is used once (283), expires in an hour (27), and is left afterwards.

**Revoking.** The owner appends `revoke` ops (`removed` | `compromised` | `banned`, room.js:572); any key can
revoke itself as a pending op that verifiers honour before the owner folds it (`leave`, 612; `view(pending)`,
chain.js:101). `removed` keeps its past signatures and can come back after a 1 h cooldown with a consent anchored
to the revocation; `compromised` loses everything from `since` (default: all); `banned` stays out until the root
unbans. Status is computed by walking ancestors (`isActive`, state.js:27), so cutting a key cuts its branch.

**Keys at rest.** `~/.rkeychat/config.json`, plaintext, mode 0600 (`config.js:2,22`): the account root (bip340),
every participant's session key, and `previous` keys kept so old signatures stay readable. The root key lives on
the daemon machine and signs online. Project agents' keys are in the project's `.rkeychat/` (config.js:51).

## 2. Scaling and history: where old keys and old signatures pile up

Measured today on this Mac; the October numbers (`expiry-and-the-expired-key.md` §7) still hold.

| | now |
|---|---|
| rKeyChat Lab chain | 26 entries (17 enroll, 8 revoke), 28.7 KB |
| the other two rooms | 14 and 15 entries, 16-18 KB |
| per entry | ~1.1 KB, ~3 ms to fold (3 Ed25519 verifies) |
| per inbound record | 1 verify + an ancestor walk; constant |

**What grows the chain.** Only authority changes: an enroll per key per room, a revoke per cut. Nothing periodic
touches it (no heartbeat, no refresh), which is the right side of the three-orders-of-magnitude line in §7
(0.46 MB vs 1.2 GB over ten years). Today's growth is driven by *key re-minting*: every time a participant's key
is re-minted (`remint`, config.js:106) the old key becomes `previous`, is revoked in each room, and the new one is
enrolled, so one person-device over a year of occasional re-mints costs a handful of KB per room. 8 of the Lab's
26 entries are revokes from exactly this.

**What never shrinks.** `fold()` replays from genesis at every start (chain.js:35), and every peer holds the
whole chain and re-sends it on every `hello` (room.js:129: the full `entries` array, every 60 s anti-entropy and
on every connection). At 26 entries that is 29 KB per hello per peer; at the §7 ten-year figure (421 entries) it
is ~460 KB per hello per peer per minute. **This, not the fold, is the first thing that will hurt**: the chain is
gossiped whole on a timer. Fix: send `{ head, seq }` in hello and the entries only on request for what the other
side lacks (the history sync already works that way for messages, `hist-req`, 130).

**Old signatures.** Messages from a `removed` key stay verifiable forever (`trustedAt`, state.js:68), which is
what we want: history does not vanish when someone leaves. `compromised` wipes the key's whole history out of
every peer's feed (`#admits` fails on `hist-res` too) unless `since` is set. There is no UI to set `since`, so
in practice "compromised" means "every word this key ever said disappears for everyone". Decide whether that is
the intended default before anyone uses it on a person.

**Revoked-key pile.** Structural and bounded: one `revoke` per key ever cut, kept forever. The October answer
(`keys-links-and-the-later-root.md` §1) stands: expiry, not smarter revocation, is what keeps routine departures
off the chain. Expiry is still not in the schema (`expiry-harness.test.js` F1-F4 are `skip`).

## 3. Red team: attacks against the code as it is

Severity is for this room, today. **H** = someone in the room could do it now. **M** = needs a compromised key
or device first. **L** = theory, or needs the root.

### H1. Any enrolled device can be made the owner's admin device by asking for the owner's name
`approve()` room.js:510-512: `ownDevice = p.role === 'human' && this.local[name]?.role === 'human'`. When a join
request lists a participant named like the owner (`guy`) with role `human`, the name-in-use check is skipped
(528: `!ownDevice && … taken.has(name)` is false) and the key is enrolled under the root with `admin` scope,
labelled `guy@<device>`. The host side shows only the asking device's name and key prefix (`asked`, login.js:300),
not the names and roles the request contains. A second door in the same function: `rolling` (500) is true for any
device already active in the room, and it switches the name-in-use check off for *every* name, so an enrolled
device can ask for `silversurfer` or any other taken name with role `human` and get admin under it. So: Guy hands any invite to anyone, the recipient's daemon (or a
patched one) puts `{ name: 'guy', role: 'human' }` in its request, Guy sees "silversurfer-laptop wants into
rKeyChat Lab", approves, and the stranger is `guy` with admin: posts as Guy, pauses agents, redacts, invites.
**Fix:** `ownDevice` must require the requesting *account* to be the root (`p.account?.ref === root`, which the
owner's own phone can prove with a consent signed by the root), and the ask prompt must list every name and
role in the request so a human can see what they are approving. Test: a request naming the owner from a
non-root account throws `name already in use`.

### H2. Any account root in the room can write to the chain and fork it
rKeyChat gives every account root `delegate` (room.js:521) so it can enroll its own session keys. rKey's writer
rule is "root or any active key with `delegate`" (`checkEntry`, chain.js:30), so every member account is a
chain *writer*: it can append entries, and a longer valid chain is adopted by every peer, including the owner
(`merge`, chain.js:108; `#onChain`, room.js:429). A member cannot forge ops (each op needs its own authorised
signature), but it can (a) append its own enrolls without the owner, see H3, and (b) **equivocate**: sign two
different entries at the same seq to two halves of the room. Peers then disagree, `merge` returns `fork`, the UI
shows one toast (index.html:2231) and nothing is resolved; the owner's next append lands on whichever branch it
holds. That is a lasting split of the room by any member. **Fix:** rKeyChat should not hand `delegate` to
members. Let an account enroll its session keys by sending the signed enroll *op* (it already does:
`a.enroll`, room.js:523) and let only the root write entries. rKey can keep its general writer rule; the app
decides who gets `delegate`.

### H3. A member account can enroll unlimited posting keys without the owner
Consequence of H2 plus `#onPending` (room.js:445): any `op` message whose op applies to the current view is
queued, and the owner folds every pending op blindly (`#foldPending`, 462). An account with `delegate` and `chat`
can enroll any key under itself with scope `bind chat agent` and it posts at once. Kimi-mini's "rate limit
enrollment" is this, but the real fix is narrower: the owner should fold without asking only **self-revokes**
and **an account's enroll of one session key per device it is present on**; anything else waits for the ask
prompt. Also cap `pending.json` (today unbounded, written to disk per op).

### M1. Backdated messages from a removed key
`#admits` trusts `rec.ts` (room.js:352). A key revoked as `removed` keeps `trustedAt` true for any `ts` before
the revocation, and ts is whatever the signer wrote. So a removed member's device can keep posting with
yesterday's timestamps and every peer admits them into history (`hist-res` relays them on). They appear in the
past of the feed, so nobody is woken, but they are there and attributed. **Fix:** record arrival time next to
the claimed time and refuse records whose claimed ts is older than the author's revocation *when they arrive
after it*; peers that already had the record are unaffected. Kimi-mini's "poor man's clock" is the same idea.

### M2. Self-asserted ts also drives the cooldown and gaps
`#enroll` compares `op.ts` with `revoked.ts + 1 h` (state.js:122). For enrolls the owner signs, ts is the owner's
clock. For a `delegate` account enrolling under itself (H2), ts is its own, so the cooldown and the gap
bookkeeping for its subtree are its own word. Falls away with the H2 fix.

### M3. The host's root is online, and it cannot be rotated
The room root signs from the daemon's `config.json`. A compromised MacBook is a compromised root, and rKey v0 has
no root rotation or successor (`SPEC.md` "Not in v0"; `#revoke` refuses the root, state.js:139). Recovery is a
new room with a new root and re-enrolling everyone. The October note (`keys-links-and-the-later-root.md` §2) has
the shape of the fix (a cold root above the warm one, enrolled later with both consents). Until then this is
the single point everything hangs on; it should at least be a separate key file, not in the same JSON as the
session keys, and the desktop app should say so on screen.

### M4. Login link on a fresh device adopts the host's name
`#becomeIfLogin` (login.js:237) names the device after whatever the host's `hello` says, before the request is
sent. Guarded when the device already has a person and rooms (244). On a brand-new device a malicious *login*
link makes it "guy" under the attacker's root. Low impact (it only affects the victim's own device) but the
join screen should show "log in as **guy** on **Guy's account** (root 7f3a…)" and wait for a tap. Same screen
answers Kimi-mini's 3.2 on the joiner side; the host side already has its prompt.

### L1. Gossip amplification by a member
`hello` from every peer carries the whole chain and a `hist-req`; `blob` messages are stored by anyone on the
whitelist up to 8 MB each (room.js:410, hash-checked, `putBlob`). A member can fill disks with correctly hashed
junk blobs and make the room chatty. Bound blobs per author per day; make hello carry `{ head, seq }` (see §2).

### L2. A pearcore host device is trusted for presence and files
`presence` is accepted from any `host` key (room.js:422), `blob-req` is served to any host. A device that is
still `host` after its people left reads everything until `pruneDevices` runs (room.js:580), which is owner-only
and heuristic (matches by label and presence). Fine today; it is the thing to revisit when a device can hold
several people's accounts.

### Things that hold up
- Invitation replay and interception: the nonce proof is bound to the topic (login.js:58), the space is used
  once and the host approves by hand. A photographed QR still needs Guy to tap yes for the photographer's
  device, and the device's key prefix is on screen. The old `rkr1.` bearer code Kimi-mini describes is gone
  since 6d18aac; `rkc1.` remains only as the room-invite payload the host sends after approval (invite.js).
- Consent: nobody can be enrolled without their key's own signature over `{root, key}` (state.js:106), so a
  pasted public key cannot be bound to a stranger's account. Re-enrollment needs a consent over the revoke
  signature, so an old consent cannot be replayed.
- Domain separation and canonical JSON: an rKey op is never a valid Nostr event or message, and `undefined`
  fields cannot change what was signed (proto.js:21).
- Tampering: `fold` stops at the first bad entry and `merge` adopts only a strictly longer valid prefix
  (chain.js:120); covered by tests ("tampering breaks the chain", "merge: advance, behind, fork").
- Scope checks per record: an agent cannot post controls or redact (`#admits` needs `admin`, room.js:353).

## 4. Blue team: what to build, in order

1. **H1 fix** (room.js, one condition + the ask prompt listing names and roles). Half a day, with a test.
2. **Take `delegate` away from members** (H2, H3, M2 fall together). Accounts enroll session keys by op; the
   owner's auto-fold accepts only self-revokes and one-session-key-per-present-device enrolls. One day.
3. **Chain gossip by head** (§2, L1): `hello` carries `{ head, seq }`, entries on request. One day.
4. **Arrival time** beside `ts` on stored records; refuse backdated records from revoked authors on arrival
   (M1). Also what every later clock story (witnesses, anchoring) builds on. One day.
5. **Joiner-side confirmation screen** (M4, Kimi 3.2): who, which account, which room, tap to continue.
6. **Root in its own file, with a plain warning**; then the cold-root-above design from October (M3). Rotation
   itself is an rKey change and the biggest item here.
7. **Expiry** on enrolls (`exp`), so routine departures lapse instead of being revoked; the harness tests
   F1-F4 are written and skipped, waiting for the schema. This is the October plan and still the right one;
   it is below 1-5 because nothing today refreshes on-chain, so the chain is not actually growing from it.

## 5. Where Kimi-mini's audit stands against the code

Right, and already in §3: self-asserted timestamps (M1, M2), expiry designed-not-built (§4.7), joiner has no
confirmation before consenting (M4), a compromised delegating key can spam enrolls (H3, worse than stated: no
compromise needed, any member account is a delegating key).

Overtaken by the code: "bearer `rkr1` tokens usable by anyone" describes the flow before 6d18aac; today the link
needs a nonce proof and a human yes on the host, and the host sees the device key. "No visual confirmation" is
true on the joiner side only. "Rate limit enrollment" is a symptom; the cause is `delegate` on every account.

Not covered there, found here: H1 (owner impersonation through the name check), H2 (any member is a chain
writer and can fork), full-chain gossip on a timer (§2), `compromised` erasing history for everyone by default.

Its "verified against the rKey source" is fair for rKey; none of its findings were checked against rKeyChat's
`room.js`/`login.js`, which is where H1-H3 live.
