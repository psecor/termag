#!/usr/bin/env bash
# Undo install.sh: run the runtime's own webpushd again and delete the patched copy.
set -euo pipefail

export DEVELOPER_DIR=${DEVELOPER_DIR:-$(xcode-select -p)}
udid=$(xcrun simctl list devices booted -j | python3 -c 'import json,sys
d=json.load(sys.stdin)["devices"]
print(next(x["udid"] for v in d.values() for x in v if x["state"]=="Booted"))')
root=$(xcrun simctl getenv "$udid" SIMULATOR_ROOT)
domain="user/$(id -u)"
label=com.apple.webkit.webpushd

xcrun simctl spawn "$udid" launchctl bootout "$domain/$label" 2>/dev/null || true
sleep 3
xcrun simctl spawn "$udid" launchctl bootstrap "$domain" "$root/System/Library/LaunchDaemons/$label.plist"
rm -rf "$HOME/Library/Developer/CoreSimulator/Devices/$udid/data/termag-webpushd"
echo "webpushd restored in simulator $udid"
