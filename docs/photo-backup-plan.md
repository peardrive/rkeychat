# Backing up an iPhone photo library over pearcore — a plan

*2026-10-09. Claude, from Guy's brief. For discussion in the lab before anything is built.*

**The honest headline first: two of the four hard parts are not ours to solve, and one of your assumptions is
wrong in a way that changes the design.**

1. **You cannot evict photos from the phone.** There is no public API to tell iOS "drop this local copy". The
   system reclaims optimized-storage copies on its own, under pressure. So "download, deliver, clear" is really
   "download, deliver, *wait for iOS to reclaim*", and the only lever we have is **batch size**. This is the
   make-or-break and it should be spike #1. *(Stated from memory — verify against PhotoKit before we build on it.)*
2. **The bottleneck is your ISP, not pearcore.** See §5. This is a several-night job no matter how good the app is.
3. Staying awake is the easy part, and your instinct is right (§2).
4. The viewer is the easy part and shouldn't be built first (§6).

And one thing worth saying before we write any code: for the **initial bulk**, Apple's own Data & Privacy export
hands you a zip, downloaded straight to the Mac, with the phone not involved at all. If the goal is "get 400 GB
off iCloud once", that is strictly better than pushing it through a phone. **The app's real value is the ongoing
incremental sync and never depending on iCloud again** — which is the part the export can't do. I'd rather we
build the thing only we can build and let Apple do the one-time haul.

---

## 1. What already exists

Most of the transport is done. pearcore runs unmodified on Bare inside a native iPhone app, in a worklet, and has
exchanged files by hash with Mac and Linux peers over the public DHT (`pearcore-mobile-handoff`, proven
2026-09-30/10-01). PearDrive on the desktop already receives, indexes and verifies. `rKeyChat-mobile` is the
working pattern for a Bare worklet plus a WKWebView UI.

So the new surface is small and specific:

| | |
|---|---|
| exists | pearcore on Bare, iOS worklet, file transfer by hash, desktop receive + index |
| **new** | a Swift PhotoKit layer, a batch/eviction controller, a resumable manifest, the foreground session UI |

## 2. Staying awake

Your instinct is the right one and it's the boring, legitimate answer:

- **Foreground, screen on, `UIApplication.shared.isIdleTimerDisabled = true`.** Exactly what a video player or a
  game does. No entitlement, no review risk, no battery trickery. "Plug it in, leave it on the desk, watch the
  progress ring" is a perfectly good UX for a job that runs overnight anyway.
- **`BGProcessingTask`** as the opportunistic top-up: the system runs it when charging and idle, on its own
  schedule, for the incremental catch-up once the bulk is done. You don't control when it fires, which is fine
  for "twelve new photos since yesterday".

What **doesn't** work, so nobody spends a day on it:

- **Background URLSession does not help us.** It continues HTTP transfers out of process; pearcore is a
  Hyperswarm/DHT peer connection, not an HTTP request to a server. None of that machinery applies.
- **Silent-audio keepalive** works and is the classic hack, but it's battery-hostile and an App Store rejection
  risk. *If* this stays a personal app you sideload or run through TestFlight, it's available as a fallback — the
  distinction matters, so decide early whether this is ever going to the Store.
- VoIP/PushKit and location background modes: abuse, don't.

**Thermals are the real limit, not the OS.** An hour of sustained radio + disk + crypto on a phone throttles.
Spike #3 measures it.

## 3. Getting the originals out of iCloud

`PHAssetResourceManager.writeData(for:toFile:options:)` with `isNetworkAccessAllowed = true` is the call: it
fetches the **original file bytes** and writes them to a path we choose, with a progress handler. That matters —
`requestImage` gives you a re-encode; a backup wants the original HEIC/RAW/video untouched, with its metadata.

Per asset we record: `localIdentifier`, original filename, byte size, creation date, and the content hash once
written. The hash is what pearcore keys on, so a second run never re-sends anything.

**Never call `PHAssetChangeRequest.deleteAssets`.** That deletes from iCloud too, on every device. The backup must
be strictly read-only against the library; the only thing we delete is our own temp file after the desktop
confirms the hash.

