#!/bin/sh
# Tests the browser pane's guest user setup:
# deploy/termag-guest-browser.nft, its unit and drop-in, the sudoers entry, the
# Chromium wrapper and deploy/termag-guest-browser-setup.
#
# What matters: termag-guest can send nothing but TCP to the pane proxies on
# 127.0.0.1:47100-47131; the agent user may run the one wrapper as the guest,
# with fds 3 and 4 kept; the setup converges and reports drift without
# changing anything under --check; lingering, which starts the guest's user
# manager, is never enabled when an earlier step failed.
#
# When run as root with unshare, ip, nft, setpriv and python3 available, it
# also loads the real ruleset (twice) inside a throwaway network namespace and
# probes TCP and UDP as the guest's uid and another one. Otherwise that part
# prints SKIP, or fails with TERMAG_GUEST_BROWSER_REQUIRE_LIVE=1 (CI).
#
# Run: sh deploy/termag-guest-browser.test.sh
#      sudo TERMAG_GUEST_BROWSER_REQUIRE_LIVE=1 sh deploy/termag-guest-browser.test.sh
set -u

DEPLOY="$(cd "$(dirname "$0")" && pwd)"
RULES="$DEPLOY/termag-guest-browser.nft"
UNIT="$DEPLOY/termag-guest-browser.service"
DROPIN="$DEPLOY/termag-guest-browser-required.conf"
SUDOERS="$DEPLOY/termag-guest-browser.sudoers"
WRAPPER="$DEPLOY/termag-guest-chromium"
SETUP="$DEPLOY/termag-guest-browser-setup"
SYSCTL="$DEPLOY/termag-guest-browser.sysctl"
PACKER="$DEPLOY/../packer/scripts"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

failures=0
fail() {
  echo "FAIL: $1"
  echo "      want: $2"
  echo "      got:  $3"
  failures=$((failures + 1))
}

# ── the ruleset ───────────────────────────────────────────────────────────────
for want in \
  'meta skuid "termag-guest" ip daddr 127.0.0.1 tcp dport 47100-47131 accept' \
  'meta skuid "termag-guest" counter reject' \
  'type filter hook output priority filter; policy accept;'; do
  grep -qF -- "$want" "$RULES" || fail "ruleset: has rule" "$want" "missing"
done
# The accept comes first: nft stops at the first verdict.
got="$(grep -n 'skuid' "$RULES" | cut -d: -f1 | tr '\n' ' ')"
first_accept="$(grep -n 'skuid.*accept' "$RULES" | cut -d: -f1)"
first_reject="$(grep -n 'skuid.*reject' "$RULES" | cut -d: -f1)"
[ "$first_accept" -lt "$first_reject" ] || fail "ruleset: accept before reject" "accept line < reject line" "$got"
# Only the guest's uid is matched: every other rule line names it.
others="$(grep -E '^\s+(ip|ip6|tcp|udp|meta|counter)' "$RULES" | grep -vc 'skuid "termag-guest"')"
[ "$others" = 0 ] || fail "ruleset: matches only termag-guest" 0 "$others"
grep -q 'flush ruleset' "$RULES" && fail "ruleset: leaves other tables alone" "no flush ruleset" "flush ruleset"
got="$(grep -E '^(table|delete table)' "$RULES" | tr '\n' ';')"
want="table inet termag_guest;delete table inet termag_guest;table inet termag_guest {;"
[ "$got" = "$want" ] || fail "ruleset: declare, delete, redefine" "$want" "$got"

# ── the reserved ports ────────────────────────────────────────────────────────
# The range the rule allows is the range reserved, and the one the setup
# merges in live: a port the kernel may hand out for port 0 is no boundary.
range="$(sed -n 's/.*tcp dport \([0-9-]*\) accept.*/\1/p' "$RULES")"
got="$(grep -v '^#' "$SYSCTL" | grep -v '^$')"
[ "$got" = "net.ipv4.ip_local_reserved_ports = $range" ] || fail "sysctl: reserves the rule's range" "net.ipv4.ip_local_reserved_ports = $range" "$got"
grep -qx "PROXY_PORTS=$range" "$SETUP" || fail "setup: reserves the rule's range live" "PROXY_PORTS=$range" "$(grep '^PROXY_PORTS=' "$SETUP")"

