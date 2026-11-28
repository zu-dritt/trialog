# Trialog for iPhone

Phase 1 (playground #1036, agreed in #1043): the hub in an app. Everything the browser page does
comes along; the app adds what a page can't do:

- **Sign-in once:** on first start you enter your hub's address and paste your token (a whole
  settings line like `DAVID_TOKEN=…` works too). Both go into the iPhone's Keychain, on this device
  only, and nowhere else.
- **Face ID** (or the phone's passcode) before the hub shows: on a cold start, and after five minutes
  in the background.
- **Push:** the app asks once, gets the phone's push address from Apple, and gives it to the hub
  (`POST /api/push/devices`, with `env` `sandbox` for Xcode builds and `production` for TestFlight,
  and the app's `bundle_id`). The hub sends a push when a message is for you or something waits on you.
- **Links** to other sites open in Safari; the hub and the roadmap stay in the app.

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
