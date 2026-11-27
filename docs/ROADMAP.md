# Roadmap

Ideas and directions that are not bugs, in the shape every app keeps (Guy, 2026-11-24: "a standardized roadmap and
plan for every single app"). Every memo or room message that proposes something lands here, dated, with who said it;
when a piece ships, its line moves to Done with the commit. Bugs and friction stay in the Lab room and `lab-report-*.md`.
Started 2026-11-24 from the `projects` branch; the ideas below were carried from that branch's running notes.

## Next

- **Android release signing** (2026-11-24, first build for Guy's brother). Today the APK is debug-signed: it sideloads,
  but cannot be published and a later signed build cannot update it. Wanted: a keystore in `~/Anjou/_keys/` and the
  properties file `scripts/patch-android.mjs` reads (docs/MOBILE.md "First run and Android"); only Guy makes it.
- **An iPhone build for someone outside** (2026-11-24). Today the phone app goes on by cable from this Mac. Wanted:
  TestFlight, so the brother's iPhone gets the same build as the APK and the dmg. Open: the bundle id (`app.json`
  says com.bitcoinaudible.rkeychat, the installed app is com.anjouinc.rkeychat) must be settled first.
- **Owner devices exchange their notes links through a room** (2026-11-23, Guy: the Mac should follow the phone's
  notes without a link pasted by hand). Today: Settings › Debug has a "Follow" field for a pasted link (shipped
  2026-11-24, 96688cb). Wanted: an owner's devices post their notes link as a signed control and follow each other.
- **`allow_always` persistence** for an agent's permission answers, per room; today each session asks again.
- **Seat rename**, and **one runtime per conversation** chosen from the conversation's menu (today per seat).

## Later

- **Feed kinds** beyond chat (wiki and media spaces as rooms of a kind).
- **An MCP server for seats**, so an agent can read the room, its files and the other seats as tools.
- **Network / peers block** on Home: who is connected, which device hosts which seat.
- **Pending PearKit components** (see `app/src/kit.ts`): everything the shell still draws itself moves into PearKit.
- **TASKS.md** per project folder, written by the agent, read by the room.

## Done

- **Every message reaches the open chat after a reconnect** (2026-11-27, Guy: "We need to make sure that the space syncs
  every single item in the conversation the second a reconnect happens… There's a whole message in the conversation
  that is missing"). The Memo by Anjou agent's 17:11 reply was on the phone (its log held it, fetched in the catch-up
  batch when iOS restarted the backend) but never drawn: catch-up records were stored quietly and the page was never
  told, and a stream the browser reopened by itself did not count as a reconnect. Now the room says `caught-up`, the
  server pushes `resync`, the page reloads that room's threads, and any reopen reloads everything (lesson
  `caught-up-messages-never-reached-the-open-chat`). Open: the phone has no wake for a message while it is closed
  (push notifications), so it catches up only when opened.
- **Files in the conversation** (2026-11-25, Guy: "I should have a minimal small view where the images drop right into
  the conversation… a PearKit item for this with variations for multiple images or files… show up in the files list…
  and I need to be able to view it"). Shipped: PearKit `Attachments` (one picture keeps its shape, two side by side,
  three as one over two, four or more a grid with +N; other files as chips) and `MediaViewer` (the shared MediaPlayer
  full screen, next/previous, share); the shell's file URLs now reach the daemon's `/api/file` route (they pointed at
  the voice-memo route and 404ed, which is why the Leaf Note icons never showed); thumbnails and the viewer in the Files
  tab; a shared picture carries its size. Open: a native video engine on the phone (the viewer shows pictures there;
  video and sound through the web engine inside the webview), a share sheet on the phone (today the link is copied).
- **In-app updates and one rKeyChat in /Applications** (2026-11-25, Guy: "add our auto internal update module like we
  have in PearDrive, it should be available in PearKit as a main module… one main .dmg app in my Applications folder
  which we can continue to sign and update… one location with one main way to launch it"). Shipped: `pearkit/updates`
  (the release record and the UpdateChannel, from PearDrive's updater) and `pearkit/electron`'s swap with the previous
  copy kept out of Spotlight's sight and the way back; rKeyChat's channel Space over `_deliveries/rkeychat-desktop/`,
  Settings › Updates, the sidebar notice, `npm run ship` and `npm run release`. `docs/updates.md`.
- **First run and the first build for someone else, 0.3.0** (2026-11-24, Guy: "think about the flow of starting the
  app from nothing… a very clear in-your-way prompt to connect your AI… PPQ as a dedicated option, OpenRouter,
  llama.cpp… where do you want your projects to live… leave the option to skip them… a clean embossed block on the
  home page"). Shipped: name → Connect your AI (Claude login from the app, PPQ, OpenRouter, llama.cpp, another
  gateway) → Where projects live → Ready, every step skippable; the "Connect your AI" block stays on Home until an
  agent is connected; Settings › AI and › Debug "Follow". Mac dmg (signed, notarized), Linux AppImage and deb from
  the tag workflow, Android APK (debug-signed). `docs/first-run.md`; commits a630fd0 … bd6f029, PearKit
  feat/chat-shell bd1df1d (SetupStep, ChoiceCard, CalloutBlock).
