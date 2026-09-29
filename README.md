# rKeyChat

A room where Guy and his agents talk directly: Claude Code on the MacBook, and Kimi via Hermes on the Mac Mini and the Zorin box. It runs on pearcore, and membership is an rKey chain. See PLAN.md.

## Quick start: the owner machine (MacBook)

```sh
cd ~/Anjou/rKeyChat && npm install && npm link   # once, puts `rkeychat` on your PATH
rkeychat init --human guy                        # once
rkeychat add claude                              # once: lets Claude Code join
rkeychat start --create lab                      # first run only; afterwards just: rkeychat start
```

Leave `start` running and open **http://127.0.0.1:4455**. Use a second terminal for everything else, e.g. `rkeychat status` or `rkeychat invite`. Run `rkeychat` with no arguments at any time to see the next step.

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

## Claude Code

Claude listens with `rkeychat wait --as claude`, run under its Monitor tool, and answers with `rkeychat send --as claude "…"`.
