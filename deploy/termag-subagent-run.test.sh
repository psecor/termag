#!/bin/sh
# Tests deploy/termag-subagent-run, the box side of an agent-to-agent ask,
# with stub curl and claude:
#
#   * a first turn clones only the committed code at the base (the branch's
#     newest commit on origin): an unpushed commit, an uncommitted edit and an
#     untracked file never reach the clone, and the live checkout is untouched
#   * the run is claude -p in the clone, as the box user with its own HOME,
#     bypassPermissions, the prompt on stdin and the orchestrator's system
#     prompt as --append-system-prompt, with the wakeup and cron tools denied
#     (a pending one keeps claude -p up after its answer); no sudo, systemd-run, --settings or
#     credential file; TMUX is unset
#   * the clone gets the box user's git template, so a commit-msg hook set
#     through init.templateDir (termag#373's Generated-by trailer) runs on the
#     run's commits
#   * the commits go up as a bundle on the base, authored as the asker, and
#     the result names the session, turns, base, repo and that a bundle went
#   * a second turn resumes the session in the same clone and bundles every
#     commit since the base; a turn whose clone is gone starts a new session
#   * an ask that arrives before the pane checkout waits for its first commit,
#     and one that never gets a commit is reported once the wait is over
#   * a PR description the run writes to TERMAG_ASK_PR_BODY_FILE goes up with
#     the result, cut to its limit, never in a commit, and only with a bundle
#   * several PRs: the bundle carries `ask` and each pr/<name> branch with
#     commits, a pr/<name> description goes up beside it, refs/termag/base
#     names the base, and a badly named or other branch stays behind, said
#     in the reply; a run that committed only on another branch still sends
#     its HEAD
#   * no commits, no upload; a run without a result and a non-GitHub origin
#     are each reported to the asker; long replies are cut to the body limit
#   * idle threads are swept with their transcripts; a bad job exits 2
#     without reporting
#   * a TERM during the run stops the run's whole process group and exits 143
#     without reporting
#
# Run: sh deploy/termag-subagent-run.test.sh
set -u

DIR="$(cd "$(dirname "$0")" && pwd)"
SCRIPT="$DIR/termag-subagent-run"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

command -v jq >/dev/null 2>&1 || { echo 'SKIP: jq is required' >&2; exit 0; }
command -v flock >/dev/null 2>&1 || { echo 'SKIP: flock is required' >&2; exit 0; }
command -v setsid >/dev/null 2>&1 || { echo 'SKIP: setsid is required' >&2; exit 0; }

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
LOG="$WORK/calls"
mkdir -p "$HOME/.config/termag" "$STUB" "$TSTATE"
: > "$LOG"
export LOG TSTATE
unset TERMAG_SUBAGENT_ROOT
ROOT="$HOME/.termag/subagent"

TOKEN=tmag_testtoken0123456789
printf '{"token":"%s","termag_url":"wss://orch.example/termag/ws/agent"}\n' "$TOKEN" > "$HOME/agent.config.json"
export TERMAG_AGENT_CONFIG="$HOME/agent.config.json"

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
LIVE_HEAD=$(gitp rev-parse HEAD)
echo dirty >> "$PROJ/pushed.txt"
echo secret > "$PROJ/.env"
gitp remote set-url origin https://github.com/org/repo.git
# A box's GitHub broker rewrite, which `git remote get-url` would expand.
gitp config url.http://broker.internal/.insteadOf https://github.com/

# ── stubs ──────────────────────────────────────────────────────────────────────
# curl: the orchestrator's routes record what they got and answer with
# STATE/code-<route> (default 204 for the bundle, 202 for the result).
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
  */bundle) cp "$data" "$TSTATE/uploaded.bundle"; [ -n "$out" ] && : > "$out"; printf '%s' "$(cat "$TSTATE/code-bundle" 2>/dev/null || echo 204)" ;;
  */result) cp "$data" "$TSTATE/result.json"; [ -n "$out" ] && : > "$out"; printf '%s' "$(cat "$TSTATE/code-result" 2>/dev/null || echo 202)" ;;
  *) exit 7 ;;
esac
EOF
for tool in sudo systemd-run systemctl; do
  printf '#!/bin/sh\necho "%s $*" >> "$LOG"\nexit 1\n' "$tool" > "$STUB/$tool"
