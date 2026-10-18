#!/bin/sh
# Tests deploy/termag-subagent-run, the box side of an agent-to-agent ask
# with stub systemd-run, sudo, curl, getent and
# claude:
#
#   * a first turn clones only the committed code at the base (the branch's
#     newest commit on origin): an unpushed commit, an uncommitted edit and an
#     untracked file never reach the clone
#   * the run goes through systemd-run as the subagent user with the sandbox
#     properties (ProtectHome, ProtectSystem=strict, NoNewPrivileges,
#     IPAddressDeny=any plus the allow list, the thread dirs writable) and the
#     box token as a LoadCredential, which the run's apiKeyHelper prints; the
#     token is never on a command line, and the job and token files are gone
#     after the run
#   * the prompt arrives on stdin and the orchestrator's system prompt as
#     --append-system-prompt; the run's settings carry the gateway env
#   * the clone gets the box user's git template, so a commit-msg hook set
#     through init.templateDir (termag#373's Generated-by trailer) runs on the
#     run's commits
#   * the commits go up as a bundle on the base, authored as the asker, and
#     the result names the session, turns, base, repo and that a bundle went
#   * a second turn resumes the session in the same clone and bundles every
#     commit since the base; a turn whose clone is gone starts a new session
#   * no commits, no upload; a run without a result, a box without gateway
#     settings, and a non-GitHub origin are each reported to the asker
#   * the allow list is the VPC CIDRs from IMDS and the gateway's addresses
#   * idle threads are swept; a bad job exits 2 without reporting
#   * a TERM during the run stops its unit and exits 143 without reporting
#
# Run: sh deploy/termag-subagent-run.test.sh
set -u

DIR="$(cd "$(dirname "$0")" && pwd)"
SCRIPT="$DIR/termag-subagent-run"
EXEC="$DIR/termag-subagent-exec"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

command -v jq >/dev/null 2>&1 || { echo 'SKIP: jq is required' >&2; exit 0; }
command -v flock >/dev/null 2>&1 || { echo 'SKIP: flock is required' >&2; exit 0; }

failures=0
fail() {
  echo "FAIL: $1"
  echo "      want: $2"
  echo "      got:  $3"
  failures=$((failures + 1))
}
eq() { [ "$2" = "$3" ] || fail "$1" "$3" "$2"; }
has() { case "$2" in *"$3"*) : ;; *) fail "$1" "$3" "$2" ;; esac; }
lacks() { case "$2" in *"$3"*) fail "$1" "(no '$3')" "$2" ;; esac; }

export GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null
export HOME="$WORK/home"
STUB="$WORK/stub"
TSTATE="$WORK/state"
ROOT="$WORK/root"
LOG="$WORK/calls"
mkdir -p "$HOME/.config/termag" "$STUB" "$TSTATE" "$ROOT/bin" "$ROOT/threads"
: > "$LOG"
export LOG TSTATE ROOT

TOKEN=tmag_testtoken0123456789
printf '{"token":"%s","termag_url":"wss://orch.example/termag/ws/agent"}\n' "$TOKEN" > "$HOME/agent.config.json"
export TERMAG_AGENT_CONFIG="$HOME/agent.config.json"
printf '{"apiKeyHelper":"x","env":{"CLAUDE_CODE_USE_BEDROCK":"1","ANTHROPIC_BEDROCK_BASE_URL":"https://gateway.internal/bedrock"}}\n' \
  > "$HOME/.config/termag/claude-gateway.json"

# ── the target project: origin "on GitHub", one pushed and one unpushed commit
ORIGIN="$WORK/origin.git"
PROJ="$HOME/proj"
git init -q --bare -b main "$ORIGIN"
git init -q -b main "$PROJ"
gitp() { git -C "$PROJ" -c user.name=o -c user.email=owner@example.com "$@"; }
echo pushed > "$PROJ/pushed.txt"; gitp add pushed.txt; gitp commit -q -m pushed
gitp remote add origin "$ORIGIN"; gitp push -q -u origin main 2>/dev/null
BASE=$(gitp rev-parse HEAD)
echo local > "$PROJ/unpushed.txt"; gitp add unpushed.txt; gitp commit -q -m unpushed
echo dirty >> "$PROJ/pushed.txt"
echo secret > "$PROJ/.env"
gitp remote set-url origin https://github.com/org/repo.git
# A box's GitHub broker rewrite, which `git remote get-url` would expand.
gitp config url.http://broker.internal/.insteadOf https://github.com/

