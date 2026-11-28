#!/bin/bash
# Builds the iPhone app and uploads it to TestFlight in one go.
#
#   ios/scripts/testflight.sh
#
# Signs with the Apple account that is signed in to Xcode on this Mac (Xcode → Settings → Accounts).
# Your team and bundle id come from ios/Local.xcconfig (git ignores it; see Local.xcconfig.example).
# Raise CURRENT_PROJECT_VERSION in the project first: App Store Connect refuses a build number twice.
set -euo pipefail
cd "$(dirname "$0")/.."
[ -f Local.xcconfig ] || { echo "ios/Local.xcconfig is missing: copy Local.xcconfig.example and fill it in." >&2; exit 1; }
out="build/testflight-$(date +%Y%m%d-%H%M%S)"
mkdir -p "$out"
cat > "$out/ExportOptions.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>method</key><string>app-store-connect</string>
	<key>destination</key><string>upload</string>
	<key>signingStyle</key><string>automatic</string>
	<key>manageAppVersionAndBuildNumber</key><false/>
</dict>
</plist>
PLIST
echo "Archiving…"
xcodebuild -project Trialog.xcodeproj -scheme Trialog -configuration Release -destination 'generic/platform=iOS' \
  -archivePath "$out/Trialog.xcarchive" -allowProvisioningUpdates archive > "$out/archive.log" 2>&1 \
  || { grep -E "error" "$out/archive.log" | head -20 >&2; echo "Archive failed; the whole log is $out/archive.log" >&2; exit 1; }
echo "Uploading to App Store Connect…"
xcodebuild -exportArchive -archivePath "$out/Trialog.xcarchive" -exportOptionsPlist "$out/ExportOptions.plist" \
  -exportPath "$out/export" -allowProvisioningUpdates > "$out/upload.log" 2>&1 \
  || { grep -E "error" "$out/upload.log" | head -20 >&2; echo "Upload failed; the whole log is $out/upload.log" >&2; exit 1; }
grep -E "EXPORT SUCCEEDED|Uploaded" "$out/upload.log" | tail -2
echo "Done. Apple processes the build for about 5–15 minutes; then it shows in TestFlight."
