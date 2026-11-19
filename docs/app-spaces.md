# App spaces in rKeyChat

The standard every app of ours follows is `~/Anjou/_documents/wiki/app-spaces-standard.md` (the wiki). This is
what rKeyChat does with it, as of 2026-11-19:

- **Every room rKeyChat makes** (a chat, a project) gets `.pearmeta/app.json` and `.pearmeta/app-icon.png` at
  its root, written by the owner device (`src/app-space.js`, called from `createRoom`, `createProject` and a
  folder change). The manifest says `app: rkeychat`, the `kind` (`chat` | `project`), the room's name, and for
  a project its `home` device. PearDrive files the space under rKeyChat once it reads manifests; the icon is the
  128×128 PNG in `src/assets/app-icon.png` (the phone bundle carries it: `RKEYCHAT_ICON`).
- **The debug-notes space** is named `rKeyChat Debug Notes (<device>)`, so PearDrive's name seed files it today.
  It carries `space.json` (as PearDrive's and pearcast's do) and the manifest with `kind: debug-notes`. Notes
  are `notes/<id>/note.*, trace.jsonl, note.json`, recorded with PearKit's module from the shell (`app/src/debugNotes.ts`),
  the link is in Settings → Debug, and an agent pulls them with `rkeychat notes pull <link>` (links to the old
  `rkeychat-debug:<device>` spaces still work).
- **Not yet**: a `main` space for rKeyChat (the app's profile and its list of spaces), the app key that signs
  the manifest, and PearDrive reading manifests (rule 4 of the standard, PearDrive's side).
