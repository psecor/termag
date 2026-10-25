#!/usr/bin/env bash
# Make Web Push work in the booted iOS Simulator. Test use only.
#
#   scripts/ios-sim-webpush/install.sh     # run a patched webpushd in the booted simulator
#   scripts/ios-sim-webpush/restore.sh     # put the runtime's own webpushd back
#
# The runtime's com.apple.webkit.webpushd cannot launch (its launch constraint
# fails in the simulator) and carries none of the device build's entitlements,
# so subscribe() never settles. This copies it into the device's data
# directory, writes entitlements.plist into its simulator entitlement sections
# (patch_ents.py; an ad-hoc signature can't carry them, AMFI refuses), ad-hoc
# signs it under its own identifier, and points the launchd job at the copy.
# Nothing outside the simulator device changes; the runtime image is read-only.
#
# Push also needs the simulator's apsd connected to the APNs sandbox. It does
# not recover from a Mac sleep or network change; kick it with
#   xcrun simctl spawn booted launchctl kickstart -k user/$(id -u)/com.apple.apsd
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
export DEVELOPER_DIR=${DEVELOPER_DIR:-$(xcode-select -p)}
udid=$(xcrun simctl list devices booted -j | python3 -c 'import json,sys
d=json.load(sys.stdin)["devices"]
print(next(x["udid"] for v in d.values() for x in v if x["state"]=="Booted"))')
root=$(xcrun simctl getenv "$udid" SIMULATOR_ROOT)
domain="user/$(id -u)"
label=com.apple.webkit.webpushd
dest="$HOME/Library/Developer/CoreSimulator/Devices/$udid/data/termag-webpushd"
src="$root/System/Cryptexes/App/usr/libexec/webpushd"
[ -f "$src" ] || { echo "no webpushd at $src" >&2; exit 1; }

mkdir -p "$dest"
cp "$src" "$dest/webpushd"
chmod u+w "$dest/webpushd"
# codesign renders the entitlements as DER; patch both forms into the binary.
cp "$dest/webpushd" "$dest/der-src"
codesign --force -s - --entitlements "$here/entitlements.plist" "$dest/der-src" 2>/dev/null
codesign -d --entitlements "$dest/entitlements.der" --der "$dest/der-src" 2>/dev/null
rm "$dest/der-src"
codesign --remove-signature "$dest/webpushd"
python3 "$here/patch_ents.py" "$dest/webpushd" "$here/entitlements.plist" "$dest/entitlements.der"
codesign --force -s - --identifier com.apple.webpushd "$dest/webpushd" 2>/dev/null

# launchd_sim prefixes the runtime root to the program path; climb back out of it.
up=$(printf '/..%.0s' $(seq 20))
plutil -convert xml1 -o "$dest/job.plist" "$root/System/Library/LaunchDaemons/$label.plist"
plutil -replace ProgramArguments.0 -string "$up$dest/webpushd" "$dest/job.plist"

xcrun simctl spawn "$udid" launchctl bootout "$domain/$label" 2>/dev/null || true
sleep 3
xcrun simctl spawn "$udid" launchctl bootstrap "$domain" "$dest/job.plist"
xcrun simctl spawn "$udid" launchctl kickstart -p "$domain/$label" >/dev/null
echo "webpushd patched in simulator $udid; restore with $here/restore.sh"