# ── the unit and drop-in ──────────────────────────────────────────────────────
installed=/usr/local/lib/termag/termag-guest-browser.nft
for want in "ExecStart=/usr/sbin/nft -f $installed" "ExecReload=/usr/sbin/nft -f $installed" \
  'DefaultDependencies=no' 'Type=oneshot' 'RemainAfterExit=yes' 'WantedBy=multi-user.target'; do
  grep -qx -- "$want" "$UNIT" || fail "unit: $want" "$want" "missing"
done
before="$(grep '^Before=' "$UNIT")"
for t in network-pre.target systemd-user-sessions.service; do
  case " ${before#Before=} " in *" $t "*) ;; *) fail "unit: ordered before $t" "$t in Before=" "$before" ;; esac
done
for want in Requires=termag-guest-browser.service After=termag-guest-browser.service \
  'ExecStartPre=+/usr/bin/systemctl reload termag-guest-browser.service'; do
  grep -qx "$want" "$DROPIN" || fail "drop-in: $want" "$want" "$(grep -vE '^(#|$)' "$DROPIN" | tr '\n' ';')"
done

# ── the sudoers entry ─────────────────────────────────────────────────────────
# The template names the agent user by uid; unrendered, that line is a comment.
got="$(sed 's/@AGENT_UID@/1001/' "$SUDOERS" | grep -vE '^(# |#$|$)')"
want='Defaults!/usr/local/libexec/termag-guest-chromium closefrom_override
#1001 ALL=(termag-guest) NOPASSWD: /usr/local/libexec/termag-guest-chromium'
[ "$got" = "$want" ] || fail "sudoers: the wrapper only, as termag-guest, fds kept" "$want" "$got"
if command -v visudo >/dev/null 2>&1; then
  sed 's/@AGENT_UID@/1001/' "$SUDOERS" >"$WORK/sudoers"
  visudo -cf "$WORK/sudoers" >/dev/null 2>&1 || fail "sudoers: parses once rendered" "visudo -c ok" "$(visudo -cf "$WORK/sudoers" 2>&1)"
fi

# ── the wrapper ───────────────────────────────────────────────────────────────
grep -qx 'CHROMIUM=/snap/bin/chromium' "$WRAPPER" || fail "wrapper: runs snap Chromium" 'CHROMIUM=/snap/bin/chromium' "missing"
grep -qx 'exec "$CHROMIUM" "$@"' "$WRAPPER" || fail "wrapper: passes its arguments through" 'exec "$CHROMIUM" "$@"' "missing"
for want in 'XDG_RUNTIME_DIR="/run/user/$uid"' 'DBUS_SESSION_BUS_ADDRESS="unix:path=$XDG_RUNTIME_DIR/bus"'; do
  grep -qF -- "$want" "$WRAPPER" || fail "wrapper: sets $want" "$want" "missing"
