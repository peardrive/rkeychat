# Review: the Merkle-checkpoint proposal

*2026-10-06. Claude, on the outside answer Guy brought in about carrying revocations cheaply. Read with the caveat
he gave it: no context on what we've built. Judged against what we measured today
(`expiry-and-the-expired-key.md` §7).*

**Verdict: four things worth taking, one sharp bug-class catch, and one structural mismatch that means we should
not adopt the shape wholesale. And its central recommendation — a Merkle tree — is an optimisation for a problem
we don't have at our size.**

---

## Take these

**1. The four-way split.** It separates guarantees cleanly, and it's better language than I've been using:

- **authenticity** — the authority signed this state
- **status** — the key has this status *in that state*
- **freshness** — the state is recent enough for what you're about to do
- **latestness** — no newer authoritative state exists

"Signatures and set proofs supply the first two. A protocol must supply the latter two through additional
assumptions." That is exactly right, and it's the precise statement of the thing I've been calling "a stale
verifier accepts a revoked key". Worth adopting as vocabulary.

**2. Bind the proof to the authorization, not the public key.** This is the sharpest point in the whole piece and
it catches a real bug class in *our* design: re-adoption (`state.js` `#enroll`) creates a new node for a ref that
already existed, with a `gaps` entry for the lapse. If anything downstream keys on the **ref**, a stale
authorization for that same ref can be made to look current — the gap is in the node, not in the thing being
presented. Anything we sign about a key must name the enrolment (its op signature), not just the ref.

**3. Fail-closed on sensitive operations when no fresh state is available.** We have no such rule. Reading a room
with a stale view is fine; enrolling a key or changing the charter with a stale view is not. That distinction
should be explicit.

**4. A maximum tolerated revocation delay, stated as a number.** We've been treating staleness as unavoidable and
unquantified. Naming the bound is what makes it an engineering decision rather than a shrug.

**Already converged:** monotonic sequence with clients persisting the highest accepted value, and rejecting
conflicting roots at the same sequence while keeping the evidence. `chain.js` already does both — `seq` is
monotone, and `merge()` returns `{ result: 'fork', seq, ours, theirs }` rather than resolving. Good sign that two
designs reached it independently.

## The structural mismatch: it's an auth system, not a log

The proposal models **admission** — can this device act, right now. It has no history. Ours is a log, and in a
chat the question *"was this message from March legitimate?"* gets asked every time someone scrolls.

So this line is true for admission and false for attribution:

> "routine verifiers can retain a master public key, a recent checkpoint, and a small amount of rollback
> state—not hundreds or thousands of historical revocations."

A checkpoint answers *can this key talk to me now*. It cannot answer *was that old signature valid*, because the
old state isn't in it. That matches what we found measuring: the dominant cost isn't the revocation list, it's
that **verification is replay**, and a checkpoint collapses replay only for the live question.

Three questions, three artifacts, and they don't substitute for each other:

| question | artifact | cost |
|---|---|---|
| can this key talk to me now? | checkpoint | small, fixed |
| was this old message valid? | the chain, back as far as you render | replay |
| is my view current? | nothing cryptographic can supply it | sequence + expiry + a stated bound |

**Second mismatch, smaller:** the proposal is a flat master→device map. We have a hierarchy where a key is active
only if every ancestor is, scopes intersect down the tree, and revoking orphans a subtree. A membership proof over
a set of authorizations can't express "active *because* its ancestors are". Our checkpoint has to commit to the
**folded effective state** (ref → scope, status), not to a set of certificates. Still a map; different meaning.

**Third:** it assumes a master that can be brought online to sign fresh checkpoints, and admits it has no answer
when the master is offline for long periods. Our root is *cold by design*. We already have the answer it's missing
— the **warm signer** issues checkpoints under `delegate`, which is what `chain.js` means by "the writer must be
the root or an active key with delegate — in practice the warm steward."

## The Merkle tree is premature at our size

Its own sizing: 1,024 leaves → a 10-hash path → 320 bytes, versus sending 1,024 records. True, and a good trade at
1,024.

But the checkpoint commits to the **active** set, not to every key that ever existed. Guy's scenario is hundreds of
devices *over ten years*; the set live at any moment is more like **ten to twenty**. At that size:

- a plain signed list of active keys is ~2 KB
- a Merkle proof is ~5 sibling hashes (160 bytes) **plus** a tree format decision, a sparse-vs-dense choice, proof
  serving, witness/proof regeneration on every change, and a second place for bugs to live

2 KB is nothing. We'd be buying 1.8 KB with a pile of machinery. The post even hedges this — "choose the actual
tree format and compression scheme before promising wire sizes", and an uncompressed 256-bit sparse tree needs 256
siblings, which is *worse* than the list.

So: **signed list now, keep the tree in the back pocket** for if an active set ever reaches the hundreds. The
interface should be "here is the checkpoint, here is my evidence" so the evidence can become a proof later without
changing anything around it.

**Accumulators:** correctly dismissed by the post itself. Constant-size witnesses, but witness maintenance on
every change and non-hash assumptions. Not for this.

## The "only signatures" alternative is what we already chose

Its final option — the authority signs a short-lived statement naming the key and its validity window, no set
proof at all — is exactly the detached delegation from `expiry-and-the-expired-key.md` §7, and it names the
limitation we already accepted: revoking doesn't invalidate an attestation that's already out; it stays usable
until it expires. That's precisely why the lifetime is tuned to how reachable the parent is.

## What I'd actually do with this

1. Adopt the **authenticity / status / freshness / latestness** vocabulary in the spec.
2. **Bind anything we sign about a key to the enrolment, not the ref.** Do this regardless; it's a correctness fix.
3. Checkpoint = **warm-signer-signed folded state**, a plain list while the active set is small, with the shape
   left open for membership proofs later.
4. State the **maximum tolerated staleness** as a number, and **fail closed** above it for enrolment and charter
   changes while still rendering the room.
5. Keep the chain for history. Nothing here replaces it, and the measured cost says that's where the effort goes.

Nothing in it changes the conclusion from this morning: get refresh off the chain first. That's the three orders
of magnitude. This is a refinement of the artifact at the other end.
