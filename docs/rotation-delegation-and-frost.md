# Delegation, revocation, and the FROST argument

*2026-10-03. Claude, for Guy. A response to a post arguing that append-only key-state tracking can't work in
practice and that FROST (threshold Schnorr producing one unchanging signature) is the right answer instead.*

Short version: **he's right about Nostr and wrong about the general claim.** The "roundtrip per event" cost he
describes is not what delegation costs — it's what *uncached, unproven* delegation costs, and every deployed PKI
solved that decades ago. But his conclusion is still the right one *for Nostr specifically*, for reasons that are
about relays, not about hierarchy. And FROST and rKey aren't competitors: FROST is how you should **hold a root**,
rKey is how you **delegate and scope** authority to things that must act alone. We already have "a FROST root" in
`SPEC.md` under *Not in v0*.

---

## 1. What the post gets right

- **"From the other party's perspective, delegated signing is key rotation."** True, and worth taking seriously.
  A verifier who holds nothing sees an unknown pubkey either way. Our answer isn't that it's different — it's that
  our verifiers don't hold nothing.
- **Nostr can't be made to care.** Correct, and this is the load-bearing point. A relay is a dumb store with no
  obligation to index, resolve or enforce anything, and a stranger's client has no membership set to sync from and
  no incentive to add a resolution step. NIP-26 (delegated event signing) is the evidence: specified, almost no
  client support, and marked deprecated. *(From memory — I'm offline for this, worth a check before you cite it.)*
- **FROST's same-signature property is a genuine engineering win.** One stable pubkey, no network-visible rotation
  event, nothing for anyone else to resolve. On a network with no shared state, that is the only thing that works.
- **The oracle framing is honest.** "You want the whole world to overwhelmingly accept that your identity changed"
  is unsolvable without consensus. We should never claim otherwise.

## 2. The conflation: hierarchy is not rotation when the verifier holds state

Rotation says *"the key that is me has changed."* Delegation says *"this key speaks for me, within these limits,
and I can cut it off."* They look identical only to a verifier with no state. rKey's verifiers have state:

- In a room, identity is the **root**, and the chain *is* the identity. Members already hold it — synced once, on
  join, then incrementally.
- `trustedAt(author, ts)` (`rKey/src/state.js`) is a **local, in-memory tree walk** up the ancestor chain. No
  network. It answers "would a signature this key made at `ts` be trusted" — which is the question that actually
  matters for an append-only log of signed records, and which a bare pubkey cannot answer at all.
- Revocation is **monotone**: trust is only ever removed, never restored by a message you haven't seen yet
  (re-adoption needs a fresh consent anchored to the revocation it undoes, so it can't be replayed). That's what
  makes caching safe.

So the per-event cost is zero. The per-*key* cost is one resolution, cached. That distinction is the whole
argument, and it's the one the post skips.

**This is the shape of every PKI in production.** TLS verifies a certificate chain once per connection, not once
per byte, and handles revocation with stapled OCSP and short lifetimes. Even AtProto — his own example — doesn't
resolve a DID per event; it resolves per repo and caches. The "roundtrip with each and every event verification"
is not a property of delegation, it's a property of an implementation nobody would build.

## 3. Where the ordering burden is real — and how big it actually is

He says append-only tracking imposes "a strict ordering burden on Nostr verification." Half right. rKey's chain
*is* strictly ordered — `{seq, prev}` hash-linked, verification stops at the first bad entry, and `merge()` only
adopts a chain that strictly extends ours (`rKey/src/chain.js`). But:

- The order is **per account**, not global. One linear log, written by the root or a `delegate` steward. Any single
  party can serve it; anyone can verify it alone. **No quorum, no consensus, no global sequencing** — which is the
  burden he's actually describing, and we don't have it.
- A fork (two valid entries at the same `seq`) is **proof that a writer key equivocated**. We surface it and never
  resolve it automatically. That's a feature: equivocation becomes evidence rather than ambiguity.
- `chain.view(pending)` lets a verifier honour a self-revocation *the moment it sees the op*, before the steward
  folds it in. A compromised device can be cut off without waiting for the log.

**The honest costs we do pay** (he didn't find these, but they're the real ones):

1. **Staleness.** A verifier holding an old chain will accept a signature from a key revoked since. Bounded by sync
   frequency, not eliminated. Same limit as CRLs.
2. **A withholding writer.** The steward can't forge, but it can stall — delaying an enrolment or a revocation.
3. **Fork resolution is out-of-band** in v0, i.e. it lands on a human.

## 4. What FROST costs, which the post undersells

| | rKey chain | FROST |
|---|---|---|
| Sign while alone/offline | yes | **no** — needs a live quorum per signature |
| Scoped authority (`chat` ≠ `admin`) | yes | **no** — one key, one capability set |
| Attribution (*which* device signed) | yes | **no**, by construction |
| Containment after compromise | revoke the branch | re-share the whole quorum |
| Compromise is auditable by others | yes (signed revocation) | **no** — a dropped shard leaves no record |
| Verifier needs prior state | yes | no |
| Network must agree on anything | no | no |

Specifics:

- **Interactivity kills the use case the hierarchy exists for.** `@claude` on this Mac and `@kimi-zorin` on the
  Linux box must sign *alone*, continuously, with your phone in your pocket. A 2-of-3 where the server signs every
  time means the server is in the loop for every message — and an attacker holding that shard plus one other has
  your identity outright.
- **"You can't revoke it but you can drop it"** glosses over resharing. Dropping a shard means a refresh/new DKG,
  which needs the honest holders online — exactly the burden he concedes. Until then the old shard still counts
  toward the old quorum.
- **Same signature means no attribution and no containment.** That's the flip side of the property he's selling.
  You cannot prove which device signed, cannot say "that was my agent, not me," and cannot narrow blast radius to a
  scope. For your actual setup — agents acting under your name, on your behalf, with different privileges — this is
  the disqualifying property, not an inconvenience.
- **Silent compromise.** A revocation is a signed, auditable fact others can check. A dropped shard is invisible to
  everyone but you.

FROST also doesn't *solve* the oracle problem — it **avoids** it, by never changing the identity. Real win, real
limitation: you can never repudiate, partition, or expire anything.

## 5. Nostr: concede, and route around it

Two options, and only one is honest:

1. **Stable BIP-340 pubkey on Nostr, FROST-held.** Relays and strangers see one key that never changes. Our
   `bip340` suite already exists in the spec for exactly this surface.
2. **Carry the proof in the event.** Instead of making verifiers *fetch* the chain, attach the delegation prefix
   needed to verify this one event. Self-contained, zero roundtrips, relays need understand nothing; cost is event
   size, which for low-volume signed records is fine. This directly answers his objection — but it only gets you
   the cooperating subset of clients, because nothing can make a stranger's client check.

So: **don't try to teach relays about hierarchy.** Keep the chain where there's a membership set that syncs it
(rooms, pearcore spaces, Marmot groups) and publish to Nostr under one unchanging key.

## 6. They compose — and that's the design

```
  FROST 2-of-3 root  (phone + Satochip card + cold shard)   ← how the root is HELD
          │  signs enroll / revoke ops
          ├── device key (Mac)        scope: admin, chat
          ├── device key (phone)      scope: admin, chat
          ├── agent root @claude      scope: agent, chat, delegate
          │     └── session key       scope: chat          ← rotates freely, revocable
          └── agent root @kimi-zorin  scope: agent, chat, delegate
```

- The root never signs day-to-day traffic and never needs to rotate: lose a shard, refresh, same pubkey, **no
  chain-visible event and no re-enrolment of anything beneath it.** That's FROST doing the job it's good at and
  removing our single worst failure mode (root theft).
- Agent and device keys get revoked in the chain, scoped, attributed and contained. That's rKey doing the job FROST
  structurally cannot.
- This is already the direction: `SPEC.md` *Not in v0* lists "Root rotation or succession (pre-committed successor,
  **or a FROST root**)". The critique is a reason to raise its priority, not to change course.

## 7. What I'd actually change because of this post

1. **Move expiry up from *Not in v0*.** Short-lived scoped delegations turn revocation into "don't renew," which
   removes the freshness dependency for the common case — the strongest version of his objection, answered
   structurally rather than argued with. Cost: reissue traffic.
2. **Write the self-contained proof format** (§5.2) now, since it's also what a Nostr mirror and any
   non-member verifier would need.
3. **FROST root as a key-holding option**, not a protocol change — the chain doesn't care how the root signs, which
   is precisely why these compose.
4. **Say the scope out loud in the spec:** rKey gives revocable, scoped, attributable delegation *within a context
   that has a membership set*. It does not give global identity consensus for strangers. Claiming less makes the
   part we do claim defensible.

## 8. The one-paragraph reply, if you want one

> Mostly agreed on Nostr — relays have no obligation to resolve anything and NIP-26 is the proof. But "a roundtrip
> per event" isn't what delegation costs; it's what uncached delegation costs. Chains verify per key and cache,
> revocation is monotone so caching is safe, and the proof can ride along in the event if you want zero fetches —
> that's TLS's shape, and AtProto caches per repo rather than per event too. What FROST can't do is the thing I
> need it for: a key that signs while I'm asleep, limited to posting and unable to enrol anyone, that I can cut off
> and prove I cut off. Same-signature means no attribution and no containment. So I'm using both — FROST to hold
> the root so it never has to rotate, a signed chain to delegate scoped authority to devices and agents inside
> contexts that actually sync state. Global consensus on "who am I now" I'm not attempting; you're right that
> that's an oracle problem.