done
if [ "$(id -un)" != termag-guest ]; then
  env -u TERMAG_GUEST_CHROMIUM_TEST_HOME sh "$WRAPPER" --version >/dev/null 2>&1
  got=$?
  [ "$got" = 64 ] || fail "wrapper: refuses any user but termag-guest" 64 "$got"

  # Its launch rules and maintenance modes, against a scratch home and a stub Chromium.
  GH="$WORK/guest-home"; P="$GH/snap/chromium/common/termag-browser-pane/profiles"
  mkdir -p "$GH"
  printf '#!/bin/sh\nprintf "%%s\\n" "$@" > "%s/chromium-args"\n' "$WORK" > "$WORK/fake-chromium"
  chmod 755 "$WORK/fake-chromium"
  wrap() { TERMAG_GUEST_CHROMIUM_TEST_HOME="$GH" TERMAG_GUEST_CHROMIUM_TEST_BIN="$WORK/fake-chromium" sh "$WRAPPER" "$@"; }
  wrap --headless=new --user-data-dir=/tmp/elsewhere >/dev/null 2>&1; got=$?
  [ "$got" = 65 ] || fail "wrapper: refuses a profile outside the root" 65 "$got"
  wrap --headless=new "--user-data-dir=$P/../escape" >/dev/null 2>&1; got=$?
  [ "$got" = 65 ] || fail "wrapper: refuses a profile name that leaves the root" 65 "$got"
  wrap --headless=new >/dev/null 2>&1; got=$?
  [ "$got" = 65 ] || fail "wrapper: refuses a launch with no profile" 65 "$got"
  [ -e "$WORK/chromium-args" ] && fail "wrapper: launches nothing it refused" "no launch" "launched"
  wrap --headless=new "--user-data-dir=$P/abc_1" >/dev/null 2>&1; got=$?
  [ "$got" = 0 ] || fail "wrapper: launches with a profile under the root" 0 "$got"
  grep -qx -- "--user-data-dir=$P/abc_1" "$WORK/chromium-args" 2>/dev/null || fail "wrapper: passes the arguments to Chromium" "--user-data-dir=…/abc_1" "$(cat "$WORK/chromium-args" 2>/dev/null)"
  grep -q '"ip_handling_policy":"disable_non_proxied_udp"' "$P/abc_1/Default/Preferences" 2>/dev/null \
    || fail "wrapper: seeds the WebRTC policy into a new profile" disable_non_proxied_udp "$(cat "$P/abc_1/Default/Preferences" 2>/dev/null)"
  got="$(stat -c %a "$P" "$P/abc_1" | tr '\n' ' ')"
  [ "$got" = "700 700 " ] || fail "wrapper: profile root and profile are 0700" "700 700" "$got"
  # A profile that lost the policy is reseeded; one that has it is left alone.
  echo '{"other":1}' > "$P/abc_1/Default/Preferences"
  wrap "--user-data-dir=$P/abc_1" >/dev/null 2>&1
  grep -q disable_non_proxied_udp "$P/abc_1/Default/Preferences" || fail "wrapper: reseeds a profile without the policy" reseeded "$(cat "$P/abc_1/Default/Preferences")"
  echo '{"webrtc":{"ip_handling_policy":"disable_non_proxied_udp"},"kept":1}' > "$P/abc_1/Default/Preferences"
  wrap "--user-data-dir=$P/abc_1" >/dev/null 2>&1
  grep -q '"kept":1' "$P/abc_1/Default/Preferences" || fail "wrapper: keeps a profile that has the policy" kept "$(cat "$P/abc_1/Default/Preferences")"
  # However the JSON is spaced.
  printf '{\n   "webrtc": {\n      "ip_handling_policy": "disable_non_proxied_udp"\n   },\n   "kept": 2\n}\n' > "$P/abc_1/Default/Preferences"
  wrap "--user-data-dir=$P/abc_1" >/dev/null 2>&1
  grep -q '"kept": 2' "$P/abc_1/Default/Preferences" || fail "wrapper: keeps a pretty-printed profile that has the policy" kept "$(cat "$P/abc_1/Default/Preferences")"
  got="$(wrap --termag-list | awk '{print $1, $3}')"
  [ "$got" = "abc_1 0" ] || fail "wrapper: lists profiles, not held" "abc_1 0" "$got"
  # Held by a live process (this shell): listed as held, and never forgotten.
  ln -s "host-$$" "$P/abc_1/SingletonLock"
  got="$(wrap --termag-list | awk '{print $3}')"
  [ "$got" = 1 ] || fail "wrapper: a profile a live process holds is listed as held" 1 "$got"
  wrap --termag-forget abc_1 >/dev/null 2>&1; got=$?
  [ "$got" = 66 ] && [ -d "$P/abc_1" ] || fail "wrapper: refuses to forget a held profile" "66, kept" "$got"
  rm "$P/abc_1/SingletonLock"; ln -s "host-999999" "$P/abc_1/SingletonLock"
  got="$(wrap --termag-list | awk '{print $3}')"
  [ "$got" = 0 ] || fail "wrapper: a stale lock is not held" 0 "$got"
  wrap --termag-forget '../abc_1' >/dev/null 2>&1; got=$?
  [ "$got" = 65 ] || fail "wrapper: refuses a bad name to forget" 65 "$got"
  wrap --termag-forget abc_1; got=$?
  [ "$got" = 0 ] && [ ! -e "$P/abc_1" ] || fail "wrapper: forgets a profile" "0, gone" "$got, $(ls "$P")"
