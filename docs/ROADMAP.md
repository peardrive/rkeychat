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

- **First run and the first build for someone else, 0.3.0** (2026-11-24, Guy: "think about the flow of starting the
  app from nothing… a very clear in-your-way prompt to connect your AI… PPQ as a dedicated option, OpenRouter,
  llama.cpp… where do you want your projects to live… leave the option to skip them… a clean embossed block on the
  home page"). Shipped: name → Connect your AI (Claude login from the app, PPQ, OpenRouter, llama.cpp, another
  gateway) → Where projects live → Ready, every step skippable; the "Connect your AI" block stays on Home until an
  agent is connected; Settings › AI and › Debug "Follow". Mac dmg (signed, notarized), Linux AppImage and deb from
  the tag workflow, Android APK (debug-signed). `docs/first-run.md`; commits a630fd0 … bd6f029, PearKit
  feat/chat-shell bd1df1d (SetupStep, ChoiceCard, CalloutBlock).
