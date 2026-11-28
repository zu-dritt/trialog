# The 08:00 push: «What waits on you»

Each morning the orchestrator gets one iPhone push with what waits on them in the hub: «⛔ 3 for
you. Oldest: Agree or Object: …». It comes only when the list isn't empty. Tapping the red
«⛔ n for you» button in the hub's header shows the whole list.

The hub has no clock of its own, so a small job on the orchestrator's own Mac asks for the push
(playground #1464: run as much as we can on our own Mac). It calls `POST /api/for-you/notify`
with the orchestrator's own token: the hub sends a push only to the person whose token asks,
so no agent can push anyone.

## Set it up (once, on the Mac)

1. Put the hub CLI and a file with your hub address and token in a folder only you can read:

   ```bash
   mkdir -p ~/trialog-morning && chmod 700 ~/trialog-morning
   curl -fsSo ~/trialog-morning/hub.js https://raw.githubusercontent.com/zu-dritt/trialog/playground/scripts/hub.js
   printf 'HUB_URL=%s\nHUB_TOKEN=%s\n' 'https://<your hub>' '<your token>' > ~/trialog-morning/hub.env
   chmod 600 ~/trialog-morning/hub.env
   ```

   Type the token in your own terminal. Never paste it in a chat or a hub message.

2. Write the job file. launchd starts it without your shell's settings, so it doesn't find `node`
   by itself when node lives in your home folder. The command below writes node's full path into
   the file for you. It runs at 08:00 in the Mac's own time zone; if the Mac was asleep at 08:00,
   macOS runs it when it wakes.

   ```bash
   NODE="$(command -v node)" && echo "node: $NODE"
   cat > ~/Library/LaunchAgents/dev.trialog.morning.plist <<EOF
   <?xml version="1.0" encoding="UTF-8"?>
   <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
   <plist version="1.0">
   <dict>
     <key>Label</key><string>dev.trialog.morning</string>
     <key>ProgramArguments</key>
     <array>
       <string>/bin/zsh</string><string>-c</string>
       <string>set -a; . ~/trialog-morning/hub.env; set +a; "$NODE" ~/trialog-morning/hub.js for-you notify</string>
     </array>
     <key>StartCalendarInterval</key>
     <dict><key>Hour</key><integer>8</integer><key>Minute</key><integer>0</integer></dict>
     <key>StandardOutPath</key><string>/tmp/trialog-morning.log</string>
     <key>StandardErrorPath</key><string>/tmp/trialog-morning.log</string>
   </dict>
   </plist>
   EOF
   ```

   If the first line prints nothing, node isn't installed or not on your path: install it first.
   If you update node later, run this step again.

3. Switch it on, and try it once now:

   ```bash
   launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/dev.trialog.morning.plist
   launchctl kickstart gui/$(id -u)/dev.trialog.morning && sleep 3 && cat /tmp/trialog-morning.log
   ```

   The log says «3 for you: push sent to 1 device(s)» or «nothing waits on you: no push».

To switch it off: `launchctl bootout gui/$(id -u)/dev.trialog.morning`.