fi

# ── the bake wires it ─────────────────────────────────────────────────────────
grep -qF 'sudo bash /home/termag/src/termag/deploy/termag-guest-browser-setup --agent-user termag' "$PACKER/box-lib.sh" \
  || fail "box-lib.sh: runs the guest browser setup for termag" "termag-guest-browser-setup --agent-user termag" "missing"
# Both bakes, full and incremental, after the checkout and the box marker.
for f in setup.sh refresh-box.sh; do
  grep -A1 -x 'install_box_marker' "$PACKER/$f" | grep -qx 'install_guest_browser' \
    || fail "$f: installs the guest browser after the box marker" install_guest_browser "missing"
done

# ── the setup script, against a scratch root ──────────────────────────────────
# getent, id, useradd, gpasswd, chmod-free: the guest is faked from files in
# $FAKE; anything about another user falls through to the real commands.
STUB="$WORK/stub"; FAKE="$WORK/fake"; ROOT="$WORK/root"; HOMEDIR="$WORK/home-guest"
mkdir -p "$STUB" "$FAKE" "$ROOT"
cat >"$STUB/getent" <<'EOF'
#!/bin/sh
if [ "$1 $2" = "passwd termag-guest" ]; then
  [ -f "$FAKE/exists" ] || exit 2
  echo "termag-guest:x:4242:4242::$HOMEDIR:/usr/sbin/nologin"; exit 0
fi
exec /usr/bin/getent "$@"
EOF
cat >"$STUB/id" <<'EOF'
#!/bin/sh
case "$*" in
  "-u termag-guest") [ -f "$FAKE/exists" ] && { echo 4242; exit 0; }; exit 1 ;;
  "-nG termag-guest") [ -f "$FAKE/exists" ] || exit 1; cat "$FAKE/groups"; exit 0 ;;
  "-u termag-agent-test") echo 4100; exit 0 ;;
