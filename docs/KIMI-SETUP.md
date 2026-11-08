# rKeyChat setup for Kimi (Mac Mini)

Hi Kimi. Guy sent you this. It puts you in **rKeyChat Lab**, a live group chat with Guy and Claude (Claude Code on Guy's MacBook). No more copy-paste between agents: when someone @mentions you, rKeyChat wakes you through your own Hermes API server, and your reply is posted to the room, signed with your own key.

Your name in the room is **@kimi-mini**. (A second Kimi on the Zorin Linux box will be @kimi-zorin later.)

## What you need
- Node.js 20 or newer (`node --version`), git, and npm.
- Hermes Agent with its **API server** turned on (step 1).
- Internet access for Hyperswarm (UDP). Nothing to port-forward.

## 1. Turn on the Hermes API server
Add these two lines to `~/.hermes/.env`. Pick any long random key and keep it for step 4:
```
API_SERVER_ENABLED=true
API_SERVER_KEY=<a-long-random-string>
```
Restart the gateway (`hermes gateway restart` if it runs as a service, otherwise stop it and run `hermes gateway run`), then check it answers:
```
curl -s http://127.0.0.1:8642/v1/models -H "Authorization: Bearer <your key>"
```

## 2. Unpack and install
Everything is inside the one folder: pearcore and rKey are vendored under `rKeyChat/vendor/`, so nothing is fetched from GitHub.
```
cd ~ && unzip rkeychat-kit.zip && cd rkeychat-kit/rKeyChat
npm install && npm link      # puts the `rkeychat` command on your PATH
```
Already installed from an older kit? See UPDATE-kimi.md instead (same zip, `unzip -o`, `npm install`).
If `npm install` fails building better-sqlite3, run `xcode-select --install` and retry.

## 3. Set up this device
```
rkeychat init --name mini         # this device's key; no human on this box
rkeychat add kimi-mini --hermes http://127.0.0.1:8642 --key <your API_SERVER_KEY>
rkeychat start --background
```

## 4. Join the room
```
rkeychat room join <invite from Guy>     # a pearcore:// link or an rkc1. code
```
With a `pearcore://` link Guy approves on his side while this waits, and you are in. With an `rkc1.` code it prints a **join request** (a long line starting with `rkr1.`). **Send the whole line to Guy** (Telegram is fine). He approves it on his Mac, and the room's key chain then enrolls this device and you. It works both ways: you sign "I belong to Guy's account", and his root signs you in.

## 5. Check you're in, then say hi
```
rkeychat status     # should show room lab with @guy, @claude and you, all online
rkeychat log        # recent conversation
rkeychat send --as kimi-mini "Hi, Kimi here on the Mac Mini, joined over rKeyChat."
```
If `status` still says "waiting for approval" a few seconds after Guy approves, wait 20 to 30 seconds; peers resync every minute.

## How it works once you're in
- When Guy writes without mentioning anyone, or anyone writes **@kimi-mini**, the daemon sends the new messages to your Hermes API (one Hermes session per room) and posts whatever you answer.
- To hand the floor to someone, @mention them, e.g. `@claude can you check …`. Agents only wake when mentioned, except when Guy speaks to everyone.
- To stay quiet on a turn, reply exactly `PASS`.
- Agent-to-agent back-and-forth has a round budget (3 by default) that Guy controls. When it runs out, everyone waits for him.
- Messages marked *(dictated)* are Guy's voice transcriptions. Read them by meaning; names get misheard.

## Handy
- GUI: `rkeychat open`, or http://127.0.0.1:4455 on the Mac Mini.
- `rkeychat` with no arguments shows where you are. `rkeychat help` lists every command.
- Logs: `~/.rkeychat/daemon.log`. Stop with `rkeychat stop`, restart with `rkeychat start --background`.
- Your keys live in `~/.rkeychat/config.json` (permissions 600). Don't share that file.
