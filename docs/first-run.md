# First run: from nothing to a working project, one step at a time

*2026-11-24. The first build handed to someone outside (Guy's brother, who runs his own model with llama.cpp).
Guy: "when you boot it up, it basically says, like it's an empty chat interface… a very clear in-your-way prompt,
particularly on the desktop version, to connect your AI… both the login to your Claude subscription flow, your
connect to… PPQ as a dedicated option, and then OpenRouter as well, but then also say a connect to llama.cpp, and
then have a connect your base folder… in a very clean one at a time flow, so that basically as soon as you get to
the main interface, you can't have gotten it wrong."*

## The steps

| Step | Where | What | Skippable |
|---|---|---|---|
| 1 · Your name | `electron/first-run.html` (the daemon does not exist yet) | the name messages carry | no |
| 2 · Connect your AI | the shell, `app/src/components/SetupFlow.tsx` | Claude subscription (log in), PPQ, OpenRouter, llama.cpp | yes |
| 3 · Where projects live | the shell | the folder new projects go in (`~/rKeyChat` by default; Choose… opens the picker) | yes |
| 4 · Ready | the shell | who, which AI, which folder; Open rKeyChat | — |

On a phone there is no name page (the app asks before its engine starts), no folder step (projects live on a
computer), and step 2 says so: install rKeyChat on the computer and log the phone in from it.

The daemon says which step is left: `GET /api/setup` → `{ name, device, canHost, claude, providers, presets, agent,
connected, workspace, workspaceSet, done }`. `agent` is the device's choice for new seats (`'claude'`, a provider's
name, or null); `connected` is whether a seat could run right now (the chosen provider is ready, or the login is
held); `done` is whether the flow was finished or skipped. `POST /api/setup { agent?, done? }` saves a choice and
pushes `setup` to every open page. A device that already has rooms (every install from before this flow) counts
as done without being asked.

**A skipped AI is not forgotten.** Home keeps a standing notice, "Connect your AI" (PearKit `CalloutBlock`),
as long as `canHost && !connected`; on the desktop it is also above the empty middle pane. Pressing it opens the
flow again (with a close button this time). Settings › AI shows the same choice cards, so there is one way to
connect an AI anywhere.

## The four ways

Every way is the Anthropic Messages API, so Claude Code is pointed at it with two variables and nothing else
changes (`src/seat-settings.js` `providerEnv`): `ANTHROPIC_BASE_URL` and `ANTHROPIC_AUTH_TOKEN`, with
`ANTHROPIC_API_KEY` emptied so a key in the computer's own environment is never sent to a provider by mistake.

| Way | Base URL | Key | How it is connected |
|---|---|---|---|
| Claude subscription | (none: the login) | — | `src/claude-login.js` runs the adapter's own CLI: `<adapter> --cli auth login --claudeai`. The browser opens; when it cannot reach back the CLI prints the URL and waits for the code the page shows, which the person pastes into the app. `auth status --json` says who is logged in. |
| PPQ | `https://api.ppq.ai` | required, from ppq.ai/api-docs | paste the key |
| OpenRouter | `https://openrouter.ai/api` | required, from openrouter.ai/settings/keys | paste the key |
| llama.cpp | `http://127.0.0.1:8080` | none | confirm the URL where `llama-server` answers (it has served the Anthropic Messages API since January 2026); the seat gets the placeholder token `local`, because Claude Code refuses to start without one |

The presets are `PROVIDER_PRESETS` in `src/seat-settings.js`; `GET /api/providers` answers them next to the
providers held. A provider is recognised as a preset by its name or by its URL, and `ready` says a seat can run on
it now (a key is held, or the preset needs none). The key is kept in `~/.rkeychat/config.json` on that computer,
never answered by the API, never sent to the other devices. Any other gateway can still be added by name under
Settings › AI › Another gateway.

**New seats follow the choice.** `addAgent` in `src/daemon.js` puts a new seat on `settings.agent` when it names a
provider; `'claude'` or nothing leaves the seat on the login. A seat is moved later from its profile (From).

## What was wrong before this

- **The packaged app had never started an agent.** `src/acp.js` spawned the adapter with `process.execPath`, which
  inside the desktop app is the app itself: a second window instead of a script. `nodeEnv()` now sets
  `ELECTRON_RUN_AS_NODE` for the adapter and the login CLI when the daemon runs inside Electron. From a terminal
  (`rkeychat start`) it always worked, which is why nobody saw it.
- **The desktop app opened the classic room page.** Since this build it opens the shell at `/app/`;
  `RKEYCHAT_SHELL=room` or `--room` gets the old page.
- **A seat needed a token for every provider.** A local llama.cpp has none; a key-less preset now gets a
  placeholder.

## Tests

- `test/setup.test.js`: the presets, a key-less provider's environment, the login output as the daemon reads it,
  and a whole login driven through a fake CLI (URL, code prompt, pasted code, success and failure).
- `app/src/store/setup.test.ts`: which steps apply, the choices and where each stands, the summary.
- `app/scripts/gui.test.mjs`: the flow in a real browser against the mock (`?setup=fresh`): PPQ key → Continue →
  folder → Ready → the shell with no notice; the Claude login with a pasted code; skipped → the notice on Home opens
  the flow again; a phone's two steps.
- PearKit: `SetupStep`, `ChoiceCard`, `CalloutBlock` (`src/components/Setup/`, stories under Setup/).
