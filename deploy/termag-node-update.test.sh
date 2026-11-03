#!/bin/sh
# Tests deploy/termag-node-update, the box's Node updater,
# on deploy/termag-tool-update-lib, with nodejs.org and the
# orchestrator (curl), nvm (a stand-in nvm.sh), Node's own npm (in the fake
# releases), systemctl (the agent's unit) and tmux stubbed, and real gpgv
# against a throwaway signing key:
#
#   * --run asks for node's policy (component=node), token on curl's stdin
#   * an exact target in the installed major: SHASUMS256.txt verified with the
#     pinned key, the tarball with its SHA-256, unpacked into a hidden staging
#     directory, every npm global (but npm and corepack) reinstalled at its
#     exact version (pi with --ignore-scripts) and verified, then moved into
#     versions/node, made the default, and the agent restarted on it; the old
#     Node stays installed; latest is the newest of the installed major
#   * another major, an unsigned or tampered SHASUMS256.txt, a key that is not
#     pinned, a keys file that is not exactly the pinned keys, a tarball that
#     does not match its sum, an npm install that fails, a tool that says
#     another version: nothing changes, no staging directory is left, the
#     default stays
#   * the agent's guards (KillMode, a live cloud session, the launcher): the
#     switch stands, the restart waits; an agent that does not come up on the
#     new Node: the old default back, the agent on it, rejected (exit 3)
#   * another tool's update holding its lock, no policy, run null, a version
#     dir already there, and usage: nothing installed
#
# Run: sh deploy/termag-node-update.test.sh
set -u

DIR="$(cd "$(dirname "$0")" && pwd)"
SCRIPT="$DIR/termag-node-update"
WORK="$(mktemp -d)"
cleanup() { p=$(cat "$WORK/state/agent-pid" 2>/dev/null); [ "${p:-0}" -gt 1 ] 2>/dev/null && kill "$p" 2>/dev/null; rm -rf "$WORK"; }
trap cleanup EXIT

failures=0
fail() {
  echo "FAIL: $1"
  echo "      want: $2"
  echo "      got:  $3"
  failures=$((failures + 1))
}
has() { case "$2" in *"$3"*) : ;; *) fail "$1" "$3" "$2" ;; esac; }
lacks() { case "$2" in *"$3"*) fail "$1" "(no '$3')" "$2" ;; esac; }
for c in flock jq gpg gpgv xz sha256sum; do
  command -v "$c" >/dev/null 2>&1 || { echo "SKIP: $c is required for this test"; exit 0; }
done

HOME_DIR="$WORK/home"
STUB="$WORK/stub"
STATE="$WORK/state"
SRV="$WORK/srv"
NVM="$HOME_DIR/.nvm"
VERS="$NVM/versions/node"
LOG="$WORK/calls"
mkdir -p "$HOME_DIR/.termag" "$HOME_DIR/.local/share/termag" "$STUB" "$STATE" "$SRV" "$VERS" "$NVM/alias"
export STATE SRV LOG VERS
case "$(uname -m)" in x86_64|amd64) ARCH=x64 ;; *) ARCH=arm64 ;; esac
OLD=24.22.1 NEW=24.22.2 NEXTMAJ=25.1.0

# ── keys ────────────────────────────────────────────────────────────────────
G="$WORK/gnupg"; mkdir -m 0700 "$G"
gpg --homedir "$G" --batch --passphrase '' --quick-gen-key 'node release test <rel@example.test>' ed25519 sign never 2>/dev/null
gpg --homedir "$G" --batch --passphrase '' --quick-gen-key 'not a releaser <other@example.test>' ed25519 sign never 2>/dev/null
fpr() { gpg --homedir "$G" --batch --with-colons --fingerprint "$1" 2>/dev/null | awk -F: '$1 == "fpr" { print $10; exit }'; }
FP=$(fpr rel@example.test) OTHER=$(fpr other@example.test)
KEYS="$HOME_DIR/.local/share/termag/termag-node-release-keys.asc"
gpg --homedir "$G" --batch --armor --export "$FP" > "$KEYS"