done
# claude: records its arguments, stdin, cwd and environment, and commits per
# STATE/claude-mode (commit | none | crash | hang, which leaves a child of its
# own running too | reply-<bytes>, which commits nothing and replies with that
# many bytes | utf8-<chars>, the same with that many two-byte characters).
mkdir -p "$WORK/claudebin"
cat > "$WORK/claudebin/claude" <<'EOF'
#!/bin/sh
printf '%s\n' "$@" > "$TSTATE/claude-args"
cat > "$TSTATE/claude-stdin"
pwd > "$TSTATE/claude-cwd"
env > "$TSTATE/claude-env"
[ -f "$TSTATE/pr-body" ] && cp "$TSTATE/pr-body" "$TERMAG_ASK_PR_BODY_FILE"
mode=$(cat "$TSTATE/claude-mode" 2>/dev/null || echo commit)
case $mode in
  crash) echo 'boom' >&2; exit 3 ;;
  hang) sleep 60 & echo $! > "$TSTATE/tool-pid"; echo $$ > "$TSTATE/claude-pid"; wait; exit 0 ;;
  commit) n=$(ls | wc -l); echo "change $n" > "change$n.txt"; git add . && git commit -q -m "change $n" ;;
  multi)
    echo a > multi-a.txt; git add . && git commit -q -m 'multi a'
    git switch -q -c pr/docs termag/base && echo d > docs.txt && git add . && git commit -q -m docs
    printf '# Docs\n\nThe docs half.\n' > "$TERMAG_ASK_PR_DIR/docs.md"
    git switch -q -c pr/Bad termag/base && echo b > bad.txt && git add . && git commit -q -m bad
    git switch -q -c scratch termag/base && echo s > s.txt && git add . && git commit -q -m scratch
    git switch -q ask ;;
  elsewhere) git switch -q -c elsewhere termag/base && echo e > e.txt && git add . && git commit -q -m elsewhere ;;
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
chmod +x "$STUB"/* "$WORK/claudebin/claude"
export PATH="$STUB:$PATH" TERMAG_SUBAGENT_CLAUDE="$WORK/claudebin/claude" TERMAG_SUBAGENT_KILL_GRACE_S=2
export TMUX=/tmp/tmux-1000/default,1,0 TMUX_PANE=%3

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
eq 'live checkout HEAD untouched' "$(gitp rev-parse HEAD)" "$LIVE_HEAD"
eq 'live checkout edit untouched' "$(cat "$PROJ/pushed.txt")" "$(printf 'pushed\ndirty')"
eq 'thread dir is private' "$(stat -c %a "$T")" 700
calls=$(cat "$LOG")
lacks 'no sudo' "$calls" 'sudo'
lacks 'no systemd-run' "$calls" 'systemd-run'
[ -e "$J" ] && fail 'job file removed' absent present
eq 'runs in the clone' "$(cat "$TSTATE/claude-cwd")" "$T/repo"
eq 'prompt on stdin' "$(cat "$TSTATE/claude-stdin")" 'please fix it'
args=$(cat "$TSTATE/claude-args")
has 'system prompt appended' "$args" "$(printf -- '--append-system-prompt\nSYSTEM RULES')"
lacks 'no resume on a first turn' "$args" '--resume'
has 'permission mode' "$args" "$(printf -- '--permission-mode\nbypassPermissions')"
has 'no wakeups or crons to outlive the answer' "$args" "$(printf -- '--disallowedTools\nScheduleWakeup CronCreate')"
lacks 'no settings override' "$args" '--settings'
env_=$(cat "$TSTATE/claude-env")
has "the box user's own HOME" "$env_" "HOME=$HOME"
lacks 'no TMUX, so status hooks post nothing' "$env_" 'TMUX='
lacks 'no CLAUDE_CONFIG_DIR override' "$env_" 'CLAUDE_CONFIG_DIR='
lacks 'token never in the run env' "$env_" "$TOKEN"
has 'the bearer goes on curl stdin' "$(cat "$TSTATE/curl-config")" "Authorization: Bearer $TOKEN"
lacks 'token never on a command line' "$calls" "$TOKEN"
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
git -C "$V" fetch -q "$TSTATE/uploaded.bundle" refs/heads/ask:refs/heads/tip
eq 'one commit in the bundle' "$(git -C "$V" rev-list --count "$BASE..tip")" 1
eq 'authored as the asker' "$(git -C "$V" log -1 --format='%ae %ce' tip)" 'ada@example.com ada@example.com'
has "the box's commit-msg hook ran" "$(git -C "$V" log -1 --format=%B tip)" 'Generated-by: termag'
has 'the run is told where a PR description goes' "$env_" "TERMAG_ASK_PR_BODY_FILE=$T/repo/.git/termag-pr-body.md"
eq 'no description written, none sent' "$(jq -r .prDescription "$R")" null

# ── second turn on the same thread ────────────────────────────────────────────────
J=$(job runaaaa0002 threadaaaa01 '{"resumeSessionId":"sess-1","baseSha":"'"$BASE"'"}')
run "$J"; eq 'second turn exits 0' "$?" 0
has 'resumes the session' "$(cat "$TSTATE/claude-args")" "$(printf -- '--resume\nsess-1')"
git -C "$V" fetch -q "$TSTATE/uploaded.bundle" refs/heads/ask:refs/heads/tip2
eq 'bundle holds every commit since the base' "$(git -C "$V" rev-list --count "$BASE..tip2")" 2

# ── a PR description the run wrote ─────────────────────────────────────────────────
printf '# Fix it\n\nWhat changed, é.\n' > "$TSTATE/pr-body"
run "$(job runaaaa0003 threadaaaa01 '{"resumeSessionId":"sess-1","baseSha":"'"$BASE"'"}')"
eq 'the description goes up with the result' "$(jq -r .prDescription "$TSTATE/result.json")" "$(printf '# Fix it\n\nWhat changed, é.')"
git -C "$V" fetch -q "$TSTATE/uploaded.bundle" refs/heads/ask:refs/heads/tip3
lacks 'and never in a commit' "$(git -C "$V" log --name-only --format= "$BASE..tip3")" 'termag-pr-body'
rm -f "$TSTATE/pr-body"
run "$(job runaaaa0004 threadaaaa01 '{"resumeSessionId":"sess-1","baseSha":"'"$BASE"'"}')"
has 'a later turn that leaves it alone sends it again' "$(jq -r .prDescription "$TSTATE/result.json")" '# Fix it'
head -c 50000 /dev/zero | tr '\0' d > "$TSTATE/pr-body"
run "$(job runaaaa0005 threadaaaa01 '{"resumeSessionId":"sess-1","baseSha":"'"$BASE"'"}')"
eq 'a long description is cut' "$(jq -j .prDescription "$TSTATE/result.json" | wc -c)" 20000
rm -f "$TSTATE/pr-body"

# ── several PRs from one run ─────────────────────────────────────────────────────
echo multi > "$TSTATE/claude-mode"
run "$(job runmmmm0001 threadmmmm01)"; eq 'a multi-branch run exits 0' "$?" 0
TM="$ROOT/threads/threadmmmm01"
eq 'refs/termag/base names the base' "$(git -C "$TM/repo" rev-parse refs/termag/base)" "$BASE"
has 'the run is told where pr/<name> descriptions go' "$(cat "$TSTATE/claude-env")" "TERMAG_ASK_PR_DIR=$TM/repo/.git/termag-prs"
heads=$(git -C "$V" bundle list-heads "$TSTATE/uploaded.bundle" | awk '{print $2}' | sort | tr '\n' ' ')
eq 'the bundle carries ask and pr/docs only' "$heads" 'refs/heads/ask refs/heads/pr/docs '
git -C "$V" bundle verify -q "$TSTATE/uploaded.bundle" >/dev/null 2>&1 || fail 'the multi-branch bundle applies on the base' ok failed
git -C "$V" fetch -q "$TSTATE/uploaded.bundle" refs/heads/pr/docs:refs/heads/docs
eq 'pr/docs holds its own commit on the base' "$(git -C "$V" log --format=%s "$BASE..docs" | head -1)" docs
eq "pr/docs's description goes up beside it" "$(jq -r '.prDescriptions.docs' "$TSTATE/result.json")" "$(printf '# Docs\n\nThe docs half.')"
eq 'only the pr/<name> branches have one' "$(jq -r '.prDescriptions | keys | join(",")' "$TSTATE/result.json")" docs
reply=$(jq -r .result "$TSTATE/result.json")
has 'a badly named PR branch is said to stay behind' "$reply" 'branch pr/Bad was not published'
has 'and so is any other branch' "$reply" 'branch scratch has 1 commit(s) that were not published'
echo elsewhere > "$TSTATE/claude-mode"
run "$(job runnnnn0001 threadnnnn01)"
eq 'a run that committed only on another branch still sends its HEAD' \
  "$(git -C "$V" bundle list-heads "$TSTATE/uploaded.bundle" | awk '{print $2}')" HEAD
eq 'with no pr/<name> descriptions' "$(jq -c .prDescriptions "$TSTATE/result.json")" '{}'
echo commit > "$TSTATE/claude-mode"

# ── a thread whose clone is not on this box ───────────────────────────────────────
J=$(job runbbbb0001 threadbbbb01 '{"resumeSessionId":"sess-9","baseSha":"'"$BASE"'"}')
run "$J"; eq 'lost clone still runs' "$?" 0
lacks 'and starts a new session' "$(cat "$TSTATE/claude-args")" '--resume'
has 'saying so' "$(cat "$TSTATE/stderr")" 'not on this box'

# ── no commits ──────────────────────────────────────────────────────────────────────
echo none > "$TSTATE/claude-mode"
run "$(job runcccc0001 threadcccc01)"
eq 'no commits, no bundle flag' "$(jq -r .bundle "$TSTATE/result.json")" false
printf 'stray\n' > "$ROOT/threads/threadcccc01/repo/.git/termag-pr-body.md"
run "$(job runcccc0002 threadcccc01)"
eq 'no bundle, no description' "$(jq -r .prDescription "$TSTATE/result.json")" null
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

# ── a run without a result ─────────────────────────────────────────────────────────
echo crash > "$TSTATE/claude-mode"
run "$(job runcccc0002 threadcccc01)"
eq 'crash is an error' "$(jq -r .isError "$TSTATE/result.json")" true
has 'with the exit status' "$(jq -r .exitReason "$TSTATE/result.json")" 'exited 3'
echo commit > "$TSTATE/claude-mode"

# ── an ask that beats the pane checkout ──────────────────────────────────────────────
# The dir, its repo and its first commit appear while the run waits for them.
LATE="$HOME/late"
( sleep 3; git init -q -b main "$LATE" \
    && git -C "$LATE" -c user.name=o -c user.email=owner@example.com commit -q --allow-empty -m first ) &
TERMAG_SUBAGENT_CHECKOUT_WAIT_S=30 run "$(job runiiii0001 threadiiii01 '{"cwd":"'"$LATE"'"}')"; eq 'a late checkout still runs' "$?" 0
wait
has 'after waiting for it' "$(cat "$TSTATE/stderr")" 'waiting up to 30s'
has 'and answers' "$(jq -r .result "$TSTATE/result.json")" 'the answer'
# One that never gets a commit is reported once the wait is over.
EMPTY="$HOME/empty"; git init -q -b main "$EMPTY"
TERMAG_SUBAGENT_CHECKOUT_WAIT_S=2 run "$(job runiiii0002 threadiiii02 '{"cwd":"'"$EMPTY"'"}')"
has 'an empty checkout is reported' "$(jq -r .result "$TSTATE/result.json")" 'has no commits'

# ── no claude on the box ─────────────────────────────────────────────────────────────
TERMAG_SUBAGENT_CLAUDE='' NVM_DIR="$WORK/no-nvm" PATH="$STUB:/usr/bin:/bin" run "$(job rundddd0001 threaddddd01)"; eq 'no claude exits 1' "$?" 1
has 'reported to the asker' "$(jq -r .result "$TSTATE/result.json")" 'Claude Code is not installed'

# ── an origin that is not GitHub ──────────────────────────────────────────────────────
gitp remote set-url origin https://gitlab.example/org/repo.git
run "$(job runeeee0001 threadeeee01)"
eq 'no repo' "$(jq -r '.repo // "none"' "$TSTATE/result.json")" none
lacks 'no upload' "$(cat "$LOG")" '/bundle'
has 'the reply says why' "$(jq -r .result "$TSTATE/result.json")" 'no GitHub origin'
gitp remote set-url origin git@github.com:org/repo.git
run "$(job runffff0001 threadffff01)"
eq 'ssh origin parsed' "$(jq -r .repo "$TSTATE/result.json")" org/repo

# ── canceled mid-run ─────────────────────────────────────────────────────────────────
echo hang > "$TSTATE/claude-mode"; rm -f "$TSTATE/claude-pid" "$TSTATE/tool-pid"
: > "$LOG"; rm -f "$TSTATE/result.json"
J=$(job runhhhh0001 threadhhhh01)
"$SCRIPT" "$J" 2> "$TSTATE/stderr" &
runner=$!
i=0; while { [ ! -s "$TSTATE/claude-pid" ] || [ ! -s "$TSTATE/tool-pid" ]; } && [ $i -lt 100 ]; do sleep 0.1; i=$((i + 1)); done
kill -TERM "$runner"
wait "$runner"; eq 'a canceled run exits 143' "$?" 143
sleep 0.2
kill -0 "$(cat "$TSTATE/claude-pid")" 2>/dev/null && fail 'the run is stopped' gone running
kill -0 "$(cat "$TSTATE/tool-pid")" 2>/dev/null && fail "and the run's own children with it" gone running
lacks 'reports nothing' "$(cat "$LOG")" '/result'
has 'says so' "$(cat "$TSTATE/stderr")" 'canceled'
[ -e "$J" ] && fail 'canceled job file removed' absent present
echo commit > "$TSTATE/claude-mode"

# ── phases, for a chat-runner turn (ask-chat-v1) ─────────────────────────────────────
has 'the script announces its phases' "$(cat "$SCRIPT")" 'Phases: ask-chat-v1'
J=$(job runkkkk0001 threadkkkk01)
: > "$LOG"; rm -f "$TSTATE/claude-args"
out=$(GIT_CONFIG_GLOBAL="$WORK/box-gitconfig" "$SCRIPT" --prepare "$J" 2> "$TSTATE/stderr"); eq '--prepare exits 0' "$?" 0
TK="$ROOT/threads/threadkkkk01"
eq '--prepare names the clone' "$(printf '%s' "$out" | jq -r .repoDir)" "$TK/repo"
eq '--prepare names the base' "$(printf '%s' "$out" | jq -r .base)" "$BASE"
eq '--prepare names the repo' "$(printf '%s' "$out" | jq -r .repo)" org/repo
eq 'a new clone is fresh' "$(printf '%s' "$out" | jq -r .fresh)" true
eq 'the clone is at the base' "$(git -C "$TK/repo" rev-parse HEAD)" "$BASE"
[ -e "$J" ] || fail '--prepare keeps the job for the report' kept removed
[ -e "$TSTATE/claude-args" ] && fail '--prepare runs no claude' 'no run' ran
lacks '--prepare reports nothing' "$(cat "$LOG")" 'curl'
out=$("$SCRIPT" --prepare "$J" 2>/dev/null)
eq 'a reused clone is not fresh' "$(printf '%s' "$out" | jq -r .fresh)" false
# The chat turn commits in the clone, then reports from its result event.
git -C "$TK/repo" -c user.name=Ada -c user.email=ada@example.com commit -q --allow-empty -m 'chat change'
printf '{"type":"result","subtype":"success","is_error":false,"result":"chat answer","session_id":"sess-chat","num_turns":3}\n' > "$HOME/result-k.json"
run --report "$J" "$HOME/result-k.json"; eq '--report exits 0' "$?" 0
R="$TSTATE/result.json"
eq '--report posts the reply' "$(jq -r .result "$R")" 'chat answer'
eq '--report posts the session' "$(jq -r .sessionId "$R")" sess-chat
eq '--report posts the turns' "$(jq -r .numTurns "$R")" 3
eq '--report posts the base' "$(jq -r .baseSha "$R")" "$BASE"
eq '--report uploads the bundle' "$(jq -r .bundle "$R")" true
has 'to the run route' "$(cat "$LOG")" 'runs/runkkkk0001/bundle'
[ -e "$J" ] && fail '--report removes the job' removed kept
# A turn that stopped without a result event.
J=$(job runkkkk0002 threadkkkk01)
printf '{"type":"result","subtype":"error_turn_stopped","is_error":true,"result":"stopped"}\n' > "$HOME/result-k2.json"
run --report "$J" "$HOME/result-k2.json"
eq 'a stopped turn is an error' "$(jq -r .isError "$TSTATE/result.json")" true
has 'naming why' "$(jq -r .exitReason "$TSTATE/result.json")" 'error_turn_stopped'
J=$(job runkkkk0003 threadkkkk01)
run --fail "$J" 'the chat runner refused the turn'; eq '--fail exits 1' "$?" 1
eq '--fail is an error reply' "$(jq -r .isError "$TSTATE/result.json")" true
has 'with the reason' "$(jq -r .result "$TSTATE/result.json")" 'the chat runner refused the turn'
[ -e "$J" ] && fail '--fail removes the job' removed kept
# Several PRs from a chat turn: --prepare names where the descriptions go and
# sets refs/termag/base; the turn (ask-chat.js passes the two paths as
# TERMAG_ASK_PR_BODY_FILE / TERMAG_ASK_PR_DIR) writes them; --report sends
# every branch and description, as the full run does.
J=$(job runpppp0001 threadpppp01)
out=$(GIT_CONFIG_GLOBAL="$WORK/box-gitconfig" "$SCRIPT" --prepare "$J" 2> "$TSTATE/stderr"); eq 'a chat prepare exits 0' "$?" 0
TP="$ROOT/threads/threadpppp01"
eq '--prepare names the PR description file' "$(printf '%s' "$out" | jq -r .prBodyFile)" "$TP/repo/.git/termag-pr-body.md"
eq '--prepare names the pr/<name> description dir' "$(printf '%s' "$out" | jq -r .prDir)" "$TP/repo/.git/termag-prs"
[ -d "$TP/repo/.git/termag-prs" ] || fail '--prepare makes that dir' made missing
eq '--prepare sets refs/termag/base' "$(git -C "$TP/repo" rev-parse refs/termag/base)" "$BASE"
echo multi > "$TSTATE/claude-mode"
printf '# The main fix\n' > "$TSTATE/pr-body"
( cd "$TP/repo" && TERMAG_ASK_PR_BODY_FILE=$(printf '%s' "$out" | jq -r .prBodyFile) TERMAG_ASK_PR_DIR=$(printf '%s' "$out" | jq -r .prDir) \
    GIT_AUTHOR_NAME=Ada GIT_AUTHOR_EMAIL=ada@example.com GIT_COMMITTER_NAME=Ada GIT_COMMITTER_EMAIL=ada@example.com \
    "$WORK/claudebin/claude" < /dev/null > "$HOME/result-p.json" )
rm -f "$TSTATE/pr-body"; echo commit > "$TSTATE/claude-mode"
run --report "$J" "$HOME/result-p.json"; eq 'a chat report of several branches exits 0' "$?" 0
heads=$(git -C "$V" bundle list-heads "$TSTATE/uploaded.bundle" | awk '{print $2}' | sort | tr '\n' ' ')
eq "the chat turn's bundle carries ask and pr/docs only" "$heads" 'refs/heads/ask refs/heads/pr/docs '
git -C "$V" bundle verify -q "$TSTATE/uploaded.bundle" >/dev/null 2>&1 || fail "the chat turn's bundle applies on the base" ok failed
eq "the chat turn's PR description goes up" "$(jq -r .prDescription "$TSTATE/result.json")" '# The main fix'
eq "and pr/docs's beside it" "$(jq -r '.prDescriptions.docs' "$TSTATE/result.json")" "$(printf '# Docs\n\nThe docs half.')"
has 'what stays behind is said in the reply' "$(jq -r .result "$TSTATE/result.json")" 'branch scratch has 1 commit(s) that were not published'
# A person's message in the ask's chat: no run, nothing reported.
J=$(job '' threadmmmm01 '{"cwd":"'"$HOME"'/nowhere","waitForCheckout":false}')
run --prepare "$J"; eq 'a failed prepare without a run exits 1' "$?" 1
lacks 'and reports nothing' "$(cat "$LOG")" 'curl'
has 'saying why on stderr' "$(cat "$TSTATE/stderr")" 'does not exist'

# ── sweep and bad input ───────────────────────────────────────────────────────────────
OLD="$ROOT/threads/oldthread0001"
mkdir -p "$OLD/repo"
SLUG=$(printf '%s' "$OLD/repo" | sed 's/[^A-Za-z0-9]/-/g')
mkdir -p "$HOME/.claude/projects/$SLUG" "$HOME/.claude/projects/-keep-me"
touch -d '2026-01-01' "$OLD"
run "$(job rungggg0001 threadgggg01)"
[ -d "$OLD" ] && fail 'idle thread swept' removed kept
[ -d "$HOME/.claude/projects/$SLUG" ] && fail "and its Claude transcripts" removed kept
[ -d "$HOME/.claude/projects/-keep-me" ] || fail "other projects' transcripts kept" kept removed
printf '{"runId":"../x"}' > "$HOME/bad.json"
run "$HOME/bad.json"; eq 'bad job exits 2' "$?" 2
lacks 'without reporting' "$(cat "$LOG")" 'curl'

if [ "$failures" -eq 0 ]; then
  echo 'PASS: committed-only clone, run as the box user, bundle, PR description, several PRs, resume, errors, sweep, cancel'
  exit 0
fi
echo "$failures failure(s)"
exit 1