esac
exec /usr/bin/id "$@"
EOF
cat >"$STUB/useradd" <<'EOF'
#!/bin/sh
echo "useradd $*" >>"$FAKE/log"; touch "$FAKE/exists"; echo termag-guest >"$FAKE/groups"; mkdir -p "$HOMEDIR"; chmod 755 "$HOMEDIR"
EOF
cat >"$STUB/gpasswd" <<'EOF'
#!/bin/sh
echo "gpasswd $*" >>"$FAKE/log"; echo termag-guest >"$FAKE/groups"
EOF
cat >"$STUB/visudo" <<'EOF'
#!/bin/sh
echo "visudo $*" >>"$FAKE/log"; [ ! -f "$FAKE/bad-sudoers" ]
EOF
chmod 755 "$STUB"/*
: >"$FAKE/log"
export FAKE HOMEDIR
setup() { TERMAG_GUEST_SETUP_ROOT="$ROOT" PATH="$STUB:$PATH" bash "$SETUP" --agent-user termag-agent-test "$@"; }

# No usable agent user: refused before anything runs.
TERMAG_GUEST_SETUP_ROOT="$ROOT" PATH="$STUB:$PATH" bash "$SETUP" --agent-user termag-no-such-user --check >/dev/null 2>&1
rc=$?
[ "$rc" = 2 ] || fail "setup: refuses an agent user that doesn't exist" 2 "$rc"


# A fresh box: --check names everything and changes nothing.
out="$(setup --check 2>&1)"; rc=$?
[ "$rc" = 1 ] || fail "setup --check: a fresh box is drift" 1 "$rc"
for want in 'DRIFT: user termag-guest is missing' 'DRIFT: /usr/local/libexec/termag-guest-chromium is missing' \
  'DRIFT: /etc/sudoers.d/termag-guest-browser is missing' "DRIFT: $installed is missing" \
  'DRIFT: /etc/systemd/system/termag-guest-browser.service is missing' \
  'DRIFT: /etc/sysctl.d/60-termag-guest-browser.conf is missing'; do
  case "$out" in *"$want"*) ;; *) fail "setup --check: reports" "$want" "$out" ;; esac
done
[ -s "$FAKE/log" ] && fail "setup --check: runs nothing" "empty log" "$(cat "$FAKE/log")"
[ -n "$(find "$ROOT" -type f)" ] && fail "setup --check: writes nothing" "no files" "$(find "$ROOT" -type f)"

# Apply: the user, then every file with its mode, the drop-in under the guest's uid.
out="$(setup 2>&1)"; rc=$?
[ "$rc" = 0 ] || fail "setup: applies" 0 "$rc: $out"
grep -q 'useradd --system --create-home --home-dir /home/termag-guest --shell /usr/sbin/nologin --user-group termag-guest' "$FAKE/log" \
  || fail "setup: creates a system user with no shell" "useradd --system … --shell /usr/sbin/nologin" "$(cat "$FAKE/log")"
for pair in /usr/local/libexec/termag-guest-chromium:755 /etc/sudoers.d/termag-guest-browser:440 \
  "$installed:644" /etc/systemd/system/termag-guest-browser.service:644 \
  /etc/systemd/system/user@4242.service.d/termag-guest-browser.conf:644 \
  /etc/sysctl.d/60-termag-guest-browser.conf:644; do
  f="${pair%:*}" mode="${pair##*:}"
  got="$(stat -c %a "$ROOT$f" 2>/dev/null)"
  [ "$got" = "$mode" ] || fail "setup: installs $f $mode" "$mode" "${got:-missing}"
done
grep -q 'visudo -cf .*/termag-guest-browser.sudoers' "$FAKE/log" || fail "setup: checks the sudoers entry before installing it" "visudo -cf" "$(cat "$FAKE/log")"
got="$(grep -v '^#[^0-9]' "$ROOT/etc/sudoers.d/termag-guest-browser" | grep -v '^$' | tail -1)"
[ "$got" = '#4100 ALL=(termag-guest) NOPASSWD: /usr/local/libexec/termag-guest-chromium' ] \
  || fail "setup: names the agent user by uid" '#4100 ALL=(termag-guest) …' "$got"
got="$(stat -c %a "$HOMEDIR")"
[ "$got" = 700 ] || fail "setup: the guest's home is 0700" 700 "$got"

# Current: silent, exit 0.
out="$(setup --check 2>&1)"; rc=$?
[ "$rc" = 0 ] || fail "setup --check: a set-up box is no drift" "0, no output" "$rc: $out"
out="$(setup 2>&1)"
[ -z "$out" ] || fail "setup: a set-up box writes nothing" "no output" "$out"

# Drift in one file is reported alone and healed.
echo '# edited' >>"$ROOT$installed"
out="$(setup --check 2>&1)"
[ "$out" = "DRIFT: $installed differs from termag-guest-browser.nft" ] || fail "setup --check: one drifted file" "DRIFT: $installed differs…" "$out"
setup >/dev/null 2>&1
cmp -s "$RULES" "$ROOT$installed" || fail "setup: heals a drifted file" "same as source" "differs"

# The guest in the agent user's group, or a readable home: both healed.
echo 'termag-guest termag-agent-test' >"$FAKE/groups"; chmod 755 "$HOMEDIR"
out="$(setup --check 2>&1)"
case "$out" in *'DRIFT: termag-guest is in group termag-agent-test'*"DRIFT: $HOMEDIR is not 0700"*|*"DRIFT: $HOMEDIR is not 0700"*'DRIFT: termag-guest is in group termag-agent-test'*) ;;
  *) fail "setup --check: group and home" "both reported" "$out" ;; esac
setup >/dev/null 2>&1
grep -q 'gpasswd -d termag-guest termag-agent-test' "$FAKE/log" || fail "setup: removes the guest from the agent group" "gpasswd -d termag-guest termag-agent-test" "$(cat "$FAKE/log")"
got="$(stat -c %a "$HOMEDIR")"
[ "$got" = 700 ] || fail "setup: heals the home mode" 700 "$got"