# ── stubs ──────────────────────────────────────────────────────────────────────
cat > "$STUB/sudo" <<'EOF'
#!/bin/sh
[ "${1:-}" = -n ] && shift
echo "sudo $*" >> "$LOG"
exec "$@"
EOF
# systemd-run: records its arguments, then runs the command as this user with
# the --setenv environment, the working directory and the credential.
cat > "$STUB/systemd-run" <<'EOF'
#!/bin/sh
echo "systemd-run $*" >> "$LOG"
envs=""; wd=.; cmd=""
for a in "$@"; do
  case $a in
    --setenv=*) envs="$envs
${a#--setenv=}" ;;
    --working-directory=*) wd=${a#--working-directory=} ;;
    LoadCredential=token:*) mkdir -p "$TSTATE/creds"; cp "${a#LoadCredential=token:}" "$TSTATE/creds/token" ;;
    -*|*=*) ;;
    *) cmd=$a ;;
  esac
done
cd "$wd" || exit 1
printf '%s\n' "$envs" | sed '/^$/d' > "$TSTATE/run-env"
set --
while IFS= read -r kv; do set -- "$@" "$kv"; done < "$TSTATE/run-env"
exec env -i TSTATE="$TSTATE" CREDENTIALS_DIRECTORY="$TSTATE/creds" "$@" "$cmd"
EOF
# curl: IMDS answers from STATE; the orchestrator's routes record what they got
# and answer with STATE/code-<route> (default 204 for the bundle, 202 for the result).
cat > "$STUB/curl" <<'EOF'
#!/bin/sh
url=""; data=""; out=""
while [ $# -gt 0 ]; do
  case $1 in
    --data-binary) data=${2#@}; shift ;;
    -o) out=$2; shift ;;
    -K) cat > "$TSTATE/curl-config" ;;
    http*) url=$1 ;;
  esac
  shift
done
echo "curl $url" >> "$LOG"
case $url in
  */latest/api/token) echo imdstoken ;;
  */meta-data/mac) echo 0a:0b ;;
  */vpc-ipv4-cidr-blocks) printf '10.40.0.0/16\n10.41.0.0/16' ;;
  */bundle) cp "$data" "$TSTATE/uploaded.bundle"; [ -n "$out" ] && : > "$out"; printf '%s' "$(cat "$TSTATE/code-bundle" 2>/dev/null || echo 204)" ;;
  */result) cp "$data" "$TSTATE/result.json"; [ -n "$out" ] && : > "$out"; printf '%s' "$(cat "$TSTATE/code-result" 2>/dev/null || echo 202)" ;;
  *) exit 7 ;;
