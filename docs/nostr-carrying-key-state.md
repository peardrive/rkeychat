# Carrying key state on Nostr, and what it costs relays

*2026-10-06. Claude, answering Guy: can the checkpoint ride along on Nostr — in a profile or a retrievable blob —
and what does that cost relays?*

**Short answer: yes, and Nostr gives us two things for free that we'd otherwise have to build — replaceable
events, which make revocation cost a relay nothing, and the event signature itself, which is already the
checkpoint's signature. The cost to a relay is one row per account, constant in time.**

**But it does not solve the feed problem**, and we should be clear about which problem it does solve. See §4.

---

## 1. The shape

Nostr's **replaceable events** (kinds 10000–19999) are the whole trick: a relay keeps exactly **one** event per
`(pubkey, kind)` and deletes the previous one when a newer `created_at` arrives. That is a checkpoint, natively.

Two levels, matching the cold/warm split exactly:

```
kind 10050, signed by the ROOT pubkey          — published ~quarterly
  seq, issued_at, expires_at
  warm signers: [ {pubkey, scope, not_before, not_after}, … ]

kind 10050, signed by each WARM pubkey         — published on the warm cadence
  seq, issued_at, expires_at
  device / session / agent keys, and the spaces they're good for
```

The root's checkpoint names the warm signers; each warm signer's checkpoint names what it has authorized. A
verifier walks two fetches, both cached, both replaceable.

**The event signature is the checkpoint signature.** Nostr requires every event to be BIP-340-signed by its
`pubkey`, which is exactly the "master signature" the outside proposal wanted us to add. We'd be carrying a signed
blob inside a signed envelope otherwise. rKey already has the `bip340` suite for precisely this surface.

**Revocation becomes publication.** To cut a key off you publish a new checkpoint without it. The relay deletes
the old one. There is no revocation *record* anywhere, ever — which is the thing Guy was hoping for, and it falls
out of replaceable semantics rather than from anything clever.

Worth checking before relying on it: NIP-40's `expiration` tag, which relays *may* honour by dropping the event
when it lapses. If supported it makes a stale checkpoint self-clean; if not, `expires_at` in the content still
bounds what a verifier will accept. Treat relay support as optional.

## 2. Not in the profile

The obvious move is to stuff this into kind 0 (profile metadata). Don't: kind 0 is fetched constantly, by every
client, for every avatar and display name. Putting a 2 KB key-state blob in it taxes every profile render in the
network for something almost no one is checking.

Its own replaceable kind is fetched only by software that cares, costs the same one row, and can be queried
independently of the profile. A pointer in kind 0 (a `k` field naming the kind) is fine as discovery.

## 3. What it costs a relay

- **Storage: one event per account per kind, forever.** Not per revocation, not per device, not per year. The
  content is the *active* set — ten to twenty keys at ~100 bytes each, so **2–4 KB** per account including
  envelope. Large for a Nostr event but unremarkable; kind 3 contact lists routinely run to tens of KB.
- **A relay with a million users carrying all of them: ~3 GB.** Flat in time. For comparison, the naive
  alternative — one event per revocation — grows forever and is what relays would actually object to.
- **Indexing: nothing new.** Relays already index `(pubkey, kind, created_at)`. The query is
  `{"authors":[…],"kinds":[10050]}`, which is the cheapest filter shape there is.
- **Write load:** one event per account per warm cadence (weekly-ish) and one per quarter from the root. Noise.

**Cost to a verifier, which matters more:** zero per event in the common case. A client checks the event signature
as it already does; it consults the checkpoint only when it meets a key it doesn't recognise, then caches by
pubkey. That is the decisive difference from NIP-26, which demanded a delegation resolve on *every* delegated
event and died of it.

## 4. What this does not fix

**On Nostr your identity is a pubkey.** Relays index it, clients display it, follows point at it. A checkpoint
cannot make three device keys appear as one person to a client that hasn't opted in — those are three npubs, shown
as three strangers. This is the same wall the FROST thread hit
(`rotation-delegation-and-frost.md`): for the public feed, the answer is one unchanging pubkey, held so that it
can sign from more than one place without being copied.

So be precise about which problem the checkpoint solves here:

| | |
|---|---|
| **Does not solve** | making your device keys post as you on a public feed |
| **Does solve** | letting anyone who finds your npub learn, verifiably, which keys are yours — and then verify things that happen *off* Nostr |

That second one is genuinely valuable and it's the right use. A stranger finds your npub, fetches one event, and
now holds a signed statement of your device keys, your agent keys, and the spaces they're good for. They can
verify your PearDrive identity, join a room, check a file's provenance — all without Nostr being involved in the
verification at all. **Nostr becomes the discovery layer for a system it doesn't have to understand.** That's a
much better fit than asking it to adjudicate delegation per event.

## 5. The honest weakness: freshness gets worse, not better

Everything in §1 supplies *authenticity* and *status*. Nostr makes *freshness* and *latestness* harder than they
are for us today:

- A relay can serve an old checkpoint. Nothing in the old one mentions the new one.
- A client typically asks a handful of relays. A colluding or merely stale subset can hold a first-time verifier
  on an old state indefinitely.
- `created_at` is self-asserted, like all our timestamps — same open problem as everywhere else.

Mitigations, none of them cryptographic:

1. Query several relays and take the **highest `seq`**, not the newest `created_at` (which the author chooses).
2. Persist the highest `seq` ever seen per account, and **refuse to go backwards**. Rollback protection against
   states you've already seen is cheap and real; proving latestness to a *first-time* verifier is not possible.
3. Keep `expires_at` short enough that the stale window is a stated number rather than "however long".
4. Two checkpoints at the same `seq` with different contents is **equivocation** — provable, worth keeping and
   gossiping. `chain.js` already treats a fork this way.

## 6. Adoption, stated plainly

Nothing obliges a relay to carry kind 10050, and nothing obliges a client to look. So:

- a client that opts in gets verifiable key state for one cached fetch per unknown author
- a client that doesn't sees exactly what it sees today, and nothing breaks

That's the right failure mode, and it's why this is worth doing where NIP-26 wasn't: **it is additive, it costs
nothing per event, and it degrades to the status quo** instead of making every verification more expensive for
everyone.

## 7. What I'd build

1. Pick a kind from the replaceable range and write it down as a one-page spec, so it isn't ours-only by accident.
2. Emit it from the same folded state the local checkpoint uses — one serializer, two transports.
3. Fetch-and-cache by pubkey, with the multi-relay highest-`seq` rule and the persisted floor.
4. Keep the chain as the authority for history, exactly as before. This is bootstrap and discovery, not the log.
