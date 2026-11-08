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
#   * corepack's shims (pnpm, pnpx, yarn, yarnpkg): a default with them gives
#     them to the new Node (its own corepack, network off), one without them
#     gets none, a corepack enable that fails or links nothing keeps the old
#     default; a default an earlier switch left without them, beside an
#     installed Node with them, gets them back on any run, per command (one a
#     repair could not link is tried again); a pnpm or yarn that is not
#     corepack's (an npm global) is never replaced, on the default or in the
#     new Node
#   * another tool's update holding its lock, no policy, run null, a version
#     dir already there, and usage: nothing installed
#   * the sessions on the old Node (stub updaters): once the switch stands,
#     restart idle or force runs Claude Code's, Codex's and pi's updaters as
#     `--sessions <restart> <drainSec>`, with their locks free, and their
#     counts and panes go into the report; restart none, or a switch that
#     does not stand, runs none; a tool that fails is partial; a signal
#     reports what they had done
#   * and for real (the real updaters, fake sessions on the old Node's root in
#     real tmux panes, a private PID namespace; skipped without sudo or tmux):
#     each tool's stale session is stopped and resumed on the new Node's bin,
#     an agent pane is listed, a Cursor pane is left alone
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
  rm -rf "$WORK/rel"; mkdir -p "$d/bin" "$d/lib/node_modules/npm" "$d/lib/node_modules/corepack/dist" "$SRV/v$v"
  printf '{"name":"npm","version":"11.19.1"}\n' > "$d/lib/node_modules/npm/package.json"
  printf '{"name":"corepack","version":"0.36.0"}\n' > "$d/lib/node_modules/corepack/package.json"
  printf '#!/bin/sh\n[ "$1" = --version ] && { echo v%s; exit 0; }\nexec sleep 300\n' "$v" > "$d/bin/node"
  cat > "$d/bin/npm" <<'EOF'
#!/bin/sh
me=$(cd "$(dirname "$0")/.." && pwd)
echo "npm[$me] $*" >> "$LOG"
case "$1" in
  root) echo "$me/lib/node_modules" ;;
  prefix) echo "$me" ;;
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
      printf '#!/bin/sh\n[ "$1" = --version ] || exec sleep 300\n[ -s "$STATE/says-%s" ] && { cat "$STATE/says-%s"; exit 0; }\necho "%s %s"\n' "$b" "$b" "$b" "$v" > "$prefix/lib/node_modules/$name/$b-cli"; chmod +x "$prefix/lib/node_modules/$name/$b-cli"
      ln -sfn "../lib/node_modules/$name/$b-cli" "$prefix/bin/$b"
    fi ;;
esac
EOF
  # corepack, linked from bin/ as Node ships it: `enable [--install-directory
  # D] pnpm|yarn...` links D/pnpm, pnpx, yarn, yarnpkg into its dist/ as the
  # real one does, and logs the network setting it ran with; it fails while
  # $STATE/corepack-fails exists, and links nothing while $STATE/corepack-silent does.
  for b in pnpm pnpx yarn yarnpkg; do printf '#!/bin/sh\necho %s 9.0.0\n' "$b" > "$d/lib/node_modules/corepack/dist/$b.js"; chmod +x "$d/lib/node_modules/corepack/dist/$b.js"; done
  cat > "$d/lib/node_modules/corepack/dist/corepack.js" <<'COREPACK'
#!/bin/sh
me=$(cd "$(dirname "$(readlink -f "$0")")/../../../.." && pwd)
echo "corepack[$me] $* network=${COREPACK_ENABLE_NETWORK:-unset}" >> "$LOG"
[ "$1" = enable ] || exit 1
[ -e "$STATE/corepack-fails" ] && { echo 'Internal Error: boom' >&2; exit 1; }
[ -e "$STATE/corepack-silent" ] && exit 0
shift; dir=$me/bin names=
while [ $# -gt 0 ]; do case "$1" in --install-directory) dir=$2; shift ;; *) names="$names $1" ;; esac; shift; done
for n in ${names:-pnpm yarn}; do
  case "$n" in pnpm) bins='pnpm pnpx' ;; yarn) bins='yarn yarnpkg' ;; *) exit 1 ;; esac
  for b in $bins; do ln -sfn "../lib/node_modules/corepack/dist/$b.js" "$dir/$b"; done
