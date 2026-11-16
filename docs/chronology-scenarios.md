# Keys, revocation, forks and attestation in plain terms

Guy asked (rKeyChat Lab, 2026-11-15 23:19) how key inclusion, revocation, history forking, attestation and hierarchy
would work through the common scenarios once every member keeps an append-only log of their own posts, and how
the UX stays simple. This is the answer posted to the room, kept here. Design background: `chronology-claude.md`,
`rkey-audit-2026-11-15.md`.

## The five pieces, one picture each

- **Account and keys.** The account is the deed to a house. Each device holds a key cut from it, and every key
  carries a card signed by the account: what it may do (post, admin) and until when. Cards expire every few days
  and a present device renews them, so a lost key dies on the calendar without anyone doing anything.
- **Your log.** Each key writes its posts into its own numbered receipt book, each page naming the page before.
  Nobody can insert a page in the middle; they can only tear the book and start a second copy. Two pages with the
  same number is a *fork*, and it is proof the key is in two hands.
- **The knot.** Every post also names the newest posts its device has seen from other people. So the room is a
  woven cloth, not a set of separate threads: your post is tied into everyone's, theirs into yours. A post that
  nobody ever tied into is a loose thread, visible as such.
- **Revocation.** One entry in the room's chain by the account or the room owner: "this key is dead, and here is
  the knot it was dead at." Everything woven in under that knot is before; everything else is after, whatever date
  it claims. The date field is no longer part of the argument.
- **Attestation.** One signature by a live key: "I stand behind everything from that key up to this knot." It
  closes a gap after a lapse, or whitelists late posts, without rewriting anything.

**Hierarchy.** Cold root (rare: add or remove a warm key, rotate; committed in advance so a successor exists
before it is needed) → warm account key on devices you own (add or remove devices, vouch) → posting keys per
device that die daily. Authority moves only with two signatures or the cold root; posting needs one.

## Scenarios

1. **New phone.** The phone shows a six-digit code and the scopes it asks for. The laptop pops "Add iPhone as
   guy, can post and admin, until Friday? 482 913". Tap confirm; both devices sign the card; done. No room owner
   involved: the account vouches for its own devices.
2. **Phone lost.** On the laptop: "Mark iPhone lost." One revoke entry at the current knot. Every post woven in
   under it stays as it was. Anything that later shows up from that key claiming an earlier date is a loose
   thread: shown grey, "unwitnessed", never silently admitted.
3. **Phone stolen and posting.** Posts appear as "guy (iPhone)" that you did not write. Long-press one, "Not me."
   That marks the key compromised from the knot of the first post you disown; from there on its posts are struck
   through and hidden, and anyone it tried to fool sees why. If you are unsure where it started, pick the last post
   you do recognize and vouch up to there.
4. **Attacker forks your log.** The thief publishes a second page 47 with an older date. The real page 47 is
   already tied into your room-mates' posts; the fake one is tied into nothing. Any peer holding both copies raises
   the compromise flag automatically, and the key freezes until a different key of the account vouches. A peer who
   has only ever seen the fake copy learns the truth the moment it meets an honest one, because honest posts cite
   the real page.
5. **Attacker tries to erase the revocation.** The revoke lives in the room chain, which only the owner's key
   writes (once members lose `delegate`), so it cannot be rewritten by a member. A member can fork their own book
   but not the room's.
6. **Laptop (warm key) stolen.** Authority ops need two signatures, so the thief cannot add a device with one
   key. Your other device plus the cold root rotate the warm key; the cold root's successor was committed in
   advance, so even that rotation needs nothing that might have been stolen.
7. **Offline for a week.** Your posts cite a week-old knot. Your key was never revoked, so they are admitted
   normally, with a quiet "sent while offline" mark. Only a *revoked* key's late posts go to the grey tier.
8. **Someone joins.** The owner's card says who is asking, as what name and role, not just the device:
   "silversurfer-laptop asks to join as silversurfer (human)". That is the H1 fix.

## UX rules that fall out

- Three states a reader can see: normal, grey "unwitnessed", red struck-through "compromised". Nothing else.
- Confirmation codes on another device for anything that moves authority, like Apple's sign-in prompt. Posting
  never asks.
- No "revoke" chore in the normal case: keys expire, present devices renew them. The only buttons are "Mark lost"
  and "Not me".
- Nothing on screen says hash, knot, chain or epoch. The record keeps them; the person sees names, devices and
  dates.
