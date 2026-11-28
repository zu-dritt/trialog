# Trialog for iPhone

Phase 1 (playground #1036, agreed in #1043): the hub in an app. Everything the browser page does
comes along; the app adds what a page can't do:

- **Sign-in once:** on first start you enter your hub's address and paste your token (a whole
  settings line like `DAVID_TOKEN=…` works too). Both go into the iPhone's Keychain, on this device
  only, and nowhere else. The setup fields start empty (no leftover token).
- **Switch hub:** the ••• button at the top right of the hub screen (a native overlay, not part of
  the page) has «Switch hub…». After you confirm, the app asks the old hub to stop sending pushes to
  this phone (`DELETE /api/push/devices`, best effort), forgets the address and token, and shows the
  setup screen again, empty. The hub page's own «Change token» only swaps the token for the same hub.
  After you sign in to the new hub, push registers with it the same way as on first start
  (`POST /api/push/devices`).
- **A reinstall starts clean.** Deleting the app usually leaves the Keychain items behind, so
  without this the setup screen would not show again. A `didLaunchBefore` flag in UserDefaults
  (wiped with the app) tells a reinstall from a later launch: if the flag is missing, the app
  clears any leftover Keychain account and Setup shows. The first open of the build that
  introduced the flag also sees a missing flag, so it signs you in again once; later upgrades
  keep the hub.
- **Face ID** (or the phone's passcode) before the hub shows: on a cold start, and after five minutes
  in the background.
- **Push:** the app asks once, gets the phone's push address from Apple, and gives it to the hub
  (`POST /api/push/devices`, with `env` `sandbox` for Xcode builds and `production` for TestFlight,
  and the app's `bundle_id`). The hub sends a push when a message is for you or something waits on you.
- **Links** to other sites open in Safari; the hub and the roadmap stay in the app.

Phase 2 (playground #1178):

- **Speak:** a 🎤 Speak button next to Image, only in the app. Apple's speech recognition (on the
  phone when it supports that) turns your words into text as you speak; they go into the message box
  after what you typed, and you read them before Send. Tap Stop, or it stops after a minute.
- **Take Photo:** the Image button offers the camera too (the app now says why it asks).

The hub's address is typed in the app, not built in, so the app works with anyone's hub.

## Build and run

Open `ios/Trialog.xcodeproj` in Xcode (26 or later) and run the «Trialog» scheme on a simulator.
From the command line:

```bash
cd ios
xcodebuild -project Trialog.xcodeproj -scheme Trialog -destination 'platform=iOS Simulator,name=iPhone 17' test
```

To try it, sign in to the public demo hub: `trialog-demo.vercel.app`, token
`demo-orchestrator-public-token`.

In a Simulator without Face ID set up, iOS asks for the passcode instead. Features → Face ID →
Enrolled, then Matching Face, unlocks it.

## Your own signing (never committed)

Copy `Local.xcconfig.example` to `Local.xcconfig` (ignored by git) and fill in your Apple team id and
the App ID you registered. `Shared.xcconfig` includes it.

## Once, in your Apple Developer account

1. Register an App ID (Identifiers → +) with **Push Notifications** on. An App Store Connect API key
   can't do this step.
2. Create an APNs key (Keys → +, Apple Push Notifications service). Download the `.p8` file once and
   put it into the hub's Vercel settings, never into chat or this repository.
3. Create the app in App Store Connect with that bundle id, then upload builds to TestFlight from
   Xcode (Product → Archive), or from the command line with an App Store Connect API key.

## A new TestFlight build

Raise `CURRENT_PROJECT_VERSION` in the project (App Store Connect refuses a number twice), then:

```bash
ios/scripts/testflight.sh
```

It archives, signs with the Apple account signed in to Xcode on this Mac, and uploads. Testers of the
app's internal group get it after Apple's processing, about 5–15 minutes. A new tester accepts the
TestFlight invitation **on the iPhone** (the mail's «View in TestFlight»), not on a computer.