done
COREPACK
  chmod +x "$d/lib/node_modules/corepack/dist/corepack.js"
  ln -s ../lib/node_modules/corepack/dist/corepack.js "$d/bin/corepack"
  chmod +x "$d/bin/node" "$d/bin/npm"
  tar -cJf "$SRV/v$v/node-v$v-linux-$ARCH.tar.xz" -C "$WORK/rel" "node-v$v-linux-$ARCH"
  ( cd "$SRV/v$v" && sha256sum "node-v$v-linux-$ARCH.tar.xz" > SHASUMS256.txt )
  gpg --homedir "$G" --batch --yes --local-user "${SIGNER:-$FP}" --detach-sign -o "$SRV/v$v/SHASUMS256.txt.sig" "$SRV/v$v/SHASUMS256.txt" 2>/dev/null
}
# NEWER: a patch beyond NEW that index.json does not list (an exact target only).
NEWER=24.22.3
for v in "$OLD" "$NEW" "$NEWER" "$NEXTMAJ"; do mkrel "$v"; done
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
# enabled V [PM...]: corepack enable on Node V (pnpm and yarn by default), as the image runs it.
enabled() { v=$1; shift; PATH="$VERS/v$v/bin:$PATH" "$VERS/v$v/bin/corepack" enable "$@"; : > "$LOG"; }
# lost_shims: the image's Node OLD with corepack's shims, and Node NEW the
# default without them, as a switch before they were carried over left it.
lost_shims() {
  enabled "$OLD"
  mkdir -p "$VERS/v$NEW"; tar -xJf "$SRV/v$NEW/node-v$NEW-linux-$ARCH.tar.xz" -C "$VERS/v$NEW" --strip-components=1
  for g in $GLOBALS; do "$VERS/v$NEW/bin/npm" install -g --prefix "$VERS/v$NEW" "$g" >/dev/null; done
  echo "$NEW" > "$NVM/alias/default"; : > "$LOG"
}
# npm_pnpm V: an npm global pnpm on Node V (bin/pnpm and bin/pnpx into its
# package), as an owner installs one when the shims are gone.
npm_pnpm() {
  mkdir -p "$VERS/v$1/lib/node_modules/pnpm/bin"
  printf '{"name":"pnpm","version":"9.15.0"}\n' > "$VERS/v$1/lib/node_modules/pnpm/package.json"
  for b in pnpm pnpx; do
    printf '#!/bin/sh\necho 9.15.0\n' > "$VERS/v$1/lib/node_modules/pnpm/bin/$b.cjs"; chmod +x "$VERS/v$1/lib/node_modules/pnpm/bin/$b.cjs"
    ln -sfn "../lib/node_modules/pnpm/bin/$b.cjs" "$VERS/v$1/bin/$b"
  done
}
# scratch V: a corepack scratch directory left in Node V's root.
scratch() { for d in "$VERS/v$1"/.termag-corepack.*; do [ -e "$d" ] && printf '%s ' "${d##*/}"; done; }
# shims_of V: corepack's shims Node V's bin links into its own corepack.
shims_of() {
  for b in pnpm pnpx yarn yarnpkg; do
    [ "$(readlink "$VERS/v$1/bin/$b" 2>/dev/null)" = "../lib/node_modules/corepack/dist/$b.js" ] && [ -x "$VERS/v$1/bin/$b" ] && printf '%s ' "$b"
  done
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
# As nvm does unless --no-use: the default's bin first on PATH.
case " $* " in *' --no-use '*) ;; *) PATH="$NVM_DIR/versions/node/v$(cat "$NVM_DIR/alias/default")/bin:$PATH" ;; esac
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
# The tools' updaters, as --sessions: each records its call and whether its
# lock is free, and prints $STATE/sessions-<tool> (else nothing stopped);
# $STATE/sessions-fails-<tool>: prints nothing and fails; $STATE/sessions-slow:
# waits, and on SIGTERM prints what it had stopped.
mkdir -p "$STUB/tools"
for t in claude codex pi; do
  printf '#!/bin/bash\nt=%s\n' "$t" > "$STUB/tools/termag-$t-update"
  cat >> "$STUB/tools/termag-$t-update" <<'EOF'
echo "$t $*" >> "$STATE/sessions-calls"
flock -n "$HOME/.termag/$t-update.lock" true && echo "$t lock-free" >> "$STATE/sessions-calls"
[ -e "$STATE/sessions-fails-$t" ] && exit 1
if [ -e "$STATE/sessions-slow" ]; then
  trap 'printf "{\"component\":\"%s\",\"restart\":\"%s(stopped by a signal)\",\"sessions\":{\"stopped\":1},\"panes\":[{\"session\":\"ada-p-%s-agent\",\"role\":\"agent\",\"hadConversation\":false}]}\n" "$t" "$2" "$t"; exit 143' TERM
  sleep 30 & wait
fi
[ -s "$STATE/sessions-$t" ] && { cat "$STATE/sessions-$t"; exit 0; }
printf '{"component":"%s","restart":"%s(nothing on an old binary)","sessions":{"stopped":0,"resumed":0,"fresh":0,"cut":0,"typed":0,"other":0,"runnersLeft":0},"panes":[]}\n' "$t" "$2"
EOF
  chmod +x "$STUB/tools/termag-$t-update"
done

