# Revoked keys, adding a root later, and one link type

*2026-10-06. Claude, for Guy. Answers to the three things in today's message that aren't just UI: why the
revoked-key pile exists and how much of it is really necessary, what it takes to put a root **above** a key that
already has a life, and what should replace `rkc1.` / `rkr1.` / `rkl1.`*

---

## 1. The pile of revoked keys

**Fixed already (UI).** "Your keys in ROOM" now lists the keys that can sign *now*; removed ones sit behind a
"N removed keys" disclosure. That was the actual complaint and it was a display bug.

**The real question: does the revocation have to live forever?** Three separate things get tangled here:

1. *Can a revoked key still sign?* Always. A key is a number; nothing can un-make it.
2. *Does a verifier need the revocation to reject it?* Yes — if the key would otherwise be trusted.
3. *Does the revocation have to be kept forever?* Only as long as the **enrolment** it cancels is still in the
   chain. And the enrolment is also in the chain forever, because verification folds from genesis.

So your instinct — "all that really needs to be known is that they're on the latest list" — is right for one
question and wrong for another:

- **"Can this key talk to me now?"** A signed snapshot answers it. No history needed.
- **"Was this message, signed last March, legitimate?"** A snapshot cannot answer it, and in a chat that
  difference is the whole point: a key removed as `removed` (you logged a phone out) keeps its old messages
  valid, while a key revoked as `compromised` loses everything from `since` onward. That's exactly what
  `trustedAt(key, ts)` in `rKey/src/state.js` computes, and it's unavailable without the history.

**How big is the pile actually?** The chain is O(key events) — not O(time), not O(messages). An enroll + revoke
pair is about 400 bytes. A hundred devices over a decade is 40 KB. **This isn't bloat and we shouldn't design
around it.** What *would* make it bloat is rotating session keys often, and that has a better answer than
revocation.

### The fix is expiry, not smarter revocation

Give delegations a lifetime. A session key with an `exp` simply stops being trusted — no revoke op, no record, no
freshness dependency. Revocation then only exists for the exceptional cases (a compromise, kicking someone), which
are rare, so the pile stops growing in normal use. `SPEC.md` lists expiry under *Not in v0*; this is the second
reason in a week to move it up (the first was the FROST thread, `docs/rotation-delegation-and-frost.md` §7).

Cost: reissue traffic. A device that's offline past its expiry needs a fresh delegation before it can speak
again. That's a real UX edge and the reason to pick a generous lifetime (weeks, not hours) for devices and a
short one for anything hot.

### Checkpoints, for the devices that only care about now

A **checkpoint** is a signed `{root, asOf, active: [...], head}` from the root. A peer holding one can answer
question 1 without folding anything. It does *not* let you validate signatures older than `asOf`, and it's a trust
shortcut — you're believing the root's assertion instead of auditing how it got there.

So the split is: **checkpoint for liveness, chain for history.** A phone that only renders recent messages can
carry a checkpoint. A machine that renders the archive keeps the chain. Both are already expressible; the
checkpoint is one new signed record type.

### What is *not* solvable

A stale verifier accepts a key revoked since it last synced. Every PKI has this and the only real mitigations are
short lifetimes (expiry again) and syncing often. Worth stating plainly rather than designing around.

---

## 2. Adding a root later, above a key that already has a life

The goal is right: "turn it on and share files" should need no ceremony, and the identity upgrade should come
later, as one scan. Good news first.

**The crypto already works.** `consent` deliberately omits the parent (`SPEC.md`), so a key can consent once and
be adopted anywhere in a tree. A new root enrolling an existing PearDrive key is an ordinary enroll: the root
signs the op (`by: parent`), the key signs the consent. Both directions, already specified, no new primitive. The
"needs a signature both ways" problem is solved — that's what consent is.

**What doesn't work yet.** A PearDrive-first key is *its own root*: it has its own genesis, and a root cannot be
revoked. After adoption there are two chains naming the same key — its own, where it is the unrevokable root, and
the new one, where it is a child. rKey has no way to say "this account became a child of that one", so both stay
live. The key could keep enrolling devices under its old root while the new root thinks it's in charge. Two
authorities, no resolution.

**The one addition that fixes it: a `supersede` op.** Signed by the old root, appended to the old chain, saying
*authority for this account now comes from root R; nothing further will be appended here.*

- It lives in the **old** chain, which is the one a stale peer already holds — so the peer that needs to be told
  is the peer that finds out.
- It's terminal and monotone: once superseded, the chain is closed. A key can only abdicate once, so the
  double-adoption ambiguity ("K consents to two different roots") can't happen — and if two `supersede` ops ever
  appear at the same `seq`, that's a fork, which is already proof of equivocation.
- A verifier folding the old chain follows the pointer to R and continues there.

**What stays hard, and it isn't cryptographic.** Peers who knew you as K must accept that K's authority now traces
to R. That's an identity-change event, and per the FROST thread it's only answerable inside a context with a
membership set — a room, a space, a drive. There is no global answer and we shouldn't invent one. In practice:
each room the key is in records the new root once, the same way it records any other enrolment. Rooms are the
right granularity.

**UX sketch.** PearDrive opens → a key is minted, self-rooted, nothing asked. Later: "Secure this identity" →
scan the signing app's QR → the app's root enrolls the PearDrive key as a child, PearDrive appends `supersede`,
and every room it's in gets the new root. Two taps, no re-adding anything.

---

## 3. One link type, two flows

Today there are three hand-rolled base64url blobs: `rkc1.` (room invite, pasted), `rkr1.` (join request, pasted
*back* — the step you hate), `rkl1.` (login, already a QR). The login one is already the shape you described: a
throwaway pearcore space, a one-time token, a QR, everything in band. `src/login.js` does it today.

**So the answer is to generalize `login.js`, not to invent a link format.** One **pairing link**, one mechanism,
an `action` field:

```
scan → join the throwaway space → send the signed request in band → host prompts →
host answers with what's needed → space torn down
```

- `action: 'join-room'` — host confirms, enrolls the scanning device into that room, answers with the room. **No
  paste-back.**
- `action: 'add-device'` — the two-way key-hierarchy signing that `login.js` already performs.
- Later, for free: `action: 'adopt'` (§2) and `action: 'share-drive'`.

**On the link format, and on the rename.** pearcore's own sharelink is
`<prefix>://<base58(brotli({name, pk, nonce}))>` (`src/utils/sharelink.utils.js`). Two useful facts:

1. **`prefix` is already a parameter and `decodeShareLink` ignores it entirely** — it splits on `://` and decodes
   the rest. So the scheme name is cosmetic at the protocol level, and **renaming the app costs nothing**. Pick
   whatever name you want later; old links keep decoding.
2. The payload has no room for a token, which is the one thing a pairing link needs beyond a space.

So the ask upstream is small and additive: **an optional pass-through field in the sharelink payload** (one key,
carried through encode and decode untouched). Old decoders ignore it, every app gets one link type for pairing,
and we stop carrying our own encoding. That's a few lines in `sharelink.utils.js` and it follows Farzam's
structure rather than running beside it.

If he'd rather not touch it, the fallback is to put the token in the space name — it already has to match on both
sides to derive the topic, and the link is the secret either way. It works; it's just less clean.

**One thing to keep.** A QR is a bearer token: whoever photographs the screen can use it. Keep the host
confirmation on the *other* device for every action, keep the window short, keep it single-use. The login flow
already does all three.
