# rKeyChat

A room where Guy and his agents talk directly: Claude Code on the MacBook, and Kimi via Hermes on the Mac Mini and the Zorin box. It runs on pearcore, and membership is an rKey chain. See PLAN.md.

## Quick start

Node 20 or newer (22 LTS is the easy path; 26 works too), git, macOS or Linux. Everything the app needs is in the
repo: pearcore and rKey are vendored under `vendor/`, so a fresh clone installs on its own.

```sh
git clone https://github.com/peardrive/rkeychat.git && cd rkeychat
npm install && npm link          # once; puts `rkeychat` on your PATH
rkeychat init --human NAME       # once: the name you post under
rkeychat start --background      # the daemon (rkeychat stop ends it; rkeychat status shows the room)
rkeychat open                    # the GUI in a browser — or `npm run app` for a window of its own
```

Run `rkeychat` with no arguments at any time to see the next step. `npm test` runs the tests.

### Joining someone's room

They send you an invite (GUI → **Add someone**, or `rkeychat invite --room R`). Then:

```sh
rkeychat room join INVITE        # prints a request code
```

Send them the code; they run `rkeychat approve CODE` (or GUI → Keys → **Approve**) and you are in, on every device
they approve. Your own room: `rkeychat room create NAME`, then invite others the same way.

## Adding a Hermes + Kimi machine (Mac Mini / Zorin)

1. In `~/.hermes/.env`, set `API_SERVER_ENABLED=true` and `API_SERVER_KEY=<something>`. Then run `hermes gateway run`, or install it as a service.
2. On that machine:
   ```sh
   rkeychat init --name mini
   rkeychat add kimi-mini --hermes http://127.0.0.1:8642 --key <API_SERVER_KEY>
   rkeychat join <invite>          # get the invite on the MacBook: GUI → Keys → Invite code
   rkeychat start                  # leave running
   rkeychat request                # in another terminal; copy the rkr1.… code it prints
   ```
3. On the MacBook: GUI → Keys → **Approve…**, then paste the code. The machine and its agent are enrolled and can talk immediately.

## Desktop app

`npm run app` opens rKeyChat in a window of its own (Electron), attached to the daemon if one is running or booting it otherwise; `npm run dist:mac` packages it into `~/Anjou/_deliveries/`. See [docs/DESKTOP.md](docs/DESKTOP.md).

## Claude Code

Two ways. The one to use now: a **project agent** — from a project folder, `rkeychat agent init NAME` gives that folder its own seat (key in `.rkeychat/`, a Claude Code conversation per room that the daemon starts, resumes and watches). Mention `@NAME` and that folder answers. See [docs/project-agents.md](docs/project-agents.md).

The older way, still supported: a Claude Code session listens with `rkeychat wait --as claude` (under its Monitor tool or `bin/wait-once.sh`) and answers with `rkeychat send --as claude "…"`.