RUN_ID=cmvtrun0000000000000000008
printf '{"token":"tmag_box_token","termag_url":"wss://orch.example.test/termag/ws/agent"}\n' > "$WORK/agent.config.json"
policy() {  # policy CODE [TARGET [RUN [RESTART]]]
  printf '%s' "$1" > "$STATE/policy-code"
  printf '{"floor":"24.22.1","target":"%s","restart":"%s","drainSec":5,"run":%s}' "${2:-$NEW}" "${4:-idle}" "${3:-{\"id\":\"$RUN_ID\",\"component\":\"node\"\}}" > "$STATE/policy-body"
}
reset() {
  rm -f "$STATE/checkout-node" "$STATE/mv-slow" "$STATE/nvm-alias-stuck" "$STATE/nvm-alias-stuck-done" "$STATE/nvm-slow" "$STATE/nvm-slow-after" "$STATE/restart-slow" "$STATE"/npm-fails-* "$STATE/npm-ls-fails" "$STATE/npm-ls-omits" "$STATE/npm-ls-renames" "$STATE"/says-* "$STATE"/agent-fails-* "$STATE/killmode" "$STATE/bad-launcher" "$STATE/sessions" "$STATE/nvm-alias-fails" \
    "$STATE/curl-calls" "$STATE/curl-args" "$STATE/curl-config" "$STATE/report-body" "$STATE/restarts" "$HOME_DIR/.termag/node-update.rejected" \
    "$STATE/sessions-calls" "$STATE/sessions-claude" "$STATE/sessions-codex" "$STATE/sessions-pi" "$STATE"/sessions-fails-* "$STATE/sessions-slow" "$STATE/corepack-fails" "$STATE/corepack-silent"
  gpg --homedir "$G" --batch --armor --export "$FP" > "$KEYS"
  installed
  "$STUB/systemctl" --user restart termag-agent.service; rm -f "$STATE/restarts"
}
run() {
  env -i PATH="${RUNPATH:-$STUB}:/usr/bin:/bin" HOME="$HOME_DIR" STATE="$STATE" SRV="$SRV" LOG="$LOG" VERS="$VERS" NVM_DIR="$NVM" \
    TERMAG_NODE_DIST_URL=https://nodejs.example.test/dist TERMAG_NODE_PINNED="$FP" TERMAG_NODE_AGENT_WAIT=5 TERMAG_NODE_LOCK_WAIT=1 \
    TERMAG_AGENT_CONFIG="$WORK/agent.config.json" TERMAG_POLICY_TIMEOUT=5 TERMAG_NODE_RUN_NODE="$STUB/run-node.sh" TERMAG_NODE_TOOLS_DIR="${TOOLS:-$STUB/tools}" "$@" bash "$SCRIPT" ${ARGS:---run $RUN_ID} 2>"$WORK/err"
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

# ── the sessions for real, in a private PID namespace ───────────────────────
# The real updaters beside the recipe (deploy/), on fake sessions in real tmux
# panes that run from the old Node's root: Claude Code's binary (a copy of
# bash named claude), Codex's native binary (named codex, in its vendor
# directory) and pi (a copy of bash named node running pi's bundle), each
# holding what its updater reads; a Cursor agent (a copy of bash named
# cursor-agent) beside them.
e2e_cases() {
  [ "$$" = 1 ] || { echo 'FAIL: the e2e cases run only as PID 1 of their own PID namespace'; exit 1; }
  HOME=$HOME_DIR
  S="$WORK/tmux.sock"
  E2E="$WORK/stub-e2e"; mkdir -p "$E2E"; cp "$STUB/curl" "$STUB/systemctl" "$E2E/"
  O="$VERS/v$OLD/lib/node_modules"
  uuid() { printf '019a%04d-1111-7222-8333-444444444444' "$1"; }
  pane() {  # pane NAME COMMAND
    mkdir -p "$WORK/cwd/$1"
    tmux -S "$S" -f /dev/null new-session -d -s "$1" -c "$WORK/cwd/$1" -x 220 -y 50 "env PATH=$VERS/v$OLD/bin:/usr/bin:/bin HOME=$HOME_DIR STATE=$STATE bash --norc --noprofile"
    tmux -S "$S" send-keys -t "$1" -l -- "$2"; tmux -S "$S" send-keys -t "$1" Enter
  }
  pane_text() { tmux -S "$S" capture-pane -p -J -t "$1" 2>/dev/null; }
  pane_cmd() { tmux -S "$S" display -p -t "$1" '#{pane_current_command}' 2>/dev/null; }
  is_running() { kill -0 "$1" 2>/dev/null && [ "$(sed -E 's/^.*\) ([A-Za-z]) .*$/\1/' "/proc/$1/stat")" != Z ]; }
  reset; policy 200 "$NEW" "{\"id\":\"$RUN_ID\",\"component\":\"node\",\"trigger\":\"nightly\"}" force
  rm -rf "$HOME_DIR/.claude" "$HOME_DIR/.codex" "$HOME_DIR/.pi" "$WORK/cwd"
  mkdir -p "$HOME_DIR/.claude/sessions"
  cp "$(command -v bash)" "$O/@anthropic-ai/claude-code/claude"
  V="$O/@openai/codex/vendor/x86_64-unknown-linux-musl/bin"; mkdir -p "$V"; cp "$(command -v bash)" "$V/codex"
  # pi on the old Node (a copy of bash named node under its version), as a
  # real pi runs: the run copies pi's package with its times, so only that says it is old.
  PINODE="$VERS/v$OLD/libexec/pi/node"
  mkdir -p "$O/@earendil-works/pi-coding-agent/dist/bundle" "${PINODE%/node}"; cp "$(command -v bash)" "$PINODE"
  printf 'trap "exit 0" TERM\nwhile :; do sleep 0.2; done\n' > "$O/@earendil-works/pi-coding-agent/dist/bundle/cli.js"
  mkdir -p "$WORK/cursor"; cp "$(command -v bash)" "$WORK/cursor/cursor-agent"
  # Claude Code: its session file, and a transcript (a conversation).
  cat > "$WORK/claude-session.sh" <<'EOF'
printf '{"pid":%s,"sessionId":"%s","cwd":"%s","status":"idle","kind":"interactive"}\n' "$$" "$SID" "$PWD" > "$HOME/.claude/sessions/$$.json"
trap 'exit 0' TERM
while :; do sleep 0.2; done
EOF
  # Codex: its rollout held open, one finished turn.
  r=$HOME_DIR/.codex/sessions/2026/11/02/rollout-2026-11-02T09-00-00-$(uuid 2).jsonl; mkdir -p "${r%/*}"
  printf '{"type":"event_msg","payload":{"type":"task_started"}}\n{"type":"event_msg","payload":{"type":"task_complete"}}\n' > "$r"
  printf 'exec 3>>"%s"\ntrap "exit 0" TERM\nwhile :; do sleep 0.2; done\n' "$r" > "$WORK/codex-session.sh"
  pane work-claude "SID=$(uuid 1) $O/@anthropic-ai/claude-code/claude $WORK/claude-session.sh"
  pane ada-proj-agent "SID=$(uuid 3) $O/@anthropic-ai/claude-code/claude $WORK/claude-session.sh"
  pane work-codex "$V/codex $WORK/codex-session.sh"
  pane work-pi "$PINODE $O/@earendil-works/pi-coding-agent/dist/bundle/cli.js"
  pane cursor "$WORK/cursor/cursor-agent -c 'sleep 300; :'"
  sleep 1.5
  for n in work-claude ada-proj-agent; do
    d="$HOME_DIR/.claude/projects/$(printf '%s' "$WORK/cwd/$n" | sed 's/[^A-Za-z0-9]/-/g')"; mkdir -p "$d"
    [ "$n" = work-claude ] && : > "$d/$(uuid 1).jsonl"; [ "$n" = ada-proj-agent ] && : > "$d/$(uuid 3).jsonl"
  done
  d="$HOME_DIR/.pi/agent/sessions/--$(printf '%s' "${WORK#/}/cwd/work-pi" | tr '/:' '--')--"; mkdir -p "$d"; printf '{"type":"session"}\n' > "$d/2026-11-02T09-00-00-000Z_$(uuid 4).jsonl"
  # Out of a turn: last written before pi's last 10 s.
  touch -d '-30 seconds' "$d/2026-11-02T09-00-00-000Z_$(uuid 4).jsonl"
  cursor_pid=$(pgrep -f "$WORK/cursor/cursor-agent" | head -n 1)
  sleep 1.5
  RUNPATH=$E2E TOOLS=$DIR run TERMAG_CLAUDE_KILL_AFTER=2 TERMAG_CODEX_KILL_AFTER=2 TERMAG_PI_KILL_AFTER=2 \
    TERMAG_CLAUDE_RESUME_WAIT=2 TERMAG_CODEX_RESUME_WAIT=2 TERMAG_PI_RESUME_WAIT=2 TERMAG_CLAUDE_RUNNER_WAIT=0; got=$?
  [ -z "${E2E_SHOW:-}" ] || { cat "$WORK/err"; for n in work-claude ada-proj-agent work-codex work-pi cursor; do echo "── pane $n ($(pane_cmd "$n"))"; pane_text "$n" | grep -v '^$'; done; echo '── report'; jq . "$STATE/report-body"; }
  [ "$got" = 0 ] || fail 'e2e: exits 0' 0 "$got: $(tail -5 "$WORK/err")"
  [ "$(default)" = "$NEW" ] || fail 'e2e: switched' "$NEW" "$(default)"
  got=$(report '[.outcome, (.sessions | [.stopped, .typed, .resumed] | join(","))] | join(" ")')
  [ "$got" = 'updated 4,3,3' ] || fail 'e2e: stopped typed resumed' 'updated 4,3,3' "$got; $(report .detail)"
  got=$(report '[.panes[] | "\(.session):\(.role):\(.sessionId // "-")"] | sort | join(" ")')
  want="ada-proj-agent:agent:$(uuid 3) work-claude:other:$(uuid 1) work-codex:other:$(uuid 2) work-pi:other:$(uuid 4)"
  [ "$got" = "$want" ] || fail 'e2e: every stopped pane, each tool'"'"'s' "$want" "$got"
  # The line each resumed pane prints first.
  NOTICE="[termag] Node was updated to $NEW (automatic nightly run); resuming your session."
  has 'e2e: claude resumed on the new Node, after the notice' "$(pane_text work-claude)" "export PATH=$VERS/v$NEW/bin:\"\$PATH\"; printf '%s\\n' '$NOTICE'; claude --resume $(uuid 1)"
  [ "$(pane_text work-claude | grep -cxF "$NOTICE")" = 1 ] || fail 'e2e: claude: Node'"'"'s notice, printed once' "$NOTICE" "$(pane_text work-claude)"
  has 'e2e: codex resumed on the new Node, after the notice' "$(pane_text work-codex)" "export PATH=$VERS/v$NEW/bin:\"\$PATH\"; printf '%s\\n' '$NOTICE'; codex resume $(uuid 2)"
  [ "$(pane_text work-codex | grep -cxF "$NOTICE")" = 1 ] || fail 'e2e: codex: Node'"'"'s notice, printed once' "$NOTICE" "$(pane_text work-codex)"
  has 'e2e: pi resumed on the new Node, after the notice' "$(pane_text work-pi)" "export PATH=$VERS/v$NEW/bin:\"\$PATH\"; printf '%s\\n' '$NOTICE'; pi --continue"
  [ "$(pane_text work-pi | grep -cxF "$NOTICE")" = 1 ] || fail 'e2e: pi: Node'"'"'s notice, printed once' "$NOTICE" "$(pane_text work-pi)"
  for n in work-claude work-codex work-pi; do
    [ "$(pane_cmd "$n")" = sleep ] || fail "e2e: $n runs the new Node's tool" sleep "$(pane_cmd "$n")"
  done
  lacks 'e2e: the agent pane gets no notice from the box (the orchestrator relaunches it, with its own)' "$(pane_text ada-proj-agent)" '[termag]'
  has 'e2e: the agent pane is on the new PATH for its relaunch' "$(pane_text ada-proj-agent)" "export PATH=$VERS/v$NEW/bin:"
  lacks 'e2e: and left at its shell for the orchestrator' "$(pane_text ada-proj-agent)" 'claude --resume'
  [ -n "$cursor_pid" ] && is_running "$cursor_pid" || fail 'e2e: a Cursor pane is left alone' alive "gone ($cursor_pid)"
  has 'e2e: the detail, per tool' "$(report .detail)" 'sessions=claude=force:stopped=2:typed=1:resumed=1,codex=force:stopped=1:typed=1:resumed=1,pi=force:stopped=1:typed=1:resumed=1'
  # (The panes' shells write their history as they go: let them, before the cleanup.)
  tmux -S "$S" kill-server 2>/dev/null; sleep 1
}
if [ "${1:-}" = --e2e ]; then
  e2e_cases
  if [ "$failures" -eq 0 ]; then echo 'ok: termag-node-update sessions, for real (PID namespace)'; exit 0; fi
  echo "$failures failure(s) in the e2e cases"; exit 1
fi

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

# ── corepack's shims (pnpm, yarn): carried over, never invented, repaired ────
ALL='pnpm pnpx yarn yarnpkg '
reset; policy 200 "$NEW"; enabled "$OLD"
run; got=$?
[ "$got" = 0 ] && [ "$(default)" = "$NEW" ] || fail 'shims: the update switches' "0 $NEW" "$got $(default): $(tail -5 "$WORK/err")"
[ "$(shims_of "$NEW")" = "$ALL" ] || fail "shims: the new default has corepack's shims" "$ALL" "$(shims_of "$NEW")"
[ "$(shims_of "$OLD")" = "$ALL" ] || fail 'shims: the old Node keeps its own' "$ALL" "$(shims_of "$OLD")"
has "shims: enabled by the new Node's corepack, in its staging root" "$(grep '^corepack' "$LOG")" "corepack[$VERS/.termag-v$NEW-"
has 'shims: corepack runs with the network off' "$(grep '^corepack' "$LOG")" 'network=0'
lacks 'shims: corepack never runs with the network on' "$(grep '^corepack' "$LOG")" 'network=unset'
[ "$(report .outcome)" = updated ] || fail 'shims: the run is updated' updated "$(report .outcome)"
has 'shims: the detail' "$(report .detail)" 'corepack=pnpm+pnpx+yarn+yarnpkg'
# Only the ones the default has: pnpm's, not yarn's.
reset; policy 200 "$NEW"; enabled "$OLD" pnpm
run
[ "$(shims_of "$NEW")" = 'pnpm pnpx ' ] || fail 'shims: only those the default has' 'pnpm pnpx ' "$(shims_of "$NEW")"
# None on any installed Node: none invented, corepack not run.
reset; policy 200 "$NEW"
run; got=$?
[ "$got" = 0 ] && [ "$(default)" = "$NEW" ] || fail 'no shims: the update switches' "0 $NEW" "$got $(default)"
[ -z "$(shims_of "$NEW")" ] || fail 'no shims: none invented' none "$(shims_of "$NEW")"
lacks 'no shims: corepack never runs' "$(cat "$LOG")" 'corepack['
has 'no shims: the detail' "$(report .detail)" 'corepack=-'
# A failing corepack enable, or one that links nothing: nothing changes, the
# old default keeps its shims.
for how in fails silent; do
  reset; policy 200 "$NEW"; enabled "$OLD"; : > "$STATE/corepack-$how"
  run; got=$?
  unchanged "shims, corepack $how"
  [ "$(report .outcome)" = failed ] || fail "shims, corepack $how: the run failed" failed "$got $(report .outcome)"
  [ "$(shims_of "$OLD")" = "$ALL" ] || fail "shims, corepack $how: the old default keeps them" "$ALL" "$(shims_of "$OLD")"
  has "shims, corepack $how: says so" "$(cat "$WORK/err")" "Node $OLD stays the default"
  has "shims, corepack $how: the detail" "$(report .detail)" 'corepack=FAILED'
done
# The repair: NEW the default without them (a switch before this fix), the
# image's OLD with them. A run with nothing newer due enables them in place,
# downloads nothing and restarts nothing.
reset; lost_shims; policy 200 "$NEW"
run; got=$?
[ "$got" = 0 ] && [ "$(report .outcome)" = current ] || fail 'repair: current' '0 current' "$got $(report .outcome): $(tail -5 "$WORK/err")"
[ "$(default)" = "$NEW" ] || fail 'repair: the default stays' "$NEW" "$(default)"
[ "$(shims_of "$NEW")" = "$ALL" ] || fail 'repair: the default has the shims again' "$ALL" "$(shims_of "$NEW")"
has "repair: by the default's own corepack, network off" "$(grep '^corepack' "$LOG")" "corepack[$VERS/v$NEW] enable --install-directory $VERS/v$NEW/.termag-corepack."
has "repair: by the default's own corepack, network off" "$(grep '^corepack' "$LOG")" ' pnpm yarn network=0'
[ -z "$(scratch "$NEW")" ] || fail 'repair: no scratch directory left' none "$(scratch "$NEW")"
lacks 'repair: downloads nothing' "$(cat "$STATE/curl-calls")" 'nodejs.example.test'
[ -z "$(cat "$STATE/restarts" 2>/dev/null)" ] || fail 'repair: the agent is not restarted' none "$(cat "$STATE/restarts")"
has 'repair: the detail' "$(report .detail)" 'corepack=repaired:pnpm+pnpx+yarn+yarnpkg'
# Run again: nothing left to repair.
: > "$LOG"; run
lacks 'repair, again: corepack not run' "$(cat "$LOG")" 'corepack['
# A newer Node due: the default repaired, and the new one gets them too.
reset; lost_shims; policy 200 "$NEWER"
run; got=$?
[ "$got" = 0 ] && [ "$(default)" = "$NEWER" ] || fail 'repair, newer due: switches' "0 $NEWER" "$got $(default): $(tail -5 "$WORK/err")"
[ "$(shims_of "$NEW")" = "$ALL" ] || fail 'repair, newer due: the old default repaired' "$ALL" "$(shims_of "$NEW")"
[ "$(shims_of "$NEWER")" = "$ALL" ] || fail 'repair, newer due: the new default has them' "$ALL" "$(shims_of "$NEWER")"
[ "$(report .outcome)" = updated ] || fail 'repair, newer due: updated' updated "$(report .outcome)"
# A repair that fails: the run fails and says so, the default stays.
reset; lost_shims; policy 200 "$NEW"; : > "$STATE/corepack-fails"
run; got=$?
[ "$(report .outcome)" = failed ] || fail 'repair fails: the run failed' failed "$got $(report .outcome)"
[ "$(default)" = "$NEW" ] || fail 'repair fails: the default stays' "$NEW" "$(default)"
has 'repair fails: says so' "$(cat "$WORK/err")" 'the next run tries those again'

# A command of the owner's is never replaced (Devin on #1224): an npm global's
# pnpm, installed when the shims were lost, stays on the default, and only
# yarn's shims come back from the image's Node.
reset; lost_shims; npm_pnpm "$NEW"; policy 200 "$NEW"
run; got=$?
[ "$(report .outcome)" = current ] || fail "repair, the owner's pnpm: current" current "$got $(report .outcome): $(tail -5 "$WORK/err")"
[ "$(readlink "$VERS/v$NEW/bin/pnpm")" = ../lib/node_modules/pnpm/bin/pnpm.cjs ] || fail "repair, the owner's pnpm: kept" ../lib/node_modules/pnpm/bin/pnpm.cjs "$(readlink "$VERS/v$NEW/bin/pnpm")"
[ "$(readlink "$VERS/v$NEW/bin/pnpx")" = ../lib/node_modules/pnpm/bin/pnpx.cjs ] || fail "repair, the owner's pnpm: its pnpx kept" ../lib/node_modules/pnpm/bin/pnpx.cjs "$(readlink "$VERS/v$NEW/bin/pnpx")"
[ "$(shims_of "$NEW")" = 'yarn yarnpkg ' ] || fail "repair, the owner's pnpm: only yarn's shims added" 'yarn yarnpkg ' "$(shims_of "$NEW")"
has "repair, the owner's pnpm: the detail" "$(report .detail)" 'corepack=repaired:yarn+yarnpkg'
# A broken command is not the owner's to keep (Devin on #1224): a pnpm link
# whose npm global is gone, and a yarn file without the x bit, run nothing, so
# the repair replaces them with corepack's shims.
reset; lost_shims; npm_pnpm "$NEW"; rm -rf "$VERS/v$NEW/lib/node_modules/pnpm"
printf '#!/bin/sh\necho yarn\n' > "$VERS/v$NEW/bin/yarn"; chmod -x "$VERS/v$NEW/bin/yarn"; policy 200 "$NEW"
run; got=$?
[ "$(report .outcome)" = current ] || fail 'repair, broken commands: current' current "$got $(report .outcome): $(tail -5 "$WORK/err")"
[ "$(shims_of "$NEW")" = "$ALL" ] || fail 'repair, broken commands: replaced by the shims' "$ALL" "$(shims_of "$NEW")"
# The same into the staging root: the copied npm global's pnpm stays there,
# and the new Node gets only yarn's shims.
reset; lost_shims; npm_pnpm "$NEW"; policy 200 "$NEWER"
run; got=$?
[ "$got" = 0 ] && [ "$(default)" = "$NEWER" ] || fail "update, the owner's pnpm: switches" "0 $NEWER" "$got $(default): $(tail -5 "$WORK/err")"
[ "$(readlink "$VERS/v$NEWER/bin/pnpm")" = ../lib/node_modules/pnpm/bin/pnpm.cjs ] || fail "update, the owner's pnpm: kept in the new Node" ../lib/node_modules/pnpm/bin/pnpm.cjs "$(readlink "$VERS/v$NEWER/bin/pnpm")"
[ "$(readlink "$VERS/v$NEWER/bin/pnpx")" = ../lib/node_modules/pnpm/bin/pnpx.cjs ] || fail "update, the owner's pnpm: its pnpx kept in the new Node" ../lib/node_modules/pnpm/bin/pnpx.cjs "$(readlink "$VERS/v$NEWER/bin/pnpx")"
[ "$(shims_of "$NEWER")" = 'yarn yarnpkg ' ] || fail "update, the owner's pnpm: only yarn's shims in the new Node" 'yarn yarnpkg ' "$(shims_of "$NEWER")"
[ "$(readlink "$VERS/v$NEW/bin/pnpm")" = ../lib/node_modules/pnpm/bin/pnpm.cjs ] || fail "update, the owner's pnpm: kept on the old default" ../lib/node_modules/pnpm/bin/pnpm.cjs "$(readlink "$VERS/v$NEW/bin/pnpm")"
[ -z "$(scratch "$NEWER")" ] || fail "update, the owner's pnpm: no scratch directory left" none "$(scratch "$NEWER")"
# A repair that does not finish is tried again (Devin on #1224): yarn
# obstructed (a directory in its way), the others linked; with the obstruction
# gone, the next run links yarn.
reset; lost_shims; mkdir "$VERS/v$NEW/bin/yarn"; policy 200 "$NEW"
run; got=$?
[ "$(report .outcome)" = failed ] || fail 'partial repair: the run failed' failed "$got $(report .outcome)"
[ "$(shims_of "$NEW")" = 'pnpm pnpx yarnpkg ' ] || fail 'partial repair: the others linked' 'pnpm pnpx yarnpkg ' "$(shims_of "$NEW")"
has 'partial repair: says what is left' "$(cat "$WORK/err")" '(yarn still missing)'
rmdir "$VERS/v$NEW/bin/yarn"
run; got=$?
[ "$(report .outcome)" = current ] || fail 'partial repair, again: current' current "$got $(report .outcome): $(tail -5 "$WORK/err")"
[ "$(shims_of "$NEW")" = "$ALL" ] || fail "partial repair, again: yarn's shim restored" "$ALL" "$(shims_of "$NEW")"
has 'partial repair, again: the detail' "$(report .detail)" 'corepack=repaired:yarn'

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

# ── the sessions on the old Node (stub updaters) ────────────────────────────
# idle: once the switch stands, each npm global tool's updater, at once, with
# the run's restart and drainSec and its lock free; their counts and panes in
# the report. left-pad has no updater.
reset; policy 200 "$NEW"
printf '%s\n' '{"component":"claude","restart":"idle","sessions":{"stopped":2,"resumed":1,"fresh":1,"cut":0,"typed":1,"other":3,"runnersLeft":0},"panes":[{"session":"ada-proj-agent","role":"agent","sessionId":"0000-11","hadConversation":true},{"session":"scratch","role":"other","hadConversation":false}]}' > "$STATE/sessions-claude"
# (A pane not in the report's shape is dropped, never sent.)
printf '%s\n' '{"component":"codex","restart":"idle","sessions":{"stopped":1,"resumed":1,"fresh":0,"cut":1,"typed":1,"other":1,"runnersLeft":0},"panes":[{"session":"work","role":"other","sessionId":"019a-22","hadConversation":true,"notice":"[termag] Node was updated to 24.22.2 (automatic nightly run); resuming your session."},{"session":"work2","role":"other","hadConversation":true,"notice":"[termag] Node $(touch /tmp/pwned) was updated"},{"session":"bad name","role":"other","hadConversation":true},{"session":"x","role":"boss","hadConversation":true}]}' > "$STATE/sessions-codex"
run; got=$?
[ "$got" = 0 ] || fail 'sessions: exits 0' 0 "$got: $(tail -3 "$WORK/err")"
got=$(grep -- '--sessions' "$STATE/sessions-calls" 2>/dev/null | sort | tr '\n' ',')
[ "$got" = 'claude --sessions idle 5,codex --sessions idle 5,pi --sessions idle 5,' ] || fail 'sessions: each tool'"'"'s updater, with the run'"'"'s restart and drain' 'claude, codex, pi --sessions idle 5' "$got"
[ "$(grep -c lock-free "$STATE/sessions-calls" 2>/dev/null)" = 3 ] || fail 'sessions: each tool'"'"'s lock is free for its updater' 3 "$(cat "$STATE/sessions-calls")"
got=$(report '[.outcome, (.sessions | [.stopped, .resumed, .fresh, .cut, .typed, .other, .runnersLeft] | join(",")), ([.panes[] | "\(.session):\(.role)"] | join(" "))] | join(" ")')
[ "$got" = 'updated 3,2,1,1,2,4,0 ada-proj-agent:agent scratch:other work:other work2:other' ] || fail 'sessions: the tools'"'"' counts and panes in the report' 'updated 3,2,1,1,2,4,0 ada-proj-agent:agent scratch:other work:other work2:other' "$got"
# A pane's notice (for its chat) is kept when it is a safe restart line, and left out when not (Devin on #1301).
got=$(report '[.panes[] | "\(.session)=\(.notice // "-")"] | join("|")')
want='ada-proj-agent=-|scratch=-|work=[termag] Node was updated to 24.22.2 (automatic nightly run); resuming your session.|work2=-'
[ "$got" = "$want" ] || fail 'sessions: a pane keeps a safe notice, and only a safe one' "$want" "$got"
has 'sessions: the detail, per tool' "$(report .detail)" 'sessions=claude=idle:stopped=2:typed=1:resumed=1,codex=idle:stopped=1:typed=1:resumed=1,pi=idle(nothing_on_an_old_binary):stopped=0:typed=0:resumed=0'
has 'sessions: the restart, by each tool' "$(report .detail)" 'restart=idle(by each tool, see sessions=)'
[ "$(report '.panes[0].sessionId')" = 0000-11 ] || fail 'sessions: a pane keeps its conversation id' 0000-11 "$(report '.panes[0].sessionId')"

# force goes to the tools as force.
reset; policy 200 "$NEW" '' force
run
has 'sessions force: the tools get force' "$(cat "$STATE/sessions-calls" 2>/dev/null)" 'codex --sessions force 5'

# restart none: the sessions stay on the old Node, no updater runs.
reset; policy 200 "$NEW" '' none
run; got=$?
[ "$got" = 0 ] && [ "$(default)" = "$NEW" ] || fail 'sessions none: switched' "0 $NEW" "$got $(default)"
[ ! -e "$STATE/sessions-calls" ] || fail 'sessions none: no tool'"'"'s updater runs' none "$(cat "$STATE/sessions-calls")"
has 'sessions none: says so' "$(report .detail)" 'restart=none '

# A switch that does not stand stops nothing: an npm global that does not
# verify under the new Node, an agent that does not come up on the new Node.
reset; policy 200 "$NEW"; echo "codex-cli 0.164.0" > "$STATE/says-codex"
run
[ ! -e "$STATE/sessions-calls" ] || fail 'sessions, no switch: no tool'"'"'s updater runs' none "$(cat "$STATE/sessions-calls")"
reset; policy 200 "$NEW"; : > "$STATE/agent-fails-$NEW"
run
rm -f "$STATE/agent-fails-$NEW"
[ ! -e "$STATE/sessions-calls" ] || fail 'sessions, rolled back: no tool'"'"'s updater runs' none "$(cat "$STATE/sessions-calls")"
# Current: nothing switched, nothing stopped.
reset; policy 200 "$OLD"
run
[ ! -e "$STATE/sessions-calls" ] || fail 'sessions, current: no tool'"'"'s updater runs' none "$(cat "$STATE/sessions-calls")"

# One tool's updater fails: the switch stands, the others' sessions are
# counted, and the run is partial.
reset; policy 200 "$NEW"; : > "$STATE/sessions-fails-codex"
printf '%s\n' '{"component":"claude","restart":"idle","sessions":{"stopped":1,"resumed":1,"fresh":0,"cut":0,"typed":1,"other":0,"runnersLeft":0},"panes":[]}' > "$STATE/sessions-claude"
run; got=$?
[ "$got" = 0 ] && [ "$(default)" = "$NEW" ] || fail 'sessions, a tool fails: the switch stands' "0 $NEW" "$got $(default)"
[ "$(report .outcome)" = partial ] || fail 'sessions, a tool fails: partial' partial "$(report .outcome)"
has 'sessions, a tool fails: says which' "$(report .detail)" 'codex=FAILED'
[ "$(report .sessions.stopped)" = 1 ] || fail 'sessions, a tool fails: the others counted' 1 "$(report .sessions.stopped)"
# A tool whose lock its own update took after the switch restarts nothing: its
# sessions stay on the old Node, and the run is partial (Devin on #1166).
reset; policy 200 "$NEW"
printf '%s\n' '{"component":"pi","restart":"none(lock held)","sessions":{"stopped":0,"resumed":0,"fresh":0,"cut":0,"typed":0,"other":0,"runnersLeft":0},"panes":[]}' > "$STATE/sessions-pi"
run
[ "$(report .outcome)" = partial ] || fail 'sessions, a tool'"'"'s lock held: partial' partial "$(report .outcome)"
has 'sessions, a tool'"'"'s lock held: says which' "$(report .detail)" 'pi=none(lock_held):stopped=0:typed=0:resumed=0:FAILED'
# A tool's updater that is not there: its sessions stay, and the note says so.
reset; policy 200 "$NEW"; mkdir -p "$WORK/two-tools"; cp "$STUB/tools/termag-claude-update" "$STUB/tools/termag-codex-update" "$WORK/two-tools/"
TOOLS="$WORK/two-tools" run
has 'sessions, no pi updater: says so' "$(report .detail)" 'pi=missing'
[ "$(report .outcome)" = updated ] || fail 'sessions, no pi updater: still updated' updated "$(report .outcome)"

# A signal while the tools stop their sessions: each says what it had done,
# and the run reports failed with their panes, so the orchestrator relaunches them.
reset; policy 200 "$NEW"; : > "$STATE/sessions-slow"
run & rp=$!
for _ in $(seq 1 150); do [ "$(grep -c -- --sessions "$STATE/sessions-calls" 2>/dev/null)" = 3 ] && break; sleep 0.2; done
sleep 0.5; kill -TERM "$(pgrep -f "termag-node-update --run $RUN_ID" | head -n 1)"; wait "$rp"; got=$?
[ "$got" = 143 ] || fail 'sessions, a signal: exits 143' 143 "$got"
got=$(report '[.outcome, .sessions.stopped, ([.panes[].session] | sort | join(" "))] | join(" ")')
[ "$got" = 'failed 3 ada-p-claude-agent ada-p-codex-agent ada-p-pi-agent' ] || fail 'sessions, a signal: the tools'"'"' panes reported' 'failed 3 ada-p-claude-agent ada-p-codex-agent ada-p-pi-agent' "$got; $(tail -3 "$WORK/err")"
[ "$(default)" = "$NEW" ] || fail 'sessions, a signal: the switch stands' "$NEW" "$(default)"

# ── the e2e cases ───────────────────────────────────────────────────────────
if ! command -v tmux >/dev/null 2>&1; then
  echo 'skip: e2e cases need tmux'
elif ! sudo -n true 2>/dev/null || ! command -v unshare >/dev/null 2>&1 || ! command -v setpriv >/dev/null 2>&1; then
  echo 'skip: e2e cases need sudo -n, unshare and setpriv (a private PID namespace)'
else
  # As this user, in a PID namespace of its own (/proc remounted), so the
  # real updaters' pgrep sees only the fakes.
  # shellcheck disable=SC2024 # the output file is this user's, not root's
  sudo -n unshare --pid --fork --mount-proc setpriv --reuid="$(id -u)" --regid="$(id -g)" --init-groups \
    env -i PATH=/usr/bin:/bin HOME="$WORK/ns-home" TMPDIR="${TMPDIR:-/tmp}" E2E_SHOW="${E2E_SHOW:-}" sh "$0" --e2e > "$WORK/e2e.out" 2>&1
  rc=$?
  cat "$WORK/e2e.out"
  [ "$rc" = 0 ] || failures=$((failures + 1))
fi

if [ "$failures" -eq 0 ]; then
  echo "ok: termag-node-update"
else
  echo "$failures failure(s)"
  exit 1
fi