# ── fake releases ───────────────────────────────────────────────────────────
# mkrel VERSION: node-v<V>-linux-<arch>.tar.xz with bin/node (says v<V>) and
# bin/npm: `ls -g --depth=0 --json` lists its prefix's packages (and its own
# npm and corepack); `install -g --prefix P [flags] name@ver` writes the
# package under P (fails while $STATE/npm-fails-<name> exists) and, for the
# three tools, a bin that says its version ($STATE/says-<bin> instead, if set).
mkrel() {
  v=$1 d="$WORK/rel/node-v$1-linux-$ARCH"
  rm -rf "$WORK/rel"; mkdir -p "$d/bin" "$d/lib/node_modules/npm" "$d/lib/node_modules/corepack" "$SRV/v$v"
  printf '{"name":"npm","version":"11.19.1"}\n' > "$d/lib/node_modules/npm/package.json"
  printf '{"name":"corepack","version":"0.36.0"}\n' > "$d/lib/node_modules/corepack/package.json"
  printf '#!/bin/sh\n[ "$1" = --version ] && { echo v%s; exit 0; }\nexec sleep 300\n' "$v" > "$d/bin/node"
  cat > "$d/bin/npm" <<'EOF'
#!/bin/sh
me=$(cd "$(dirname "$0")/.." && pwd)
echo "npm[$me] $*" >> "$LOG"
case "$1" in
  ls)
    [ -e "$STATE/npm-ls-fails" ] && exit 1
    printf '{"dependencies":{'
    sep=
    for p in "$me"/lib/node_modules/* "$me"/lib/node_modules/@*/*; do
      [ -f "$p/package.json" ] || continue
      n=${p#"$me"/lib/node_modules/}
      [ -e "$STATE/npm-ls-omits" ] && [ "$n" = left-pad ] && continue
      [ -e "$STATE/npm-ls-renames" ] && [ "$n" = left-pad ] && n=right-pad
      v=$(sed -n 's/.*"version":"\([^"]*\)".*/\1/p' "$p/package.json")
      printf '%s"%s":{"version":"%s"}' "$sep" "$n" "$v"; sep=,
    done
    printf '}}\n' ;;
  install)
    prefix= spec=
    while [ $# -gt 0 ]; do case "$1" in --prefix) prefix=$2; shift ;; -*|install) ;; *) spec=$1 ;; esac; shift; done
    name=${spec%@*} v=${spec##*@}
    [ -e "$STATE/npm-fails-$(echo "$name" | tr / _)" ] && { echo "npm ERR! boom" >&2; exit 1; }
    mkdir -p "$prefix/lib/node_modules/$name" "$prefix/bin"
    # Claude Code's package declares a postinstall, as the real one does.
    sc=; [ "$name" = @anthropic-ai/claude-code ] && sc=',"scripts":{"postinstall":"node install.cjs"}'
    printf '{"name":"%s","version":"%s"%s}\n' "$name" "$v" "$sc" > "$prefix/lib/node_modules/$name/package.json"
    case "$name" in @anthropic-ai/claude-code) b=claude ;; @openai/codex) b=codex ;; @earendil-works/pi-coding-agent) b=pi ;; *) b= ;; esac
    # The bin inside the package, linked from bin/ as npm links it.
    if [ -n "$b" ]; then
      printf '#!/bin/sh\n[ -s "$STATE/says-%s" ] && { cat "$STATE/says-%s"; exit 0; }\necho "%s %s"\n' "$b" "$b" "$b" "$v" > "$prefix/lib/node_modules/$name/$b-cli"; chmod +x "$prefix/lib/node_modules/$name/$b-cli"
      ln -sfn "../lib/node_modules/$name/$b-cli" "$prefix/bin/$b"
    fi ;;
esac
EOF
  chmod +x "$d/bin/node" "$d/bin/npm"
  tar -cJf "$SRV/v$v/node-v$v-linux-$ARCH.tar.xz" -C "$WORK/rel" "node-v$v-linux-$ARCH"
  ( cd "$SRV/v$v" && sha256sum "node-v$v-linux-$ARCH.tar.xz" > SHASUMS256.txt )
  gpg --homedir "$G" --batch --yes --local-user "${SIGNER:-$FP}" --detach-sign -o "$SRV/v$v/SHASUMS256.txt.sig" "$SRV/v$v/SHASUMS256.txt" 2>/dev/null
}
for v in "$OLD" "$NEW" "$NEXTMAJ"; do mkrel "$v"; done
# An rc of the major listed first, as index.json can: latest is never it (Bugbot on #1113).
printf '[{"version":"v%s"},{"version":"v24.23.0-rc.1"},{"version":"v%s"},{"version":"v%s"},{"version":"v24.21.0"}]\n' "$NEXTMAJ" "$NEW" "$OLD" > "$SRV/index.json"

# The box: Node OLD the nvm default, with the image's npm globals and one more.
GLOBALS='@anthropic-ai/claude-code@2.1.312 @openai/codex@0.165.0 @earendil-works/pi-coding-agent@1.0.2 left-pad@1.3.0'
installed() {
  rm -rf "$VERS"; mkdir -p "$VERS/v$OLD"
  tar -xJf "$SRV/v$OLD/node-v$OLD-linux-$ARCH.tar.xz" -C "$VERS/v$OLD" --strip-components=1
  for g in $GLOBALS; do "$VERS/v$OLD/bin/npm" install -g --prefix "$VERS/v$OLD" "$g" >/dev/null; done
  echo "$OLD" > "$NVM/alias/default"
  : > "$LOG"
}
# nvm: version default (the alias file's version, when installed), alias default X.
cat > "$NVM/nvm.sh" <<'EOF'
nvm() {
  case "$1 $2" in
    'version default') v=$(cat "$NVM_DIR/alias/default" 2>/dev/null); [ -x "$NVM_DIR/versions/node/v$v/bin/node" ] && { echo "v$v"; return 0; }; echo N/A; return 3 ;;
    'alias default') [ -e "$STATE/nvm-alias-fails" ] && return 1
      # $STATE/nvm-alias-stuck: the first alias written but reported failed, every later one refused.
      if [ -e "$STATE/nvm-alias-stuck" ]; then [ -e "$STATE/nvm-alias-stuck-done" ] && return 1; : > "$STATE/nvm-alias-stuck-done"; echo "$3" > "$NVM_DIR/alias/default"; return 1; fi
      [ -e "$STATE/nvm-slow" ] && sleep 6; echo "$3" > "$NVM_DIR/alias/default"
      # $STATE/nvm-slow-after: the alias written, then slow to return.
      [ -e "$STATE/nvm-slow-after" ] && sleep 6; : ;;
  esac
}
EOF

# ── stubs ───────────────────────────────────────────────────────────────────
cat > "$STUB/curl" <<'EOF'
#!/bin/sh
echo "curl $*" >> "$STATE/curl-args"
out=/dev/stdout data= method=GET url=
while [ $# -gt 0 ]; do
  case "$1" in
    -o) out=$2; shift ;;
    --data-binary) data=$2; shift ;;
    -X) method=$2; shift ;;
    -K) [ "$2" = - ] && cat > "$STATE/curl-config"; shift ;;
    -m|-w|-H|--proto) shift ;;
    -*) ;;
    *) url=$1 ;;
  esac
  shift
