# How an invitation works, step by step — and why you're right about the link

*2026-10-09. Claude, answering Guy: is the nonce not the one-time token, and why do we need more than a pearcore
link?*

**Short version: you're right. The nonce is effectively the one-time secret, the separate token adds almost
nothing, and the one thing that genuinely has to travel is already inside a pearcore link. I over-built it.**

And there's a gap you asked for that I didn't build — §5.

---

## 1. What happens today, step by step

1. **You press "Show an invitation".** Your device creates a **brand-new pearcore space**, used for this one
   invitation and nothing else. pearcore gives it a random 24-character nonce, and the space's topic is
   `hash(name___yourPublicKey___nonce)`. Nobody can guess that topic.
2. **The QR holds that space's sharelink** — `pearcore://…`, which decodes to `{spaceName, publicKey, nonce}` —
   plus, in my wrapper, your account root, your name, a token, and the room's name.
3. **They scan it and join that throwaway space.** Only someone holding the link can find it, because the topic
   is a hash of the nonce.
4. **Inside the space they send a join request:** their device key, their account root, and a signed consent
   saying "yes, put me under that root". Plus the token.
5. **Your device checks the token, signs their keys into that room's chain, and replies** with the room's invite.
6. **They join the room.** Your device marks the offer used and tears the throwaway space down.

## 2. Is the nonce the one-time token? Essentially yes

The nonce is per-space, not per-account, and **a fresh space is made for every invitation** — so its nonce is
unique to that invitation and unguessable. Holding the link *is* the proof.

Which means the separate token is close to redundant: anyone who can put a message into that space has already
demonstrated they hold the link, because that is the only way to find the space at all.

**And here is the part worth being clear about: the token is not what makes it single-use.** What makes it
single-use is that your device marks the offer done and closes the space. That's state on your side, not a secret
in the link. A second person with the same photo of the QR is refused because *your device has stopped
answering* — not because they failed a check.

(The token earns its keep in one narrow way: it binds a request to *this* offer, so a message replayed into a
different space can't be mistaken for a fresh request. That's belt-and-braces, not the load-bearing part, and I
should have said so rather than implying the token was the security.)

## 3. So why anything more than a pearcore link?

One thing, and only one, is irreducible: **the scanner has to know what the scan is for.**

A bare `pearcore://` link is indistinguishable from "join this file share". Scanning one must never silently
enrol you in somebody's room, and must certainly never log you into their account. The *action* has to be
knowable before anything is granted.

**And that one thing is already in the pearcore link.** The sharelink carries the space **name**, and we choose
the name. Verified just now — decoding a bare sharelink gives back:

```json
{ "spaceName": "rkeychat-login:GWuhtN",
  "publicKey": "8b3d42af…",
  "nonce":     "06f37e722f3880e2fca23764" }
```

So `rkeychat-invite:<random>` versus `rkeychat-login:<random>` *is* the action, carried natively, needing no
wrapper at all.

Everything else I put in the wrapper — your account root, your display name, the room's name — can be sent **in
band, after they join the space**, because by then there is a channel. They were only in the QR because I put
them there.

**Conclusion: the invitation can be a bare `pearcore://` link.** Smaller QR, nothing of ours on the wire, and it
stops being a thing Farzam has to accommodate. The upstream pass-through field I asked for isn't needed for this
after all.

## 4. What the change looks like

- The handover space is named `rkeychat-invite:<6 random chars>` (or `rkeychat-login:`), and the QR is just its
  sharelink.
- The scanner decodes the sharelink, reads the name prefix, and **says what it is about to do** — "join the room
  Guy is inviting you to?" versus "log this device in as Guy?" — before doing anything.
- On joining, the host sends `{action, root, name, roomName}` in band as its first message; the scanner replies
  with its join request. No token: holding the link was the proof, and single-use stays where it already is, on
  the host.
- `rkp1.` stays decodable for a release so codes already handed out keep working.

## 5. The gap: "the user we're expecting"

You asked how we make sure it's the person we mean. Honest answer: **from the link alone, we can't.** It is a
bearer credential, like a door key — whoever holds it gets in. Photograph the screen and you hold it.

Two things bound that, and only one of them exists:

1. **You hand it over through a channel you trust** — showing your screen to someone in the room with you. Real,
   and entirely on you.
2. **Your device asks you before granting.** You asked for exactly this in the original brief: *"a confirmation
   prompt is given on the host/master device to add the device"*. **I did not build it — the current flow
   approves automatically.**

That second one is the only thing that actually answers your question, and it's the piece missing. With it, a
stolen photo of the QR gets a stranger as far as *"someone is asking to join — their device is called X, their
key starts with ab12…"* on your screen, and no further.

It should show what we know about them (device name, key fingerprint, whether you've seen that key before), be
the only path to granting, and time out rather than defaulting to yes. That's the next thing I build on this,
and it matters more than the link format.
