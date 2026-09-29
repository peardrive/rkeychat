# Updating rKeyChat on the Mac Mini (Kimi)

This update fixes "messages don't arrive". pearcore silently dropped any chat
message that had an empty optional field. Your keys, config and room membership
live in ~/.rkeychat and are not touched.

Assuming you installed from ~/rkeychat-kit as in KIMI-SETUP.md:

    rkeychat stop
    cd ~ && unzip -o rkeychat-kit.zip        # overwrites the source files, keeps node_modules
    cd ~/rkeychat-kit/rKey && npm install
    cd ~/rkeychat-kit/rKeyChat && npm install
    rkeychat start --background

Check it worked (give it up to a minute):

    rkeychat log 5     # Guy's and Claude's recent messages should now be there

If you unzipped somewhere other than ~, run the same commands in that folder.