esac
EOF
# systemctl: records the stop and ends the hanging claude, as stopping its unit would.
cat > "$STUB/systemctl" <<'EOF'
#!/bin/sh
echo "systemctl $*" >> "$LOG"
[ -s "$TSTATE/claude-pid" ] && kill "$(cat "$TSTATE/claude-pid")" 2>/dev/null
exit 0
EOF
cat > "$STUB/getent" <<'EOF'
#!/bin/sh
[ "$2" = gateway.internal ] && printf '10.9.8.7       STREAM gateway.internal\n10.9.8.7       DGRAM\n'
EOF
chmod +x "$STUB"/*
export PATH="$STUB:$PATH"

# The sandbox root termag-subagent-setup would prepare, with a stub claude:
# it records its arguments, stdin and the token its apiKeyHelper prints, and
# commits per STATE/claude-mode (commit | none | crash | hang | reply-<bytes>,
# which commits nothing and replies with that many bytes | utf8-<chars>, the
# same with that many two-byte characters | leak, which replies with the token
# its credential holds).
cp "$EXEC" "$ROOT/bin/termag-subagent-exec"
printf '#!/bin/sh\nexec cat "$CREDENTIALS_DIRECTORY/token"\n' > "$ROOT/bin/termag-subagent-token"
cat > "$ROOT/bin/claude" <<'EOF'
#!/bin/sh
printf '%s\n' "$@" > "$TSTATE/claude-args"
cat > "$TSTATE/claude-stdin"
settings=""; prev=""
for a in "$@"; do [ "$prev" = --settings ] && settings=$a; prev=$a; done
helper=$(jq -r .apiKeyHelper "$settings")
"$helper" > "$TSTATE/helper-token"
env > "$TSTATE/claude-env"
mode=$(cat "$TSTATE/claude-mode" 2>/dev/null || echo commit)
case $mode in
  crash) echo 'boom' >&2; exit 3 ;;
  hang) echo $$ > "$TSTATE/claude-pid"; exec sleep 30 ;;
  commit) n=$(ls | wc -l); echo "change $n" > "change$n.txt"; git add . && git commit -q -m "change $n" ;;
  leak)
    jq -cn --arg t "$(cat "$CREDENTIALS_DIRECTORY/token")" '{type: "result", subtype: "success", is_error: false, result: ("the token is " + $t + "."), session_id: "sess-1", num_turns: 1}'
    exit 0 ;;
  utf8-*)
    i=0; printf x > "$TSTATE/long-reply"
    while [ $i -lt "${mode#utf8-}" ]; do printf 'é%.0s' $(seq 1 1000) >> "$TSTATE/long-reply"; i=$((i + 1000)); done
    jq -cn --rawfile r "$TSTATE/long-reply" '{type: "result", subtype: "success", is_error: false, result: $r, session_id: "sess-1", num_turns: 2}'
    exit 0 ;;
  reply-*)
    head -c "${mode#reply-}" /dev/zero | tr '\0' a > "$TSTATE/long-reply"
    jq -cn --rawfile r "$TSTATE/long-reply" '{type: "result", subtype: "success", is_error: false, result: $r, session_id: "sess-1", num_turns: 2}'
    exit 0 ;;
esac
printf '{"type":"result","subtype":"success","is_error":false,"result":"the answer","session_id":"sess-1","num_turns":2}\n'
EOF
chmod +x "$ROOT/bin/"*
cat > "$STUB/setup" <<'EOF'
#!/bin/sh
echo "setup $*" >> "$LOG"
exit 0
EOF
chmod +x "$STUB/setup"

TERMAG_SUBAGENT_USER="$(id -un)"
export TERMAG_SUBAGENT_ROOT="$ROOT" TERMAG_SUBAGENT_USER TERMAG_SUBAGENT_SETUP="$STUB/setup"
export TERMAG_SUBAGENT_ALLOW='localhost 10.0.0.0/8'

job() {  # job RUN THREAD [extra-json]
  f="$HOME/job-$1.json"
  jq -n --arg run "$1" --arg thread "$2" --arg cwd "$PROJ" --argjson extra "${3:-{\}}" \
    '{runId: $run, threadId: $thread, cwd: $cwd, prompt: "please fix it", systemPrompt: "SYSTEM RULES",
      gitName: "Ada Asker", gitEmail: "ada@example.com", resumeSessionId: null, baseSha: null} + $extra' > "$f"
  printf '%s' "$f"
}
# A box user's git template set through init.templateDir.
mkdir -p "$WORK/git-template/hooks"
printf '#!/bin/sh\ngit interpret-trailers --in-place --trailer "Generated-by: termag" "$1"\n' > "$WORK/git-template/hooks/commit-msg"
chmod +x "$WORK/git-template/hooks/commit-msg"
printf '[init]\n\ttemplateDir = %s\n' "$WORK/git-template" > "$WORK/box-gitconfig"
run() { : > "$LOG"; rm -f "$TSTATE/result.json" "$TSTATE/uploaded.bundle" "$TSTATE/claude-args"; GIT_CONFIG_GLOBAL="$WORK/box-gitconfig" "$SCRIPT" "$@" 2> "$TSTATE/stderr"; }

# ── first turn ──────────────────────────────────────────────────────────────────
J=$(job runaaaa0001 threadaaaa01)
run "$J"; eq 'first turn exits 0' "$?" 0
T="$ROOT/threads/threadaaaa01"
eq 'clone is at the pushed commit' "$(git -C "$T/repo" rev-parse HEAD~1 2>/dev/null)" "$BASE"
[ -e "$T/repo/unpushed.txt" ] && fail 'unpushed commit stays behind' absent present
[ -e "$T/repo/.env" ] && fail 'untracked file stays behind' absent present
eq 'uncommitted edit stays behind' "$(cat "$T/repo/pushed.txt")" pushed
calls=$(cat "$LOG")
has 'runs as the subagent user' "$calls" "--uid=$(id -un)"
has 'starts the system unit through sudo' "$calls" 'sudo systemd-run'
for p in NoNewPrivileges=yes ProtectSystem=strict ProtectHome=yes PrivateTmp=yes IPAddressDeny=any \
         "IPAddressAllow=localhost 10.0.0.0/8" "ReadWritePaths=$T/repo $T/home $T/claude $T/out" \
         "LoadCredential=token:$HOME/.termag/subagent/jobs/runaaaa0001.token"; do
  has "sandbox property $p" "$calls" "$p"
done
lacks 'token never on a command line' "$calls" "$TOKEN"
eq 'apiKeyHelper prints the box token' "$(cat "$TSTATE/helper-token")" "$TOKEN"
eq 'token file removed' "$(ls "$HOME/.termag/subagent/jobs/")" ''
[ -e "$J" ] && fail 'job file removed' absent present
eq 'prompt on stdin' "$(cat "$TSTATE/claude-stdin")" 'please fix it'
args=$(cat "$TSTATE/claude-args")
has 'system prompt appended' "$args" 'SYSTEM RULES'
lacks 'no resume on a first turn' "$args" '--resume'
has 'permission mode' "$args" 'acceptEdits'
eq 'settings carry the gateway env' "$(jq -r .env.ANTHROPIC_BEDROCK_BASE_URL "$T/settings.json")" https://gateway.internal/bedrock
eq 'settings point at the token helper' "$(jq -r .apiKeyHelper "$T/settings.json")" "$ROOT/bin/termag-subagent-token"
has 'run home is the thread home' "$(cat "$TSTATE/claude-env")" "HOME=$T/home"
has 'the bearer goes on curl stdin' "$(cat "$TSTATE/curl-config")" "Authorization: Bearer $TOKEN"
has 'posts to the run route' "$calls" 'curl https://orch.example/termag/api/cli/v1/ask/runs/runaaaa0001/result'
R="$TSTATE/result.json"
eq 'result text' "$(jq -r .result "$R")" 'the answer'
eq 'session id' "$(jq -r .sessionId "$R")" sess-1
eq 'turns' "$(jq -r .numTurns "$R")" 2
eq 'base' "$(jq -r .baseSha "$R")" "$BASE"
eq 'repo, read through the broker rewrite' "$(jq -r .repo "$R")" org/repo
eq 'bundle flag' "$(jq -r .bundle "$R")" true
eq 'no error' "$(jq -r .isError "$R")" false
V="$WORK/verify"; rm -rf "$V"; git clone -q "$ORIGIN" "$V"
git -C "$V" bundle verify -q "$TSTATE/uploaded.bundle" >/dev/null 2>&1 || fail 'bundle applies on the base' ok failed
git -C "$V" fetch -q "$TSTATE/uploaded.bundle" HEAD:refs/heads/tip
eq 'one commit in the bundle' "$(git -C "$V" rev-list --count "$BASE..tip")" 1
eq 'authored as the asker' "$(git -C "$V" log -1 --format='%ae %ce' tip)" 'ada@example.com ada@example.com'
has "the box's commit-msg hook ran" "$(git -C "$V" log -1 --format=%B tip)" 'Generated-by: termag'

# ── second turn on the same thread ────────────────────────────────────────────────
J=$(job runaaaa0002 threadaaaa01 '{"resumeSessionId":"sess-1","baseSha":"'"$BASE"'"}')
run "$J"; eq 'second turn exits 0' "$?" 0
has 'resumes the session' "$(cat "$TSTATE/claude-args")" "$(printf -- '--resume\nsess-1')"
git -C "$V" fetch -q "$TSTATE/uploaded.bundle" HEAD:refs/heads/tip2
eq 'bundle holds every commit since the base' "$(git -C "$V" rev-list --count "$BASE..tip2")" 2

# ── a thread whose clone is not on this box ───────────────────────────────────────
J=$(job runbbbb0001 threadbbbb01 '{"resumeSessionId":"sess-9","baseSha":"'"$BASE"'"}')
run "$J"; eq 'lost clone still runs' "$?" 0
lacks 'and starts a new session' "$(cat "$TSTATE/claude-args")" '--resume'
has 'saying so' "$(cat "$TSTATE/stderr")" 'not on this box'

# ── no commits ──────────────────────────────────────────────────────────────────────
echo none > "$TSTATE/claude-mode"
run "$(job runcccc0001 threadcccc01)"
eq 'no commits, no bundle flag' "$(jq -r .bundle "$TSTATE/result.json")" false
lacks 'and no upload' "$(cat "$LOG")" '/bundle'

# ── a long reply: cut only as far as the API's JSON body limit needs ─────────────
echo reply-70000 > "$TSTATE/claude-mode"
run "$(job runcccc0003 threadcccc01)"
eq 'a 70 KB reply goes up whole' "$(jq -r '.result | length' "$TSTATE/result.json")" 70000
echo reply-150000 > "$TSTATE/claude-mode"
run "$(job runcccc0004 threadcccc01)"
n=$(jq -r '.result | length' "$TSTATE/result.json")
[ "$n" -gt 70000 ] && [ "$(wc -c < "$TSTATE/result.json")" -le 95000 ] || fail 'a 150 KB reply is cut to fit the body' 'over 70000 chars in at most 95000 bytes' "$n chars"
echo utf8-70000 > "$TSTATE/claude-mode"
LC_ALL=C.UTF-8 run "$(job runcccc0005 threadcccc01)"
b=$(wc -c < "$TSTATE/result.json")
[ "$b" -le 95000 ] && [ "$b" -gt 60000 ] || fail 'a multibyte reply is cut by bytes, not characters' 'over 60000 and at most 95000 bytes' "$b bytes"
# One ASCII byte first puts every cut in the middle of an é.
eq 'the cut keeps whole characters' "$(jq -r '.result | test("\ufffd") or (endswith("é") | not)' "$TSTATE/result.json")" false

# ── a reply that prints the box token ──────────────────────────────────────────────
echo leak > "$TSTATE/claude-mode"
run "$(job runcccc0006 threadcccc01)"
eq 'the box token is removed from the reply' "$(jq -r .result "$TSTATE/result.json")" 'the token is [termag: box token removed].'

# ── a run without a result ─────────────────────────────────────────────────────────
echo crash > "$TSTATE/claude-mode"
run "$(job runcccc0002 threadcccc01)"
eq 'crash is an error' "$(jq -r .isError "$TSTATE/result.json")" true
has 'with the exit status' "$(jq -r .exitReason "$TSTATE/result.json")" 'exited 3'
echo commit > "$TSTATE/claude-mode"

# ── no gateway settings ───────────────────────────────────────────────────────────────
mv "$HOME/.config/termag/claude-gateway.json" "$WORK/gw.json"
run "$(job rundddd0001 threaddddd01)"; eq 'exits 1' "$?" 1
has 'reported to the asker' "$(jq -r .result "$TSTATE/result.json")" 'no Claude gateway settings'
lacks 'nothing ran' "$(cat "$LOG")" 'systemd-run'
mv "$WORK/gw.json" "$HOME/.config/termag/claude-gateway.json"

# ── an origin that is not GitHub ──────────────────────────────────────────────────────
gitp remote set-url origin https://gitlab.example/org/repo.git
run "$(job runeeee0001 threadeeee01)"
eq 'no repo' "$(jq -r '.repo // "none"' "$TSTATE/result.json")" none
lacks 'no upload' "$(cat "$LOG")" '/bundle'
has 'the reply says why' "$(jq -r .result "$TSTATE/result.json")" 'no GitHub origin'
gitp remote set-url origin git@github.com:org/repo.git

# ── the computed allow list ───────────────────────────────────────────────────────────
TERMAG_SUBAGENT_ALLOW='' run "$(job runffff0001 threadffff01)"
has 'VPC CIDRs and gateway address' "$(cat "$LOG")" 'IPAddressAllow=localhost 10.40.0.0/16 10.41.0.0/16 10.9.8.7'
eq 'ssh origin parsed' "$(jq -r .repo "$TSTATE/result.json")" org/repo

# ── canceled mid-run ─────────────────────────────────────────────────────────────────
echo hang > "$TSTATE/claude-mode"; rm -f "$TSTATE/claude-pid"
: > "$LOG"; rm -f "$TSTATE/result.json"
J=$(job runhhhh0001 threadhhhh01)
"$SCRIPT" "$J" 2> "$TSTATE/stderr" &
runner=$!
i=0; while [ ! -s "$TSTATE/claude-pid" ] && [ $i -lt 100 ]; do sleep 0.1; i=$((i + 1)); done
kill -TERM "$runner"
wait "$runner"; eq 'a canceled run exits 143' "$?" 143
has 'stops the run unit' "$(cat "$LOG")" 'systemctl stop termag-subagent-runhhhh0001.service'
lacks 'reports nothing' "$(cat "$LOG")" '/result'
has 'says so' "$(cat "$TSTATE/stderr")" 'canceled'
[ -e "$J" ] && fail 'canceled job file removed' absent present
[ -e "$HOME/.termag/subagent/jobs/runhhhh0001.token" ] && fail 'canceled token file removed' absent present
echo commit > "$TSTATE/claude-mode"

# ── sweep and bad input ───────────────────────────────────────────────────────────────
mkdir -p "$ROOT/threads/oldthread0001"
touch -d '2026-01-01' "$ROOT/threads/oldthread0001"
run "$(job rungggg0001 threadgggg01)"
[ -d "$ROOT/threads/oldthread0001" ] && fail 'idle thread swept' removed kept
printf '{"runId":"../x"}' > "$HOME/bad.json"
run "$HOME/bad.json"; eq 'bad job exits 2' "$?" 2
lacks 'without reporting' "$(cat "$LOG")" 'curl'

if [ "$failures" -eq 0 ]; then
  echo 'PASS: committed-only clone, sandbox properties, credential, bundle, resume, errors, allow list, sweep, cancel'
  exit 0
fi
echo "$failures failure(s)"
exit 1