done
echo "$method $url" >> "$STATE/curl-calls"
case "$url" in
  https://nodejs.example.test/dist/*)
    f="$SRV/${url#https://nodejs.example.test/dist/}"; [ -f "$f" ] || exit 22
    cat "$f" > "$out" ;;
  */tool-update/policy\?*)
    cat "$STATE/policy-body" > "$out"; printf '%s' "$(cat "$STATE/policy-code")" ;;
  */tool-update/report)
    printf '%s\n' "$data" > "$STATE/report-body"; : > "$out"; printf 204 ;;
  *) exit 6 ;;
esac
EOF
# systemctl --user for the agent's unit: active, run-node.sh, KillMode=process
# unless $STATE says otherwise; restart starts a process whose argv[0] is the
# default's node (run-node.sh execs it), none while $STATE/agent-fails-<v>.
cat > "$STUB/systemctl" <<'EOF'
#!/bin/sh
[ "$1" = --user ] && shift
case "$1" in
  is-active) cat "$STATE/agent-active" 2>/dev/null || echo active ;;
  show)
    case "$3" in
      ExecStart) [ -e "$STATE/bad-launcher" ] && echo '{ path=/usr/bin/node ; argv[]=/usr/bin/node agent.js }' || echo '{ path=/bin/bash ; argv[]=/bin/bash $HOME/src/termag/agent/run-node.sh agent.js }' ;;
      KillMode) cat "$STATE/killmode" 2>/dev/null || echo process ;;
      MainPID) cat "$STATE/agent-pid" 2>/dev/null || echo 0 ;;
    esac ;;
  restart)
    [ -e "$STATE/restart-slow" ] && sleep 6
    echo "restart $2" >> "$STATE/restarts"
    p=$(cat "$STATE/agent-pid" 2>/dev/null); [ "${p:-0}" -gt 1 ] 2>/dev/null && kill "$p" 2>/dev/null
    v=$(cat "$HOME/.nvm/alias/default")
    if [ -e "$STATE/agent-fails-$v" ]; then echo 0 > "$STATE/agent-pid"; echo failed > "$STATE/agent-active"; exit 0; fi
    echo active > "$STATE/agent-active"
    # As systemd starts it: no descriptor of the caller's (the run's locks) open.
    nohup bash -c "exec -a '$VERS/v$v/bin/node' sleep 300" >/dev/null 2>&1 6>&- 7>&- 8>&- 9>&- &
    echo $! > "$STATE/agent-pid" ;;
esac
EOF
cat > "$STUB/tmux" <<'EOF'
#!/bin/sh
[ "$1" = list-sessions ] && cat "$STATE/sessions" 2>/dev/null
exit 0
EOF
# mv: the real one, slow to return after renaming a staging directory into
# place while $STATE/mv-slow exists (a signal lands right after the rename).
cat > "$STUB/mv" <<'EOF'
#!/bin/sh
/bin/mv "$@" || exit
case "$*" in *"/.termag-v"*) [ -e "$STATE/mv-slow" ] && sleep 5 ;; esac
exit 0
EOF
chmod +x "$STUB/mv"
# run-node.sh --print-node: nvm's default's node, or $STATE/checkout-node.
cat > "$STUB/run-node.sh" <<'EOF'
[ "$1" = --print-node ] || exit 2
[ -e "$STATE/launcher-fails" ] && exit 127
[ -s "$STATE/checkout-node" ] && { cat "$STATE/checkout-node"; exit 0; }
printf '%s/v%s/bin/node\n' "$VERS" "$(cat "$HOME/.nvm/alias/default")"
EOF
chmod +x "$STUB/curl" "$STUB/systemctl" "$STUB/tmux"

RUN_ID=cmvtrun0000000000000000008
printf '{"token":"tmag_box_token","termag_url":"wss://orch.example.test/termag/ws/agent"}\n' > "$WORK/agent.config.json"
policy() {  # policy CODE [TARGET [RUN]]
  printf '%s' "$1" > "$STATE/policy-code"
  printf '{"floor":"24.22.1","target":"%s","restart":"idle","drainSec":5,"run":%s}' "${2:-$NEW}" "${3:-{\"id\":\"$RUN_ID\",\"component\":\"node\"\}}" > "$STATE/policy-body"
}
reset() {
  rm -f "$STATE/checkout-node" "$STATE/mv-slow" "$STATE/nvm-alias-stuck" "$STATE/nvm-alias-stuck-done" "$STATE/nvm-slow" "$STATE/nvm-slow-after" "$STATE/restart-slow" "$STATE"/npm-fails-* "$STATE/npm-ls-fails" "$STATE/npm-ls-omits" "$STATE/npm-ls-renames" "$STATE"/says-* "$STATE"/agent-fails-* "$STATE/killmode" "$STATE/bad-launcher" "$STATE/sessions" "$STATE/nvm-alias-fails" \
    "$STATE/curl-calls" "$STATE/curl-args" "$STATE/curl-config" "$STATE/report-body" "$STATE/restarts" "$HOME_DIR/.termag/node-update.rejected"
  gpg --homedir "$G" --batch --armor --export "$FP" > "$KEYS"
  installed
  "$STUB/systemctl" --user restart termag-agent.service; rm -f "$STATE/restarts"
}
run() {
  env -i PATH="$STUB:/usr/bin:/bin" HOME="$HOME_DIR" STATE="$STATE" SRV="$SRV" LOG="$LOG" VERS="$VERS" NVM_DIR="$NVM" \
    TERMAG_NODE_DIST_URL=https://nodejs.example.test/dist TERMAG_NODE_PINNED="$FP" TERMAG_NODE_AGENT_WAIT=5 TERMAG_NODE_LOCK_WAIT=1 \
    TERMAG_AGENT_CONFIG="$WORK/agent.config.json" TERMAG_POLICY_TIMEOUT=5 TERMAG_NODE_RUN_NODE="$STUB/run-node.sh" "$@" bash "$SCRIPT" ${ARGS:---run $RUN_ID} 2>"$WORK/err"
}
report() { jq -r "$1" "$STATE/report-body" 2>/dev/null; }
default() { cat "$NVM/alias/default"; }
agent_node() { tr '\0' '\n' < "/proc/$(cat "$STATE/agent-pid")/cmdline" 2>/dev/null | head -n 1; }
staged() { for d in "$VERS"/.termag-v*; do [ -e "$d" ] && printf '%s ' "${d##*/}"; done; }
unchanged() {  # unchanged NAME: the default, the versions and the agent as they were
  [ "$(default)" = "$OLD" ] || fail "$1: the default stays $OLD" "$OLD" "$(default)"
  [ ! -e "$VERS/v$NEW" ] || fail "$1: no v$NEW in versions/node" absent present
  [ -z "$(staged)" ] || fail "$1: no staging directory left" none "$(staged)"
  [ -z "$(cat "$STATE/restarts" 2>/dev/null)" ] || fail "$1: the agent is not restarted" none "$(cat "$STATE/restarts")"
}

