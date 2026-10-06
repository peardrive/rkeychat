# Expiry, the lapsed key, and what a later signature can and cannot bless

*2026-10-06. Claude, answering Guy's question about what happens to a key whose session expired on the 2nd and
that keeps being used on the 3rd, 4th, 5th and 6th.*

Short answer: **the structure you described is right, and two of the conclusions need correcting.** A later
signature cannot retroactively bless earlier posts on its own — but the *parent* can bless them, deliberately and
auditably, and rKey already has the machinery in the opposite direction. And the 90-day "start fresh" works for
routine expiry but not for compromise, and it rests on a clock we don't have yet.

---

## 1. The layering you described is the right one

| | lifetime | signs | lives |
|---|---|---|---|
| **cold root** | none — it's the anchor | the warm signer, rarely | offline, card / safe |
| **warm signer** | long: 30–90 days | device and session keys | a signing app on your phone |
| **session / device key** | short: days to weeks | everything you actually do | in the app, refreshed quietly |

You're right that a 24-hour lifetime on the *warm* key is unworkable — that's a daily ceremony. But a 24-hour
session key is fine, because refreshing it only needs the **warm** signer, which is a tap on a phone, not the cold
root in a safe. The cold root comes out on the quarterly cadence, or when something goes wrong.

So the rule is: **the lifetime of a key should be inversely proportional to how hard its parent is to reach.**

## 2. "Does the October 7th signature validate the 3rd through the 6th?"

**No, and it must not.** Here is why, and it isn't a design choice — it's forced.

A signature proves *who*, never *when*. Our timestamps are self-asserted (`SPEC.md`: "Timestamps are self-asserted
in v0"), so a verifier cannot tell "signed on the 1st, delivered late" from "signed on the 5th and backdated to the
1st". If renewing on the 7th automatically validated everything since the lapse, then a thief who took the key on
the 3rd would have every message they wrote blessed the moment **you** renewed. The expiry would mean nothing,
because the attacker's window would always be closed retroactively by the victim.

So: a new delegation says "valid from the 7th", and that is all it says.

**But the thing you want is still expressible** — it just has to be a separate, deliberate, signed claim, made by
the authority rather than by the lapsed key itself:

> *the warm signer says: I accept K's signatures between the 2nd and the 7th.*

That's a **vouch**: a positive window, signed by the parent, that anyone can see and attribute. It's the exact
mirror of what we already have in the negative direction, and the code is already shaped for it:

- `revoke { reason: 'compromised', since }` makes a key's signatures untrusted **from** a point (`state.js`
  `trustedAt`).
- Re-enrolling a removed key already records a **gap** — `gaps: [{ from: revoked.ts, to: op.ts }]` — and
  `trustedAt` returns false inside it. Signatures from the lapsed period stay untrusted even though the key is
  live again.

An expired-then-renewed key should produce exactly that gap, by the same code path. A vouch is then the op that
closes a gap, and the record of *who* decided to close it stays in the chain forever. That's the honest shape: not
automatic, but available, and attributable to the person who took the risk.

## 3. Quarantine: expired is a third state, not a flavour of revoked

This is the part of your message I'd keep whole. Today a key is trusted or it isn't. Three states are better:

- **trusted** — a live delegation covered the claimed time.
- **expired** — still *bound* to the account (we know whose key it is), but nothing it signs now is admitted.
  Recoverable by reopening the warm app. Not an accusation.
- **revoked / compromised** — cut off. `compromised` additionally poisons its past from `since`.

The difference that matters for the app: **expired is a prompt, revoked is an alarm.** "Your session lapsed, open
your signing app" is a different sentence from "this key has been removed", and today they'd look the same.

Your quarantine idea follows from it: records from an expired key can be **stored and shown as held** without
being admitted, so that a later vouch can promote them in place instead of losing them. In rKeyChat terms,
`#admits()` currently rejects outright; holding is a third outcome.

**The caveat I'd insist on**, because it's the hole an attacker would use: a quarantine is unbounded writable
storage offered to a key we have just stopped trusting. It needs a cap — per key, a small number of records and
bytes and a short window — and it should only apply to a key whose delegation lapsed *recently*, never to a
stranger or to a key revoked as compromised. Without that it's a disk-filling primitive with our name on it.

## 4. Doing it on purpose

Yes, and cheaply. Enrol a key, let it lapse, keep signing with it, then vouch for the window — as a test, so the
behaviour is pinned by something that fails when we break it. It is also the most honest way to find out what a
hostile device inside a space actually looks like from the other side, which is Kimi's territory. I'd write it as
a regression test rather than a one-off experiment.

## 5. "After 90 days can we ignore the history and start fresh?"

Half right, and the half that's wrong is the one that bites.

**Right:** once a key's delegation has expired, you no longer need a *revocation* for it. Expiry subsumes
revocation for the routine case — a phone you logged out of, a laptop you sold, an agent you retired. That's the
real win, and it's a growth-rate win: the common case stops producing records at all, instead of producing a
revoke op each time.

**Wrong, in three places:**

1. **You can't drop the delegation.** The enrol op is what *carries* the expiry. Discard it and you no longer
   know the key ever lapsed. So you save one op per departure, not two, and the chain still grows with people and
   devices — just much more slowly.
2. **`compromised` is not subsumed.** A compromise revocation reaches *backwards*, invalidating signatures inside
   a window that was otherwise valid. Drop it and those messages silently become valid again. Compromise records
   have to be kept as long as you care about the history they invalidate.
3. **"All signatures carry a timestamp" is the weak link.** They carry a timestamp the *signer chose*. Every rule
   in this document — expiry, gaps, vouches, the 90-day cadence — rests on that timestamp being honest, and right
   now nothing enforces it.

### The clock is the real open problem

You half-named it yourself ("block height or whatever it is"). Two levels of answer:

- **Cheap, now: witnesses.** Peers see when a record *arrives*. A record arriving on the 5th claiming the 1st is
  something any online peer can notice and flag. In a live room that's most of the value, for free, and it's worth
  recording arrival time next to the claimed one.
- **Proper, later: anchoring.** A countersignature from a peer, or an OpenTimestamps/Bitcoin anchor, turns "signed
  before T" into something provable rather than asserted. `SPEC.md` lists timestamp anchoring under *Not in v0*.
  Everything in this document gets stronger the day that lands, and the 90-day cadence in particular only becomes
  safe to rely on once it has.

## 6. So, in order

1. **Expiry on delegations**, with the lifetime set by how reachable the parent is. (Already overdue — it's come
   up three times this week.)
2. **Expired as its own state**, with the app's prompt rather than its alarm.
3. **Gaps from lapse**, reusing the re-enrolment path that already produces them.
4. **Vouch** — the parent closing a gap, explicitly and attributably.
5. **Quarantine** with a hard cap, so a vouch has something to promote.
6. **Arrival time recorded next to claimed time**, as the poor man's clock, before real anchoring.

You've got the shape right. The two corrections are: a renewal can't bless the lapse by itself (someone has to
say so, on the record), and the 90-day reset doesn't extend to compromise — or to any of it, until the timestamps
mean something.