# A guest whose home is gone: drift, and recreated 0700.
rm -rf "$HOMEDIR"
out="$(setup --check 2>&1)"
[ "$out" = "DRIFT: $HOMEDIR is missing" ] || fail "setup --check: a missing guest home" "DRIFT: $HOMEDIR is missing" "$out"
setup >/dev/null 2>&1
got="$(stat -c %a "$HOMEDIR" 2>/dev/null)"
[ "$got" = 700 ] || fail "setup: recreates a missing guest home 0700" 700 "${got:-missing}"
grep -qF 'install -d -m 0700 -o "$GUEST" -g "$GUEST" "$home"' "$SETUP" || fail "setup: a recreated home is the guest's" 'install -d … -o "$GUEST"' "missing"

# A sudoers entry visudo rejects is never installed, and the run fails.
rm -f "$ROOT/etc/sudoers.d/termag-guest-browser"; touch "$FAKE/bad-sudoers"
setup >/dev/null 2>&1; rc=$?
[ "$rc" = 1 ] || fail "setup: a bad sudoers entry fails the run" 1 "$rc"
[ -e "$ROOT/etc/sudoers.d/termag-guest-browser" ] && fail "setup: a bad sudoers entry is not installed" absent present
rm -f "$FAKE/bad-sudoers"

# Lingering comes last and never after a failure (read from the script: the
# test root stops before systemd).
linger="$(grep -n 'loginctl enable-linger' "$SETUP" | cut -d: -f1)"
for step in 'systemctl start "$unit"' 'install_owned -m'; do
  at="$(grep -nF "$step" "$SETUP" | head -1 | cut -d: -f1)"
  [ -n "$at" ] && [ "$linger" -gt "$at" ] || fail "setup: lingering after $step" "line > ${at:-?}" "${linger:-missing}"
done
# nftables is made sure of, and its flushing ruleset service kept off, before the unit starts.
for want in 'apt-get update -qq' 'apt-get install -y -qq nftables' 'systemctl disable nftables.service'; do
  grep -qF "$want" "$SETUP" || fail "setup: $want" "$want" "missing"
done
update_at="$(grep -nF 'apt-get update -qq' "$SETUP" | cut -d: -f1)"
nft_at="$(grep -nF 'apt-get install -y -qq nftables' "$SETUP" | cut -d: -f1)"
[ "$update_at" -le "$nft_at" ] || fail "setup: the package index is fetched before nftables is installed" "update before install" "$update_at > $nft_at"
start_at="$(grep -nF 'systemctl start "$unit"' "$SETUP" | cut -d: -f1)"
[ "$nft_at" -lt "$start_at" ] || fail "setup: nftables before the unit starts" "line < $start_at" "$nft_at"
grep -qF 'not enabling lingering for $GUEST: an earlier step failed' "$SETUP" \
  || fail "setup: no lingering after a failed step" "guarded on \$failed" "missing"

# ── real rules in a throwaway network namespace ───────────────────────────────
live=1
[ "$(/usr/bin/id -u)" -eq 0 ] || live=0
for c in unshare ip nft setpriv python3; do
  command -v "$c" >/dev/null 2>&1 || live=0
done
if [ "$live" -eq 1 ]; then
  cat >"$WORK/probe.py" <<'EOF'
import socket, sys
proto, host, port = sys.argv[1], sys.argv[2], int(sys.argv[3])
fam = socket.AF_INET6 if ":" in host else socket.AF_INET
try:
    if proto == "tcp":
        socket.create_connection((host, port), timeout=2).close()
    else:
        s = socket.socket(fam, socket.SOCK_DGRAM); s.settimeout(2)
        s.connect((host, port)); s.send(b"x"); s.recv(16)
    print("open")
except ConnectionRefusedError:
    print("refused")
except PermissionError:
    # A UDP datagram the local reject drops fails at send() with EPERM.
    print("eperm")
except OSError as e:
    print("error-%s" % e.__class__.__name__)