# ── an exact target: verified, staged, globals reinstalled, switched ────────
reset; policy 200 "$NEW"
run; got=$?
[ "$got" = 0 ] || fail 'target: exits 0' 0 "$got: $(tail -5 "$WORK/err")"
has 'target: asks for node'"'"'s policy for its run' "$(cat "$STATE/curl-calls")" "GET https://orch.example.test/termag/api/tool-update/policy?component=node&run=$RUN_ID"
lacks 'target: the token never in an argument' "$(cat "$STATE/curl-args")" 'tmag_box_token'
has 'target: the signed sums' "$(cat "$STATE/curl-calls")" "GET https://nodejs.example.test/dist/v$NEW/SHASUMS256.txt.sig"
has 'target: https only' "$(cat "$STATE/curl-args")" '--proto =https'
[ "$(default)" = "$NEW" ] || fail 'target: the default is the new Node' "$NEW" "$(default)"
[ -x "$VERS/v$OLD/bin/node" ] || fail 'target: the old Node stays installed' present absent
[ -z "$(staged)" ] || fail 'target: no staging directory left' none "$(staged)"
for g in $GLOBALS; do
  n=${g%@*} v=${g##*@}
  [ "$(jq -r .version "$VERS/v$NEW/lib/node_modules/$n/package.json" 2>/dev/null)" = "$v" ] || fail "target: $n@$v reinstalled under the new Node" "$v" "$(cat "$VERS/v$NEW/lib/node_modules/$n/package.json" 2>&1)"
done
# Copied as they are on disk: npm installs nothing and runs no script, and no
# registry is asked (Security review on #1113).
lacks 'target: npm installs nothing under the new Node' "$(grep "npm\[$VERS/.termag" "$LOG")" 'install'
for b in claude codex pi; do
  case "$(readlink "$VERS/v$NEW/bin/$b")" in ../lib/node_modules/*) ;; *) fail "target: bin/$b linked into its copied package" '../lib/node_modules/...' "$(readlink "$VERS/v$NEW/bin/$b")" ;; esac
done
lacks 'target: npm is never reinstalled' "$(grep install "$LOG")" ' npm@'
lacks 'target: corepack is never reinstalled' "$(grep install "$LOG")" 'corepack@'
[ "$(grep -c "to Node $NEW's" "$WORK/err")" = 4 ] || fail 'target: each global copied into the new root' 4 "$(grep -c "to Node $NEW's" "$WORK/err")"
[ "$(agent_node)" = "$VERS/v$NEW/bin/node" ] || fail 'target: the agent runs the new Node' "$VERS/v$NEW/bin/node" "$(agent_node)"
got=$(report '[.component, .outcome, .target, .fromVersion, .toVersion, (.panes | length)] | join(" ")')
[ "$got" = "node updated $NEW $OLD $NEW 0" ] || fail 'target: the report' "node updated $NEW $OLD $NEW 0" "$got"
has 'target: the detail' "$(report .detail)" "node=$OLD->$NEW globals=4 agent=restarted"
has 'target: says the old Node stays for its sessions' "$(cat "$WORK/err")" 'its 4 npm global(s) verified under it'

# Current: nothing. latest: the newest of the installed major, never the next major.
reset; echo "$NEW" > /dev/null; policy 200 "$OLD"
run; got=$?
[ "$got" = 0 ] && [ "$(report .outcome)" = current ] || fail 'current: nothing to do' 'current' "$got $(report .outcome)"
lacks 'current: downloads nothing' "$(cat "$STATE/curl-calls")" 'SHASUMS'
reset; policy 200 latest
run
[ "$(default)" = "$NEW" ] || fail 'latest: the newest of the installed major' "$NEW" "$(default)"
lacks 'latest: never the next major' "$(cat "$STATE/curl-calls")" "v$NEXTMAJ"
lacks 'latest: never an rc' "$(cat "$STATE/curl-calls")" 'rc.1'
reset; policy 200 "$NEXTMAJ"
run
unchanged 'another major'
has 'another major: says so' "$(cat "$WORK/err")" "a new major is the image's"

# ── never trusted, never unpacked, nothing changes ──────────────────────────
reset; policy 200 "$NEW"; cp "$SRV/v$NEW/SHASUMS256.txt" "$WORK/sums"; echo "0000 node-v$NEW-other.tar.xz" >> "$SRV/v$NEW/SHASUMS256.txt"
run
cp "$WORK/sums" "$SRV/v$NEW/SHASUMS256.txt"
unchanged 'tampered sums'
has 'tampered sums: says so' "$(cat "$WORK/err")" "SHASUMS256.txt: the signature does not verify"
# A keys file with a key that is not pinned: nothing downloaded is trusted.
reset; policy 200 "$NEW"; gpg --homedir "$G" --batch --armor --export "$FP" "$OTHER" > "$KEYS"
run
unchanged 'keys file with a key not pinned'
has 'keys file with a key not pinned: says so' "$(cat "$WORK/err")" "is not Node's pinned release keys"
# Both keys pinned, signed by the second: any pinned release key will do.
reset; policy 200 "$NEW"; gpg --homedir "$G" --batch --armor --export "$FP" "$OTHER" > "$KEYS"; SIGNER=$OTHER mkrel "$NEW"
run TERMAG_NODE_PINNED="$FP $OTHER"
[ "$(default)" = "$NEW" ] || fail 'signed by another pinned key: installs' "$NEW" "$(default)"
# Signed by a key that is not a release key (not in the keys file).
reset; policy 200 "$NEW"; SIGNER=$OTHER mkrel "$NEW"
run
mkrel "$NEW"
unchanged 'signed by another key'
has 'signed by another key: says so' "$(cat "$WORK/err")" 'the signature does not verify'
reset; policy 200 "$NEW"; cp "$SRV/v$NEW/node-v$NEW-linux-$ARCH.tar.xz" "$WORK/tarball"; printf 'x' >> "$SRV/v$NEW/node-v$NEW-linux-$ARCH.tar.xz"
run
cp "$WORK/tarball" "$SRV/v$NEW/node-v$NEW-linux-$ARCH.tar.xz"
unchanged 'tampered tarball'
has 'tampered tarball: says so' "$(cat "$WORK/err")" 'does not match its signed SHA-256; not unpacked'

# ── a global that does not reinstall or verify: nothing changes ─────────────
reset; policy 200 "$NEW"; : > "$VERS/v$OLD/lib/node_modules/@openai/codex/unreadable"; chmod 000 "$VERS/v$OLD/lib/node_modules/@openai/codex/unreadable"
run; got=$?
unchanged 'copy fails'
has 'copy fails: says so' "$(cat "$WORK/err")" "Node $OLD stays the default"
[ "$(report .outcome)" = failed ] || fail 'copy fails: reported failed' failed "$(report .outcome)"
reset; policy 200 "$NEW"; echo "codex-cli 0.164.0" > "$STATE/says-codex"
run
unchanged 'a tool says another version'
has 'a tool says another version: says so' "$(cat "$WORK/err")" "codex under $VERS/.termag-v$NEW"

# The listing fails, or misses a package the root holds: never an empty list
# that would switch with no tools (Bugbot on #1113).
reset; policy 200 "$NEW"; : > "$STATE/npm-ls-fails"
run
unchanged 'npm ls fails'
has 'npm ls fails: says so' "$(cat "$WORK/err")" "could not list Node $OLD's npm globals"
reset; policy 200 "$NEW"; : > "$STATE/npm-ls-omits"
run
unchanged 'npm ls misses a package'
has 'npm ls misses a package: says so' "$(cat "$WORK/err")" 'not the same globals'
# As many names as on disk, but not the same ones (Bugbot on #1113).
reset; policy 200 "$NEW"; : > "$STATE/npm-ls-renames"
run
unchanged 'npm ls names another package'
has 'npm ls names another package: says so' "$(cat "$WORK/err")" 'not the same globals'

# A tool that prints a banner with another version ahead of its own: still
# verified (Bugbot on #1113).
reset; policy 200 "$NEW"; printf 'Node.js v24.22.2 runtime 9.9.9\ncodex-cli 0.165.0\n' > "$STATE/says-codex"
run
[ "$(default)" = "$NEW" ] || fail 'a banner ahead of the version: verified, switched' "$NEW" "$(default): $(tail -3 "$WORK/err")"

# ── the agent ───────────────────────────────────────────────────────────────
for guard in killmode launcher runner; do
  reset; policy 200 "$NEW"
  case $guard in killmode) echo control-group > "$STATE/killmode" ;; launcher) : > "$STATE/bad-launcher" ;; runner) echo 'ada-claude-runner-s1-abc-r' > "$STATE/sessions" ;; esac
  run; got=$?
  [ "$(default)" = "$NEW" ] || fail "agent $guard: the switch stands" "$NEW" "$(default)"
  [ -z "$(cat "$STATE/restarts" 2>/dev/null)" ] || fail "agent $guard: not restarted" none "$(cat "$STATE/restarts")"
  has "agent $guard: says why" "$(report .detail)" "agent=deferred:$guard"
  [ "$got" = 0 ] || fail "agent $guard: exits 0" 0 "$got"
done
reset; policy 200 "$NEW"; : > "$STATE/agent-fails-$NEW"
run; got=$?
[ "$got" = 3 ] || fail 'agent fails on the new Node: rejected, exits 3' 3 "$got: $(tail -3 "$WORK/err")"
[ "$(default)" = "$OLD" ] || fail 'agent fails on the new Node: the old default is back' "$OLD" "$(default)"
[ "$(agent_node)" = "$VERS/v$OLD/bin/node" ] || fail 'agent fails on the new Node: the agent runs the old Node' "$VERS/v$OLD/bin/node" "$(agent_node)"
has 'agent fails on the new Node: says so' "$(cat "$WORK/err")" "Node $OLD is the default again, and the agent runs it"
[ "$(report .outcome)" = failed ] || fail 'agent fails on the new Node: reported failed' failed "$(report .outcome)"
# The version it backed out of is moved aside, so a later run can install it
# again, and that run clears the rejection (Bugbot on #1113).
[ ! -e "$VERS/v$NEW" ] || fail 'agent fails on the new Node: v'"$NEW"' moved aside for a retry' absent present
rm -f "$STATE/agent-fails-$NEW" "$STATE/report-body"
run; got=$?
[ "$got" = 0 ] && [ "$(default)" = "$NEW" ] || fail 'agent fails, then a retry: installs and switches' "0 $NEW" "$got $(default): $(tail -3 "$WORK/err")"
[ ! -e "$HOME_DIR/.termag/node-update.rejected" ] || fail 'agent fails, then a retry: the record is gone' absent present
# The agent comes up on neither: the old default is back, and the new version
# is moved aside all the same, so a later run can retry (Bugbot on #1113).
reset; policy 200 "$NEW"; : > "$STATE/agent-fails-$NEW"; : > "$STATE/agent-fails-$OLD"
run; got=$?
rm -f "$STATE/agent-fails-$NEW" "$STATE/agent-fails-$OLD"
[ "$got" = 3 ] || fail 'agent fails on both: rejected, exits 3' 3 "$got"
[ "$(default)" = "$OLD" ] || fail 'agent fails on both: the old default is back' "$OLD" "$(default)"
[ ! -e "$VERS/v$NEW" ] || fail 'agent fails on both: v'"$NEW"' moved aside for a retry' absent present
# Rejected, and the new version still the default (its rollback could not put
# the old one back): a later run checks it in place and clears the record
# (Bugbot on #1113).
reset; policy 200 "$NEW"
run
printf 'node the agent did not come up on Node %s\n' "$NEW" > "$HOME_DIR/.termag/node-update.rejected"; rm -f "$STATE/report-body"
run; got=$?
[ "$got" = 0 ] || fail 'rejected default: a retry exits 0' 0 "$got: $(tail -3 "$WORK/err")"
[ ! -e "$HOME_DIR/.termag/node-update.rejected" ] || fail 'rejected default: the record is cleared' absent present
has 'rejected default: says so' "$(cat "$WORK/err")" 'the rejection is cleared'
# The same, on a box whose agent runs a checkout's Node: no restart, and the
# record cleared once the globals verify (Bugbot on #1113).
reset; policy 200 "$NEW"
run
printf 'node stopped before the agent ran Node %s\n' "$NEW" > "$HOME_DIR/.termag/node-update.rejected"; rm -f "$STATE/restarts"
echo "$HOME_DIR/src/termag/node/bin/node" > "$STATE/checkout-node"
run; got=$?
rm -f "$STATE/checkout-node"
[ "$got" = 0 ] && [ ! -e "$HOME_DIR/.termag/node-update.rejected" ] || fail 'rejected default, checkout agent: cleared' '0, no record' "$got $(cat "$HOME_DIR/.termag/node-update.rejected" 2>/dev/null)"
[ -z "$(cat "$STATE/restarts" 2>/dev/null)" ] || fail 'rejected default, checkout agent: not restarted' none "$(cat "$STATE/restarts")"
# nvm refuses the new default: the old one stays, the version is moved aside.
reset; policy 200 "$NEW"; : > "$STATE/nvm-alias-fails"
run
rm -f "$STATE/nvm-alias-fails"
unchanged 'nvm refuses the default'
# nvm writes the new default but reports failure, and won't take the old one
# back: the verified new version stays where the default names it, recorded,
# never moved aside from under it (Bugbot on #1113).
reset; policy 200 "$NEW"; : > "$STATE/nvm-alias-stuck"
run
rm -f "$STATE/nvm-alias-stuck" "$STATE/nvm-alias-stuck-done"
[ "$(default)" = "$NEW" ] && [ -x "$VERS/v$NEW/bin/node" ] || fail 'nvm stuck: the default names an installed Node' "$NEW, present" "$(default) $(ls "$VERS")"
grep -q '^node ' "$HOME_DIR/.termag/node-update.rejected" 2>/dev/null || fail 'nvm stuck: recorded for the next run' 'node ...' "$(cat "$HOME_DIR/.termag/node-update.rejected" 2>/dev/null)"
[ "$(report .outcome)" = failed ] || fail 'nvm stuck: reported failed' failed "$(report .outcome)"

# The agent runs a checkout's own Node (run-node.sh prefers it): not
# restarted, nothing rolled back, the switch stands (Bugbot on #1113).
reset; policy 200 "$NEW"; echo "$HOME_DIR/src/termag/node/bin/node" > "$STATE/checkout-node"
run; got=$?
[ "$got" = 0 ] || fail 'checkout node: exits 0' 0 "$got: $(tail -3 "$WORK/err")"
[ "$(default)" = "$NEW" ] || fail 'checkout node: the switch stands' "$NEW" "$(default)"
[ -z "$(cat "$STATE/restarts" 2>/dev/null)" ] || fail 'checkout node: the agent is not restarted' none "$(cat "$STATE/restarts")"
has 'checkout node: says why' "$(report .detail)" "agent=unaffected:$HOME_DIR/src/termag/node/bin/node"

# The launcher can't say which Node it picks: the agent is not restarted
# and nothing is rolled back; the switch stands (Bugbot on #1113).
reset; policy 200 "$NEW"; : > "$STATE/launcher-fails"
run; got=$?
[ "$got" = 0 ] || fail 'launcher fails: exits 0' 0 "$got: $(tail -3 "$WORK/err")"
[ "$(default)" = "$NEW" ] || fail 'launcher fails: the switch stands' "$NEW" "$(default)"
[ -z "$(cat "$STATE/restarts" 2>/dev/null)" ] || fail 'launcher fails: the agent is not restarted' none "$(cat "$STATE/restarts")"
has 'launcher fails: says why' "$(report .detail)" 'agent=deferred:launcher-unknown'
# Nor is a rejected default cleared on it.
printf 'node stopped before the agent ran Node %s\n' "$NEW" > "$HOME_DIR/.termag/node-update.rejected"
run
rm -f "$STATE/launcher-fails"
[ -e "$HOME_DIR/.termag/node-update.rejected" ] || fail 'launcher fails, rejected default: stays rejected' present absent
[ -z "$(cat "$STATE/restarts" 2>/dev/null)" ] || fail 'launcher fails, rejected default: not restarted' none "$(cat "$STATE/restarts")"

# A signal after the rename, before the switch: the new version is moved
# aside, so a later run can install it (Bugbot on #1113).
reset; policy 200 "$NEW"; : > "$STATE/nvm-slow"
run & rp=$!
for _ in $(seq 1 100); do [ -d "$VERS/v$NEW" ] && break; sleep 0.2; done
sleep 1; kill -TERM "$(pgrep -f "termag-node-update --run $RUN_ID" | head -n 1)"; wait "$rp"; got=$?
rm -f "$STATE/nvm-slow"
[ "$got" = 143 ] || fail 'signal after the rename: exits 143' 143 "$got"
[ ! -e "$VERS/v$NEW" ] || fail 'signal after the rename: v'"$NEW"' moved aside' absent present
[ "$(default)" = "$OLD" ] || fail 'signal after the rename: the default stays' "$OLD" "$(default)"
# What earlier runs left (a version set aside, a stopped run's staging) goes,
# unless a process runs from it (Bugbot on #1113).
reset; policy 200 "$OLD"
mkdir -p "$VERS/.termag-rejected-v24.21.0-11/bin" "$VERS/.termag-v24.21.5-12/bin" "$VERS/.termag-rejected-v24.20.0-13/bin"
cp "$(command -v sleep)" "$VERS/.termag-rejected-v24.20.0-13/bin/node"; held=$( { "$VERS/.termag-rejected-v24.20.0-13/bin/node" 30 </dev/null >/dev/null 2>&1 & echo "$!"; } )
run
kill "$held" 2>/dev/null
[ ! -e "$VERS/.termag-rejected-v24.21.0-11" ] && [ ! -e "$VERS/.termag-v24.21.5-12" ] || fail 'leftovers: removed' none "$(ls -a "$VERS")"
[ -d "$VERS/.termag-rejected-v24.20.0-13" ] || fail 'leftovers: one a process runs from stays' present absent
[ -x "$VERS/v$OLD/bin/node" ] || fail 'leftovers: the installed Node is untouched' present absent
# The same with NVM_DIR reached through a link: /proc names the canonical path,
# and one a process runs from still stays (Bugbot on #1113).
reset; policy 200 "$OLD"; ln -sfn "$NVM" "$WORK/nvm-link"
mkdir -p "$VERS/.termag-rejected-v24.20.0-14/bin"
cp "$(command -v sleep)" "$VERS/.termag-rejected-v24.20.0-14/bin/node"; held=$( { "$VERS/.termag-rejected-v24.20.0-14/bin/node" 30 </dev/null >/dev/null 2>&1 & echo "$!"; } )
run NVM_DIR="$WORK/nvm-link"
kill "$held" 2>/dev/null
[ -d "$VERS/.termag-rejected-v24.20.0-14" ] || fail 'leftovers through a link: one a process runs from stays' present absent
# A signal right after the rename into place, before the run goes on: the new
# version is moved aside, so a later run can install it (Bugbot on #1113).
reset; policy 200 "$NEW"; : > "$STATE/mv-slow"
run & rp=$!
for _ in $(seq 1 100); do [ -d "$VERS/v$NEW" ] && break; sleep 0.1; done
sleep 1; kill -TERM "$(pgrep -f "termag-node-update --run $RUN_ID" | head -n 1)"; wait "$rp"; got=$?
rm -f "$STATE/mv-slow"
[ "$got" = 143 ] || fail 'signal right after the rename: exits 143' 143 "$got"
[ ! -e "$VERS/v$NEW" ] && [ "$(default)" = "$OLD" ] || fail 'signal right after the rename: moved aside, the default stays' "no v$NEW, $OLD" "$(ls "$VERS") $(default)"
run; got=$?
[ "$got" = 0 ] && [ "$(default)" = "$NEW" ] || fail 'signal right after the rename: a later run installs it' "0 $NEW" "$got $(default): $(tail -2 "$WORK/err")"
# A signal mid-switch, once nvm has written the new default: the default goes
# back to the old version before the new one is moved aside, so it never names
# a missing Node (Bugbot on #1113).
reset; policy 200 "$NEW"; : > "$STATE/nvm-slow-after"
run & rp=$!
for _ in $(seq 1 100); do [ "$(default)" = "$NEW" ] && break; sleep 0.2; done
sleep 1; kill -TERM "$(pgrep -f "termag-node-update --run $RUN_ID" | head -n 1)"; wait "$rp"; got=$?
rm -f "$STATE/nvm-slow-after"
[ "$got" = 143 ] || fail 'signal mid-switch: exits 143' 143 "$got"
[ "$(default)" = "$OLD" ] || fail 'signal mid-switch: the default is the old version again' "$OLD" "$(default)"
[ ! -e "$VERS/v$NEW" ] || fail 'signal mid-switch: v'"$NEW"' moved aside' absent present
# A global's bin link named like Node's own (npx here) is never copied over
# them, and a global installed from git or a file stays exactly those bytes
# (Security review on #1113).
reset; policy 200 "$NEW"
ln -sfn ../lib/node_modules/left-pad/evil "$VERS/v$OLD/bin/npx"; echo from-git > "$VERS/v$OLD/lib/node_modules/left-pad/marker"
run; got=$?
[ "$got" = 0 ] && [ "$(default)" = "$NEW" ] || fail 'own names: installs' "0 $NEW" "$got $(default): $(tail -3 "$WORK/err")"
[ "$(readlink "$VERS/v$NEW/bin/npx" 2>/dev/null)" != ../lib/node_modules/left-pad/evil ] || fail 'own names: bin/npx is never a global'"'"'s' 'not left-pad' "$(readlink "$VERS/v$NEW/bin/npx")"
[ "$(cat "$VERS/v$NEW/lib/node_modules/left-pad/marker" 2>/dev/null)" = from-git ] || fail 'the bytes on disk: copied as they are' from-git "$(cat "$VERS/v$NEW/lib/node_modules/left-pad/marker" 2>&1)"
# A signal after the switch, before the agent runs it: rejected, so the next
# run checks it in place, restarts the agent and clears the record.
reset; policy 200 "$NEW"; : > "$STATE/restart-slow"
run & rp=$!
for _ in $(seq 1 100); do [ "$(default)" = "$NEW" ] && break; sleep 0.2; done
sleep 1; kill -TERM "$(pgrep -f "termag-node-update --run $RUN_ID" | head -n 1)"; wait "$rp"; got=$?
rm -f "$STATE/restart-slow"
[ "$got" = 143 ] || fail 'signal after the switch: exits 143' 143 "$got"
grep -q '^node ' "$HOME_DIR/.termag/node-update.rejected" 2>/dev/null || fail 'signal after the switch: recorded as rejected' 'node ...' "$(cat "$HOME_DIR/.termag/node-update.rejected" 2>/dev/null)"
run; got=$?
[ "$got" = 0 ] && [ ! -e "$HOME_DIR/.termag/node-update.rejected" ] || fail 'signal after the switch, then a run: checked in place, record cleared' '0, no record' "$got $(cat "$HOME_DIR/.termag/node-update.rejected" 2>/dev/null)"
[ "$(agent_node)" = "$VERS/v$NEW/bin/node" ] || fail 'signal after the switch, then a run: the agent runs it' "$VERS/v$NEW/bin/node" "$(agent_node)"

# ── locks, policy, usage ────────────────────────────────────────────────────
reset; policy 200 "$NEW"
( exec 9>"$HOME_DIR/.termag/codex-update.lock"; flock 9; sleep 4 ) & holder=$!
sleep 0.5
run
wait "$holder"
unchanged 'codex lock held'
has 'codex lock held: says so' "$(cat "$WORK/err")" 'termag-codex-update holds its lock'
[ "$(report .outcome)" = failed ] || fail 'codex lock held: reported failed' failed "$(report .outcome)"
# With no cap, a sibling's lock is waited for out of the budget, past a fixed
# minute (its install and drain take up to 600 s), and the run goes on once
# it is free (Bugbot on #1113).
reset; policy 200 "$NEW"
( exec 9>"$HOME_DIR/.termag/codex-update.lock"; flock 9; sleep 3 ) & holder=$!
sleep 0.5
run TERMAG_NODE_LOCK_WAIT=; got=$?
wait "$holder"
[ "$got" = 0 ] && [ "$(default)" = "$NEW" ] || fail 'codex lock, then free: installs' "0 $NEW" "$got $(default): $(tail -2 "$WORK/err")"
w=$(sed -n 's/.*termag-codex-update holds its lock; waiting up to \([0-9]*\)s for it.*/\1/p' "$WORK/err" | head -n 1)
[ -n "$w" ] && [ "$w" -gt 600 ] || fail 'codex lock, then free: waits out of the budget, past the drain' '> 600 s' "${w:-none}"
reset; policy 200 "$NEW" null
run
unchanged 'run null'
reset; policy 403
run
unchanged 'refused'
has 'refused: says so' "$(cat "$WORK/err")" 'Node has no fallback floor'
[ "$(report .outcome)" = failed ] || fail 'refused: reported failed, never current (Bugbot on #1080)' failed "$(report .outcome)"
reset; policy 200 "$NEW"; mkdir -p "$VERS/v$NEW"
run
[ "$(default)" = "$OLD" ] || fail 'already there: the default stays' "$OLD" "$(default)"
has 'already there: says so' "$(cat "$WORK/err")" "$VERS/v$NEW is already there"
rmdir "$VERS/v$NEW"
for a in '' '--run' '--run short' "--run $RUN_ID extra" "--run ${RUN_ID}X;id"; do
  ARGS="${a:- }" run; got=$?
  [ "$got" = 2 ] || fail "usage '$a': exits 2" 2 "$got"
done

if [ "$failures" -eq 0 ]; then
  echo "ok: termag-node-update"
else
  echo "$failures failure(s)"
  exit 1
fi