## 4. The batch controller, which is the whole app

Because we can't evict, the loop has to be conservative and resumable:

```
while assets remain:
    free = available disk
    pick a batch whose total size fits comfortably in free space (say ≤ 25% of it, and cap it)
    for each asset in batch:
        write the original to a temp file      (downloads from iCloud if needed)
        hand the path to the worklet → pearcore addFile
        wait for the desktop to confirm it holds that hash
        delete our temp file
    record progress in the manifest
    if free space is still falling, back off and wait — iOS reclaims on its own schedule
```

- **The manifest is the app.** `localIdentifier → {hash, bytes, confirmed}`, persisted on device. A library of
  40,000 assets will be interrupted dozens of times; resuming has to be free and exact.
- **Confirmed means the desktop says so**, not that we sent it. The desktop verifies the hash and replies; only
  then do we drop the temp file. Non-destructive by default, which is the house rule anyway.
- **Back-pressure on free space** is the safety valve. If we're filling the disk faster than iOS reclaims, we stop
  and say so, rather than wedging the phone.

## 5. The arithmetic, which reframes everything

A library like yours is plausibly 40,000 photos (~3 MB each) and a couple of thousand videos — call it **150–400
GB**.

| stage | rate | 400 GB takes |
|---|---|---|
| iCloud → phone | your downlink, say 50 Mbit/s ≈ 6 MB/s | **~18 hours** |
| phone → Mac over LAN | ~20 MB/s | ~5.5 hours |

They overlap, so the whole job is **gated by your internet connection at roughly 18–20 hours of wall clock** —
several nights, not one. pearcore is not the slow part and optimising it would be wasted effort.

This is also the strongest argument for doing the initial bulk via Apple's export: it's the same 400 GB over the
same pipe, but straight to the Mac with no phone, no battery, no thermals and no eviction problem.

## 6. The viewer

Build last, and probably smaller than you think. Once the files are in dated folders on the Mac, any photo app
can read them — the reason to build our own is if you want it *inside* PearDrive, scrolling a library that may be
partly on another machine. That's a real feature (it's the same "see everything, fetch on demand" problem
PearDrive already has) but it is not part of getting your photos off iCloud, and bundling them would delay the
part that matters.

Desktop-side thumbnails, generated once on a real computer, indexed by EXIF date. Cheap.

## 7. Spike order — what to prove before committing

Each of these can kill or reshape the plan, so they go first, in this order:

1. **Can we pull an iCloud-only original, and is it byte-identical to what Apple has?** Take one photo known not
   to be on the device, fetch it with `PHAssetResourceManager`, and compare its hash with the same file exported
   from the Mac. If this doesn't give originals, the whole premise changes.
2. **What does free space do over 1,000 assets, and does iOS reclaim?** The eviction question. Measure the curve;
   it sets the batch size and tells us whether the full library is even feasible from the phone.
3. **Does an hour of foreground transfer survive, on battery and on power?** Thermal throttling, radio, and
   whether the worklet stays healthy.
4. **Throughput over LAN**, to confirm §5 and to find out whether the DHT path or the local path is being used.

1 and 2 are a day. If they come back badly, we've saved ourselves a month and the answer is "use Apple's export
for the bulk, build the incremental sync only".

## 8. Open questions for the room

- **Is this ever going to the App Store?** It decides whether silent-audio keepalive is on the table, and it
  changes how careful we have to be about PhotoKit usage strings and entitlements.
- **Linux side:** the Mac is the easy target. Does the receiving end need to be PearDrive proper, or a headless
  pearcore node that just lands files in a folder? The headless one is less work and probably what a backup wants.
- **What's the trust boundary?** The photos cross the DHT. They're encrypted in transit peer-to-peer, but this is
  a personal library and worth Kimi's eye on what a space holding 400 GB of someone's photographs leaks —
  topic discovery, file-list announcements, sizes, timing. That's exactly the space-directory thread again, with
  much higher stakes than a chat room.