EOF
  cat >"$WORK/udp_echo.py" <<'EOF'
import socket, sys
s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM); s.bind(("127.0.0.1", int(sys.argv[1])))
while True:
    d, a = s.recvfrom(16); s.sendto(d, a)
EOF
  sed 's/skuid "termag-guest"/skuid 4242/' "$RULES" >"$WORK/rules.nft"
  chmod 755 "$WORK"; chmod 644 "$WORK"/*.py "$WORK/rules.nft"
  cat >"$WORK/live.sh" <<EOF
set -u
ip link set lo up
cd "$WORK"
pids=""
for a in 127.0.0.1:47100 127.0.0.1:47131 127.0.0.1:47132 127.0.0.1:8080 127.0.0.2:80; do
  python3 -c "import socket,sys; s=socket.socket(); s.setsockopt(socket.SOL_SOCKET,socket.SO_REUSEADDR,1); s.bind((sys.argv[1],int(sys.argv[2]))); s.listen(8)
while True: s.accept()[0].close()" "\${a%:*}" "\${a#*:}" &
  pids="\$pids \$!"
done
python3 -c "import socket; s=socket.socket(socket.AF_INET6); s.bind(('::1',8080)); s.listen(8)
while True: s.accept()[0].close()" &
pids="\$pids \$!"
python3 udp_echo.py 5353 &
pids="\$pids \$!"
trap 'kill \$pids 2>/dev/null' EXIT
sleep 0.5
nft -f rules.nft && nft -f rules.nft || { echo "load failed"; exit 1; }
echo "rules \$(nft list table inet termag_guest | grep -c skuid)"
for probe in tcp:127.0.0.1:47100 tcp:127.0.0.1:47131 tcp:127.0.0.1:47132 tcp:127.0.0.1:8080 tcp:127.0.0.2:80 tcp:::1:8080 udp:127.0.0.1:5353; do
  proto=\${probe%%:*} rest=\${probe#*:} host=\${rest%:*} port=\${rest##*:}
  for uid in 4242 4243; do
    echo "\$probe \$uid \$(setpriv --reuid=\$uid --regid=\$uid --clear-groups python3 probe.py \$proto \$host \$port)"
  done
done
EOF
  unshare -n sh "$WORK/live.sh" >"$WORK/live.out" 2>&1
  got="$(awk '$1 == "rules" { print $2 }' "$WORK/live.out")"
  [ "$got" = 2 ] || fail "live: reloading replaces, not stacks" "2 skuid rules" "${got:-$(cat "$WORK/live.out")}"
  for want in tcp:127.0.0.1:47100:4242:open tcp:127.0.0.1:47131:4242:open \
    tcp:127.0.0.1:47132:4242:refused tcp:127.0.0.1:8080:4242:refused tcp:127.0.0.2:80:4242:refused \
    tcp:::1:8080:4242:refused udp:127.0.0.1:5353:4242:eperm \
    tcp:127.0.0.1:8080:4243:open tcp:127.0.0.2:80:4243:open tcp:::1:8080:4243:open udp:127.0.0.1:5353:4243:open; do
    probe="${want%:*:*}" rest="${want#"$probe":}" uid="${rest%%:*}" expect="${rest#*:}"
    got="$(awk -v p="$probe" -v u="$uid" '$1 == p && $2 == u { print $3 }' "$WORK/live.out")"
    [ "$got" = "$expect" ] || fail "live: uid $uid $probe" "$expect" "${got:-$(cat "$WORK/live.out")}"
  done
  echo "termag-guest-browser: live network-namespace checks ran"
elif [ "${TERMAG_GUEST_BROWSER_REQUIRE_LIVE:-}" = 1 ]; then
  fail "live checks ran" "root, unshare, ip, nft, setpriv, python3" "skipped"
else
  echo "termag-guest-browser: SKIP live checks (need root, unshare, ip, nft, setpriv, python3)"
fi

if [ "$failures" -eq 0 ]; then
  echo "termag-guest-browser: all tests passed"
else
  echo "termag-guest-browser: $failures failure(s)"
  exit 1
fi
