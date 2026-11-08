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
#   * push mode (ask-push-v1, a job with pushBranch): a normal clone with
#     origin, not shallow and without the live checkout's unpushed commits,
#     on the thread's branch tracking the default branch; the run pushes
#     itself, the result names the branches the clone pushed and no bundle
#     goes up; a branch with commits it did not push is said in the reply;
#     the pre-push hook refuses the default branch; a person's prepare keeps
#     the layout; an older clone of the thread is converted in place; a
#     checkout that borrows a store (the baked webapp) has it linked into
#     the clone, which borrows nothing and outlives both
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
# Not inherited from a session that runs these tests.
unset TERMAG_ASK_PR_BODY_FILE TERMAG_ASK_PR_DIR TERMAG_ASK_THREAD
unset GIT_AUTHOR_NAME GIT_AUTHOR_EMAIL GIT_COMMITTER_NAME GIT_COMMITTER_EMAIL EMAIL
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
  push)
    b=$(git branch --show-current)
    echo p > pushed-change.txt && git add . && git commit -q -m 'push change'
    git push -q origin "HEAD:$b" 2> "$TSTATE/push-stderr"
    git switch -q -c "$b-docs" origin/main && echo d > docs.txt && git add . && git commit -q -m docs && git push -q origin HEAD 2>> "$TSTATE/push-stderr"
    git switch -q -c scratch origin/main && echo s > s.txt && git add . && git commit -q -m scratch
    git switch -q "$b" ;;
  push-main)
    echo m > main-change.txt && git add . && git commit -q -m 'onto main'
    git push origin HEAD:main 2> "$TSTATE/push-stderr"; echo $? > "$TSTATE/push-exit" ;;
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

# ── a run the orchestrator caps (a project from a shared environment) ─────────────
for capped in auto dontAsk; do
  J=$(job runaaaa0007 threadaaaa07 '{"permissionMode":"'"$capped"'"}')
  run "$J"; eq "$capped run exits 0" "$?" 0
  args=$(cat "$TSTATE/claude-args")
  has "$capped: its mode" "$args" "$(printf -- '--permission-mode\n%s' "$capped")"
  lacks "$capped: never bypassPermissions" "$args" 'bypassPermissions'
  # The JSON goes in as an argument: a \" in a printf format is dash's to keep as it is.
  has "$capped: no .mcp.json" "$args" "$(printf -- '--strict-mcp-config\n--mcp-config\n%s' '{"mcpServers":{}}')"
  has "$capped: no checkout settings" "$args" "$(printf -- '--setting-sources\nuser')"
  has "$capped: no hooks" "$args" "$(printf -- '--settings\n%s' '{"disableAllHooks":true}')"
  if [ "$capped" = dontAsk ]; then has 'dontAsk: read-only tools' "$args" "$(printf -- '--tools\nRead,Grep,Glob')"
  else lacks 'auto: every tool' "$args" '--tools'; fi
done
J=$(job runaaaa0008 threadaaaa08 '{"permissionMode":"acceptEdits"}')
run "$J"; has 'any other mode is the ask'"'"'s own' "$(cat "$TSTATE/claude-args")" "$(printf -- '--permission-mode\nbypassPermissions')"

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

# ── push mode (ask-push-v1) ───────────────────────────────────────────────────────────
# "GitHub" is the bare origin, reached through the box's own rewrite as the broker is.
printf '[init]\n\ttemplateDir = %s\n[url "%s"]\n\tinsteadOf = https://github.com/org/repo.git\n' "$WORK/git-template" "$ORIGIN" > "$WORK/box-gitconfig-push"
runp() { : > "$LOG"; rm -f "$TSTATE/result.json" "$TSTATE/uploaded.bundle" "$TSTATE/claude-args"; GIT_CONFIG_GLOBAL="$WORK/box-gitconfig-push" "$SCRIPT" "$@" 2> "$TSTATE/stderr"; }
SAVED_ORIGIN=$(gitp config --get remote.origin.url)
gitp remote set-url origin https://github.com/org/repo.git
echo push > "$TSTATE/claude-mode"
PB=termag-ada/threadpush01
runp "$(job runpush0001 threadpush01 '{"pushBranch":"'"$PB"'"}')"; eq 'a push-mode turn exits 0' "$?" 0
P="$ROOT/threads/threadpush01/repo"
eq 'the clone has origin, as the checkout names it' "$(git -C "$P" config --get remote.origin.url)" https://github.com/org/repo.git
eq 'and is not shallow' "$(git -C "$P" rev-parse --is-shallow-repository)" false
git -C "$P" cat-file -e "$LIVE_HEAD^{commit}" 2>/dev/null && fail "the live checkout's unpushed commit stays out of the clone" absent present
eq 'the run is on the thread branch' "$(git -C "$P" branch --show-current)" "$PB"
eq 'which tracks the default branch, so it is its own tree' "$(git -C "$P" rev-parse --abbrev-ref "$PB@{upstream}")" origin/main
eq 'origin/HEAD names the default branch, as a clone sets it' "$(git -C "$P" symbolic-ref refs/remotes/origin/HEAD 2>/dev/null)" refs/remotes/origin/main
git -C "$P" rev-parse -q --verify refs/termag/base >/dev/null && fail 'no refs/termag/base in a push clone' absent present
if command -v node >/dev/null 2>&1; then
  own=$(node -e 'const c = require(process.argv[1]); c.readCheckoutFacts(process.argv[2]).then(f => process.stdout.write(String(c.checkoutOwnTree(f))))' "$DIR/../agent/chat-runner.js" "$P" 2>&1)
  eq "the chat runner sees the push clone as the project's own tree (gotcha ask-push-clone-upstream)" "$own" true
fi
[ -x "$P/.git/hooks/pre-push" ] || fail 'the clone has the pre-push hook' present absent
# A commit GitHub doesn't have that changes .github/workflows: the hook says what a
# refusal for want of the workflow scope means; one that doesn't change it, nothing.
Z=0000000000000000000000000000000000000000
wf=$(printf 'on: push\n' | git -C "$P" hash-object -w --stdin)
wft=$(printf '100644 blob %s\tci.yml\n' "$wf" | git -C "$P" mktree)
ght=$(printf '040000 tree %s\tworkflows\n' "$wft" | git -C "$P" mktree)
wtree=$( { git -C "$P" ls-tree HEAD | grep -v '	\.github$'; printf '040000 tree %s\t.github\n' "$ght"; } | git -C "$P" mktree)
wc=$(GIT_AUTHOR_NAME=Ada GIT_AUTHOR_EMAIL=ada@example.com GIT_COMMITTER_NAME=Ada GIT_COMMITTER_EMAIL=ada@example.com git -C "$P" commit-tree -p HEAD -m workflow "$wtree")
pc=$(GIT_AUTHOR_NAME=Ada GIT_AUTHOR_EMAIL=ada@example.com GIT_COMMITTER_NAME=Ada GIT_COMMITTER_EMAIL=ada@example.com git -C "$P" commit-tree -p HEAD -m plain "$(git -C "$P" rev-parse 'HEAD^{tree}')")
hook_out=$(cd "$P" && printf 'refs/heads/x %s refs/heads/x %s\n' "$wc" "$Z" | .git/hooks/pre-push origin https://github.com/org/repo.git 2>&1)
has "the pre-push hook explains a workflow-scope refusal for a push that changes workflows" "$hook_out" 'this push changes workflow files compared with GitHub'"'"'s copy, and the stored GitHub token has no `workflow` scope'
has 'naming the rebase' "$hook_out" 'rebase onto the current origin/main and push again'
has 'and the refresh' "$hook_out" 'gh auth refresh -h github.com -s workflow'
hook_out=$(cd "$P" && printf 'refs/heads/x %s refs/heads/x %s\n' "$pc" "$Z" | .git/hooks/pre-push origin https://github.com/org/repo.git 2>&1)
lacks 'and says nothing of it for a push that does not' "$hook_out" 'workflow'
# The hook's warnings count only what the branch adds: not main's commits or files that a
# merge of origin/main brings in, nor those of a merged branch cut from a newer main.
HO="$WORK/hook-origin.git" H="$WORK/hook-clone" H2="$WORK/hook-other"
git init -q --bare -b main "$HO"
as() { who=$1; shift; GIT_AUTHOR_NAME=$who GIT_AUTHOR_EMAIL=$who@example.com GIT_COMMITTER_NAME=$who GIT_COMMITTER_EMAIL=$who@example.com git "$@"; }
hcommit() { d=$1 who=$2 f=$3; mkdir -p "$d/$(dirname "$f")"; echo "$who $f" >> "$d/$f"; git -C "$d" add "$f"; as "$who" -C "$d" commit -q -m "$who $f"; }
git clone -q "$HO" "$H" 2>/dev/null
hcommit "$H" bob README; git -C "$H" push -q origin HEAD:main 2>/dev/null
cp "$P/.git/hooks/pre-push" "$H/.git/hooks/pre-push"
git -C "$H" config termag.defaultBranch main; git -C "$H" config termag.askerEmail ada@example.com
git -C "$H" switch -q -c termag-ada/hook
hpush() { git -C "$H" push -q origin HEAD:termag-ada/hook 2>&1; }
hcommit "$H" ada src/a.txt
out=$(hpush); eq "a new branch of the asker's own commits pushes without a warning" "$out" ''
git clone -q "$HO" "$H2" 2>/dev/null
hcommit "$H2" bob .github/workflows/ci.yml; hcommit "$H2" bob CODEOWNERS; git -C "$H2" push -q origin HEAD:main 2>/dev/null
git -C "$H" fetch -q origin; as ada -C "$H" merge -q --no-ff --no-edit origin/main
out=$(hpush)
lacks "merging origin/main adds none of main's commits to the author warning" "$out" 'not authored'
lacks "nor main's files to the protected-files warning" "$out" 'protected files'
# Main moves on past this clone's origin/main; another branch is cut from it and merged.
hcommit "$H2" carol .github/workflows/release.yml; git -C "$H2" push -q origin HEAD:main 2>/dev/null
git -C "$H2" switch -q -c feat/other; hcommit "$H2" carol src/other.txt; git -C "$H2" push -q origin feat/other 2>/dev/null
git -C "$H" fetch -q origin feat/other:refs/remotes/origin/feat/other
as ada -C "$H" merge -q --no-ff --no-edit origin/feat/other
out=$(hpush)
lacks "a merged branch cut from a newer main adds none of its commits to the author warning" "$out" 'not authored'
lacks "nor that main's files to the protected-files warning" "$out" 'protected files'
# What the branch itself adds is still warned about.
hcommit "$H" ada .github/workflows/mine.yml; hcommit "$H" eve src/b.txt
out=$(hpush)
has "the branch's own protected file is warned about" "$out" '.github/workflows/mine.yml'
lacks "and only it" "$out" 'ci.yml'
has "a commit of another author's is warned about" "$out" 'eve@example.com'
lacks "and only it" "$out" 'bob@example.com'
# A protected file the branch changed and changed back is not in the PR's diff.
git -C "$H" rm -q .github/workflows/mine.yml; as ada -C "$H" commit -q -m 'back'
hcommit "$H" ada CODEOWNERS; git -C "$H" checkout -q origin/main -- CODEOWNERS; as ada -C "$H" commit -q -m 'back'
out=$(hpush)
lacks "a protected file changed and changed back is not warned about" "$out" 'protected files'
lacks 'nor are its commits' "$out" 'not authored'
# GitHub still checks the workflow scope on the commit that takes mine.yml back out.
has "but the commit that changes a workflow back still gets the workflow-scope line" "$out" 'has no `workflow` scope'
has 'the run knows its thread' "$(cat "$TSTATE/claude-env")" 'TERMAG_ASK_THREAD=threadpush01'
lacks 'and gets no PR description file' "$(cat "$TSTATE/claude-env")" 'TERMAG_ASK_PR_BODY_FILE='
lacks 'no bundle goes up' "$(cat "$LOG")" '/bundle'
R="$TSTATE/result.json"
eq 'the result names what the clone pushed' "$(jq -c '[.pushes[] | .branch] | sort' "$R")" "[\"$PB\",\"$PB-docs\"]"
eq 'with the tips GitHub has' "$(jq -r --arg b "$PB" '.pushes[] | select(.branch == $b) | .sha' "$R")" "$(git -C "$ORIGIN" rev-parse "refs/heads/$PB")"
eq 'bundle flag' "$(jq -r .bundle "$R")" false
eq 'pushed as the asker' "$(git -C "$ORIGIN" log -1 --format='%ae %ce' "refs/heads/$PB")" 'ada@example.com ada@example.com'
has 'a branch committed but not pushed is said in the reply' "$(jq -r .result "$R")" 'branch scratch has 1 commit(s) that were committed but not pushed'
lacks 'and a pushed one is not' "$(jq -r .result "$R")" "branch $PB has"
eq 'unpushed lists only the branch that was not pushed, with where its commits go' "$(jq -c .unpushed "$R")" '[{"branch":"scratch","commits":1,"to":"'"$PB"'"}]'
has "naming the thread's branch to push it to" "$(jq -r .result "$R")" "\`git push origin scratch:$PB\`"
lacks 'a clone made for push mode tells the turn nothing' "$(cat "$TSTATE/claude-stdin")" 'termag converted'
eq 'push mode is remembered' "$(jq -r '.layout + " " + .branch' "$ROOT/threads/threadpush01/meta.json")" "push $PB"
# The default branch is refused by the clone's hook.
MAIN_BEFORE=$(git -C "$ORIGIN" rev-parse refs/heads/main)
echo push-main > "$TSTATE/claude-mode"
runp "$(job runpush0002 threadpush01 '{"pushBranch":"'"$PB"'","resumeSessionId":"sess-1"}')"
lacks 'a push to the default branch fails' "$(cat "$TSTATE/push-exit")" 0
has 'saying why' "$(cat "$TSTATE/push-stderr")" 'not pushing to main, the default branch'
eq 'and main is untouched' "$(git -C "$ORIGIN" rev-parse refs/heads/main)" "$MAIN_BEFORE"
eq 'the earlier pushes are still reported' "$(jq -r '.pushes | length' "$TSTATE/result.json")" 2
# A base that is no branch tip (the upstream moved on past the merge-base), fetched
# under an owner's protocol.version=0, which refuses unadvertised commits by default.
gitp update-ref refs/remotes/origin/main "$(gitp commit-tree -p "$BASE" -m ahead "$BASE^{tree}")"
printf '[protocol]\n\tversion = 0\n' >> "$WORK/box-gitconfig-push"
echo none > "$TSTATE/claude-mode"
runp "$(job runpush0003 threadpush03 '{"pushBranch":"termag-ada/threadpush03"}')"; eq 'a base that is no branch tip still clones, under protocol v0' "$?" 0
eq 'and the clone starts there' "$(git -C "$ROOT/threads/threadpush03/repo" rev-parse HEAD 2>/dev/null)" "$BASE"
gitp update-ref refs/remotes/origin/main "$BASE"
sed -i '/^\[protocol\]/,$d' "$WORK/box-gitconfig-push"
# GitHub unreachable during prepare (a broker blip): no origin branch is fetched, and
# the branch must still get a refs/heads upstream, or the chat runner refuses the clone.
printf '[url "%s"]\n\tinsteadOf = https://github.com/org/repo.git\n' "$WORK/no-such-github.git" > "$WORK/box-gitconfig-offline"
echo none > "$TSTATE/claude-mode"
: > "$LOG"; GIT_CONFIG_GLOBAL="$WORK/box-gitconfig-offline" "$SCRIPT" "$(job runpush0004 threadpush04 '{"pushBranch":"termag-ada/threadpush04"}')" 2> "$TSTATE/stderr"
eq 'an offline prepare still runs the turn' "$?" 0
O="$ROOT/threads/threadpush04/repo"
eq 'and the branch tracks the default branch anyway' "$(git -C "$O" config --get branch.termag-ada/threadpush04.merge) $(git -C "$O" config --get branch.termag-ada/threadpush04.remote)" 'refs/heads/main origin'
eq "the base's history, with no origin branch to measure against, is not reported as unpushed" "$(jq -c .unpushed "$TSTATE/result.json")" '[]'
lacks 'nor said in the reply' "$(jq -r .result "$TSTATE/result.json")" 'committed but not pushed'
if command -v node >/dev/null 2>&1; then
  own=$(node -e 'const c = require(process.argv[1]); c.readCheckoutFacts(process.argv[2]).then(f => process.stdout.write(String(c.checkoutOwnTree(f))))' "$DIR/../agent/chat-runner.js" "$O" 2>&1)
  eq "so the chat runner still takes it for the project's own tree" "$own" true
fi
# A person's message in the thread's chat names no branch: the clone keeps its layout.
echo commit > "$TSTATE/claude-mode"
out=$(GIT_CONFIG_GLOBAL="$WORK/box-gitconfig-push" "$SCRIPT" --prepare "$(job '' threadpush01 '{"waitForCheckout":false}')" 2>/dev/null)
eq "a person's prepare keeps push mode" "$(printf '%s' "$out" | jq -r '"\(.push) \(.branch) \(.prDir)"')" "true $PB null"
# The repo's pre-commit hooks: installed for an ask at its own mode, never for one the
# orchestrator capped (a project from a shared environment), whose git commit would
# otherwise run the repo's hooks as the box user. One installed before is taken out.
cat > "$STUB/pre-commit" <<'EOF'
#!/bin/sh
echo "pre-commit $*" >> "$LOG"
[ -f .git/hooks/pre-commit ] && mv .git/hooks/pre-commit .git/hooks/pre-commit.legacy
printf '#!/bin/sh\n# File generated by pre-commit: https://pre-commit.com\nexit 0\n' > .git/hooks/pre-commit
chmod +x .git/hooks/pre-commit
EOF
chmod +x "$STUB/pre-commit"
printf 'repos: []\n' > "$P/.pre-commit-config.yaml"
: > "$LOG"; GIT_CONFIG_GLOBAL="$WORK/box-gitconfig-push" "$SCRIPT" --prepare "$(job '' threadpush01 '{"waitForCheckout":false}')" >/dev/null 2>&1
has 'an ask at its own mode installs the repo hooks' "$(cat "$LOG")" 'pre-commit install'
printf '#!/bin/sh\nexit 0\n' > "$P/.git/hooks/pre-commit.legacy"
for capped in auto dontAsk; do
  : > "$LOG"; GIT_CONFIG_GLOBAL="$WORK/box-gitconfig-push" "$SCRIPT" --prepare "$(job '' threadpush01 '{"waitForCheckout":false,"permissionMode":"'"$capped"'"}')" >/dev/null 2>&1
  lacks "$capped: never installs the repo hooks" "$(cat "$LOG")" 'pre-commit install'
  if grep -qs 'File generated by pre-commit' "$P/.git/hooks/pre-commit"; then fail "$capped: the hook installed before is taken out" absent present; fi
done
[ -x "$P/.git/hooks/pre-push" ] || fail "the capped clone keeps termag's own pre-push hook" present absent
eq 'the hook pre-commit kept is put back' "$(cat "$P/.git/hooks/pre-commit" 2>/dev/null)" "$(printf '#!/bin/sh\nexit 0')"
rm -f "$P/.pre-commit-config.yaml" "$STUB/pre-commit"
# An older clone of a thread is converted on its first push-mode turn.
run "$(job runconv0001 threadconv001)"
C="$ROOT/threads/threadconv001/repo"
git -C "$C" switch -q -c pr/notes ask 2>/dev/null && echo n > "$C/n.txt" && git -C "$C" add n.txt && git -C "$C" -c user.name=a -c user.email=ada@example.com commit -q -m notes && git -C "$C" switch -q ask
echo none > "$TSTATE/claude-mode"
CB=termag-ada/threadconv001
runp "$(job runconv0002 threadconv001 '{"pushBranch":"'"$CB"'","resumeSessionId":"sess-1"}')"; eq 'a converted turn exits 0' "$?" 0
eq 'the converted clone is on the thread branch' "$(git -C "$C" branch --show-current)" "$CB"
git -C "$C" rev-parse -q --verify "refs/heads/$CB-notes" >/dev/null || fail 'pr/<name> becomes <branch>-<name>' present absent
git -C "$C" rev-parse -q --verify refs/heads/ask >/dev/null && fail 'ask is renamed' absent present
eq 'the converted branch tracks the default branch (never published)' "$(git -C "$C" rev-parse --abbrev-ref "$CB@{upstream}" 2>/dev/null)" origin/main
eq 'and so does a renamed pr/<name>' "$(git -C "$C" rev-parse --abbrev-ref "$CB-notes@{upstream}" 2>/dev/null)" origin/main
# A turn left on a branch with no upstream gets one at the next prepare.
git -C "$C" switch -q -c loose "$CB" && git -C "$C" branch -q --unset-upstream loose 2>/dev/null
GIT_CONFIG_GLOBAL="$WORK/box-gitconfig-push" "$SCRIPT" --prepare "$(job '' threadconv001 '{"waitForCheckout":false}')" >/dev/null 2>&1
eq 'a branch left with no upstream gets one at the next prepare' "$(git -C "$C" rev-parse --abbrev-ref "loose@{upstream}" 2>/dev/null)" origin/main
git -C "$C" switch -q "$CB"
eq 'a converted clone gets origin/HEAD too' "$(git -C "$C" symbolic-ref refs/remotes/origin/HEAD 2>/dev/null)" refs/remotes/origin/main
eq 'the converted clone is not shallow' "$(git -C "$C" rev-parse --is-shallow-repository)" false
eq 'and has origin' "$(git -C "$C" config --get remote.origin.url)" https://github.com/org/repo.git
git -C "$C" rev-parse -q --verify refs/termag/base >/dev/null && fail 'refs/termag/base goes' absent present
eq 'nothing pushed yet' "$(jq -c .pushes "$TSTATE/result.json")" '[]'
has 'its unpublished commits are said in the reply' "$(jq -r .result "$TSTATE/result.json")" "branch $CB has 1 commit(s) that were committed but not pushed"
has 'with the push that publishes them' "$(jq -r .result "$TSTATE/result.json")" "\`git push origin $CB\`"
has "a never-pushed <branch>-<name> sibling is pushed to its own name, as unpushedParts says" "$(jq -r .result "$TSTATE/result.json")" "\`git push origin $CB-notes\`"
lacks "not onto the thread's branch" "$(jq -r .result "$TSTATE/result.json")" "git push origin $CB-notes:$CB"
eq 'and listed as unpushed, so the orchestrator records why nothing was published' "$(jq -c '.unpushed | sort_by(.branch)' "$TSTATE/result.json")" "[{\"branch\":\"$CB\",\"commits\":1,\"to\":\"$CB\"},{\"branch\":\"$CB-notes\",\"commits\":2,\"to\":\"$CB-notes\"}]"
# The converting turn is told: its resumed session was told to commit on ask and leave publishing to termag.
has 'the converting turn is told ahead of its prompt' "$(cat "$TSTATE/claude-stdin")" "the \`ask\` branch is now \`$CB\`"
has 'that TERMAG_ASK_PR_BODY_FILE is gone, and how to edit a PR body' "$(cat "$TSTATE/claude-stdin")" 'termag-pr-body <file> > <marked> && gh pr edit <n> --body-file <marked>'
has 'and the prompt follows' "$(cat "$TSTATE/claude-stdin")" 'please fix it'
runp "$(job runconv0003 threadconv001 '{"pushBranch":"'"$CB"'","resumeSessionId":"sess-1"}')"
eq 'a later turn is not told again' "$(cat "$TSTATE/claude-stdin")" 'please fix it'
# A chat prepare that converts names the notice for ask-chat.js to put ahead of the turn's message.
run "$(job runconv0004 threadconv004)"
out=$(GIT_CONFIG_GLOBAL="$WORK/box-gitconfig-push" "$SCRIPT" --prepare "$(job '' threadconv004 '{"pushBranch":"termag-ada/threadconv004","waitForCheckout":false}')" 2>/dev/null)
has 'a converting --prepare names the notice' "$(printf '%s' "$out" | jq -r .notice)" 'the `ask` branch is now `termag-ada/threadconv004`'
out=$(GIT_CONFIG_GLOBAL="$WORK/box-gitconfig-push" "$SCRIPT" --prepare "$(job '' threadconv004 '{"pushBranch":"termag-ada/threadconv004","waitForCheckout":false}')" 2>/dev/null)
eq 'and the next one none' "$(printf '%s' "$out" | jq -r '.notice // "none"')" none
# A commit on a recreated ask (the session went on as before the conversion) names the thread's branch to push to.
git -C "$C" switch -q -c ask "$CB" && echo again > "$C/again.txt" && git -C "$C" add again.txt && git -C "$C" -c user.name=a -c user.email=ada@example.com commit -q -m again
runp "$(job runconv0005 threadconv001 '{"pushBranch":"'"$CB"'","resumeSessionId":"sess-1"}')"
has "a recreated ask's commits name the thread's branch" "$(jq -r .result "$TSTATE/result.json")" "\`git push origin ask:$CB\`"
# A detached HEAD's commits on no branch (a canceled turn's, say) are named too.
git -C "$C" switch -q --detach ask && echo d > "$C/detached.txt" && git -C "$C" add detached.txt && git -C "$C" -c user.name=a -c user.email=ada@example.com commit -q -m detached
printf '{"type":"result","subtype":"success","is_error":false,"result":"done","session_id":"sess-1","num_turns":1}\n' > "$HOME/result-dh.json"
GIT_CONFIG_GLOBAL="$WORK/box-gitconfig-push" "$SCRIPT" --report "$(job runconv0006 threadconv001 '{"pushBranch":"'"$CB"'"}')" "$HOME/result-dh.json" 2>/dev/null
has "a detached HEAD's commits are said in the reply" "$(jq -r .result "$TSTATE/result.json")" "with 1 commit(s) on no branch, not pushed"
has 'with the push to the thread branch' "$(jq -r .result "$TSTATE/result.json")" "\`git push origin HEAD:$CB\`"
eq 'and listed as HEAD' "$(jq -c '[.unpushed[] | select(.branch == "HEAD")]' "$TSTATE/result.json")" "[{\"branch\":\"HEAD\",\"commits\":1,\"to\":\"$CB\"}]"
git -C "$C" switch -q "$CB" 2>/dev/null; git -C "$C" branch -q -D ask
# A branch gh pr checkout made tracks its own origin branch: its commits go there, never onto the thread's branch.
git -C "$ORIGIN" update-ref refs/heads/fix/other "$(git -C "$ORIGIN" rev-parse refs/heads/main)"
GIT_CONFIG_GLOBAL="$WORK/box-gitconfig-push" git -C "$C" fetch -q origin +refs/heads/fix/other:refs/remotes/origin/fix/other
git -C "$C" switch -q -c fix/other --track origin/fix/other && echo o > "$C/other.txt" && git -C "$C" add other.txt && git -C "$C" -c user.name=a -c user.email=ada@example.com commit -q -m other
GIT_CONFIG_GLOBAL="$WORK/box-gitconfig-push" "$SCRIPT" --report "$(job runconv0007 threadconv001 '{"pushBranch":"'"$CB"'"}')" "$HOME/result-dh.json" 2>/dev/null
has "a checked-out PR branch's commits name a push to its own branch" "$(jq -r .result "$TSTATE/result.json")" '`git push origin fix/other`'
eq 'and say so in unpushed' "$(jq -c '[.unpushed[] | select(.branch == "fix/other")]' "$TSTATE/result.json")" '[{"branch":"fix/other","commits":1,"to":"fix/other"}]'
git -C "$C" switch -q "$CB"; git -C "$C" branch -q -D fix/other; git -C "$C" update-ref -d refs/remotes/origin/fix/other
# --report decides push vs bundle from the job, not meta.json's layout, which the turn can
# rewrite: a cleared layout still reports what the clone pushed, and sends no bundle (Bugbot on #902).
echo none > "$TSTATE/claude-mode"
runp "$(job runrl000001 threadrl0001 '{"pushBranch":"termag-ada/threadrl0001"}')"
RL="$ROOT/threads/threadrl0001/repo"
GIT_CONFIG_GLOBAL="$WORK/box-gitconfig-push" git -C "$RL" -c user.name=Ada -c user.email=ada@example.com commit -q --allow-empty -m mine
GIT_CONFIG_GLOBAL="$WORK/box-gitconfig-push" git -C "$RL" push -q origin HEAD 2>/dev/null
jq 'del(.layout)' "$ROOT/threads/threadrl0001/meta.json" > "$WORK/meta.next" && mv "$WORK/meta.next" "$ROOT/threads/threadrl0001/meta.json"
printf '{"type":"result","subtype":"success","is_error":false,"result":"done","session_id":"sess-1","num_turns":1}\n' > "$HOME/result-rl.json"
: > "$LOG"; GIT_CONFIG_GLOBAL="$WORK/box-gitconfig-push" "$SCRIPT" --report "$(job runrl000002 threadrl0001 '{"pushBranch":"termag-ada/threadrl0001"}')" "$HOME/result-rl.json" 2>/dev/null
eq "a report with meta.json's layout cleared still names what the clone pushed" "$(jq -c '[.pushes[]?.branch]' "$TSTATE/result.json")" '["termag-ada/threadrl0001"]'
lacks "and sends no bundle" "$(cat "$LOG")" '/bundle'
# A later job naming another pushBranch (a follow-up --update-pr on a thread that published
# nothing) moves the existing push clone onto that branch (Bugbot on #902).
echo none > "$TSTATE/claude-mode"
runp "$(job runsw000001 threadsw0001 '{"pushBranch":"termag-ada/threadsw0001"}')"
SW="$ROOT/threads/threadsw0001/repo"
TGT=$(git -C "$ORIGIN" -c user.name=Bob -c user.email=bob@example.com commit-tree -p "$BASE" -m 'the PR' "$BASE^{tree}")
git -C "$ORIGIN" update-ref refs/heads/feat/target "$TGT"
GIT_CONFIG_GLOBAL="$WORK/box-gitconfig-push" "$SCRIPT" --prepare "$(job '' threadsw0001 '{"pushBranch":"feat/target","waitForCheckout":false}')" >/dev/null 2>&1
eq "a later job's pushBranch is checked out" "$(git -C "$SW" branch --show-current)" feat/target
eq "at GitHub's tip of it" "$(git -C "$SW" rev-parse HEAD)" "$TGT"
eq "tracking its own origin branch" "$(git -C "$SW" rev-parse --abbrev-ref 'feat/target@{upstream}' 2>/dev/null)" origin/feat/target
eq "and meta.json names it" "$(jq -r .branch "$ROOT/threads/threadsw0001/meta.json")" feat/target
# A switch whose branch GitHub couldn't be asked about fails the prepare and changes nothing,
# so the next prepare retries; it never starts the branch from the base (Bugbot on #902).
git -C "$ORIGIN" update-ref refs/heads/feat/target2 "$TGT"
printf '[url "%s"]\n\tinsteadOf = https://github.com/org/repo.git\n' "$WORK/no-such-github.git" > "$WORK/box-gitconfig-offline2"
GIT_CONFIG_GLOBAL="$WORK/box-gitconfig-offline2" "$SCRIPT" --prepare "$(job '' threadsw0001 '{"pushBranch":"feat/target2","waitForCheckout":false}')" >/dev/null 2>&1; sw=$?
lacks "a switch with GitHub unreachable fails the prepare" "$sw" 0
git -C "$SW" rev-parse -q --verify refs/heads/feat/target2 >/dev/null && fail "and makes no branch from the base" absent present
eq "and leaves meta.json's branch alone" "$(jq -r .branch "$ROOT/threads/threadsw0001/meta.json")" feat/target
GIT_CONFIG_GLOBAL="$WORK/box-gitconfig-push" "$SCRIPT" --prepare "$(job '' threadsw0001 '{"pushBranch":"feat/target2","waitForCheckout":false}')" >/dev/null 2>&1
eq "the next prepare, with GitHub back, switches at GitHub's tip" "$(git -C "$SW" rev-parse HEAD) $(jq -r .branch "$ROOT/threads/threadsw0001/meta.json")" "$TGT feat/target2"
# A checkout that borrows another store (a webapp project borrows the image's
# baked copy, `git clone --reference`): the clone links that store's packs and
# loose objects, fetches the rest from the checkout, borrows nothing itself,
# and outlives both the borrowed store and the checkout. BAKED has a pack (c1)
# and a loose object (c2); the checkout's own store has c3, the base, and an
# unpushed commit.
BAKED="$WORK/baked"
BPROJ="$HOME/bproj"
SEED="$WORK/seed"
gitb() { git -c user.name=o -c user.email=owner@example.com "$@"; }
git clone -q "$ORIGIN" "$SEED" 2>/dev/null
git clone -q --no-local "$ORIGIN" "$BAKED" 2>/dev/null && git -C "$BAKED" repack -a -d -q
echo c2 > "$SEED/c2.txt"; gitb -C "$SEED" add c2.txt; gitb -C "$SEED" commit -q -m c2; gitb -C "$SEED" push -q origin HEAD:main 2>/dev/null
git -C "$BAKED" fetch -q origin 2>/dev/null
echo c3 > "$SEED/c3.txt"; gitb -C "$SEED" add c3.txt; gitb -C "$SEED" commit -q -m c3; gitb -C "$SEED" push -q origin HEAD:main 2>/dev/null
C3=$(git -C "$SEED" rev-parse HEAD)
git clone -q --reference "$BAKED" "$ORIGIN" "$BPROJ" 2>/dev/null
echo secret > "$BPROJ/local.txt"; gitb -C "$BPROJ" add local.txt; gitb -C "$BPROJ" commit -q -m 'unpushed here'
BLIVE=$(git -C "$BPROJ" rev-parse HEAD)
git -C "$BPROJ" remote set-url origin https://github.com/org/repo.git
# GitHub's default branch moves on past the base.
echo c4 > "$SEED/c4.txt"; gitb -C "$SEED" add c4.txt; gitb -C "$SEED" commit -q -m c4; gitb -C "$SEED" push -q origin HEAD:main 2>/dev/null
C4=$(git -C "$SEED" rev-parse HEAD)
[ -n "$(ls "$BAKED/.git/objects/pack/"*.pack 2>/dev/null)" ] && [ -n "$(find "$BAKED/.git/objects" -path '*/[0-9a-f][0-9a-f]/*' -type f | head -1)" ] \
  || fail 'the borrowed store has a pack and a loose object' 'both' "$(ls -R "$BAKED/.git/objects" | head -20)"
# fetch.unpackLimit=1: every fetch kept as a pack, so history sent twice shows as objects in two packs.
# gc.autoPackLimit=1, not detached: a git whose auto maintenance repacks after a fetch, as git 2.56's
# geometric repack does with its defaults; the prepare's fetches run none, so the links stay as linked.
out=$(GIT_CONFIG_COUNT=4 GIT_CONFIG_KEY_0=fetch.unpackLimit GIT_CONFIG_VALUE_0=1 GIT_CONFIG_KEY_1=gc.autoPackLimit GIT_CONFIG_VALUE_1=1 \
  GIT_CONFIG_KEY_2=gc.autoDetach GIT_CONFIG_VALUE_2=false GIT_CONFIG_KEY_3=maintenance.autoDetach GIT_CONFIG_VALUE_3=false GIT_CONFIG_GLOBAL="$WORK/box-gitconfig-push" "$SCRIPT" --prepare "$(job '' threadborrow1 '{"pushBranch":"feat/borrow","waitForCheckout":false,"cwd":"'"$BPROJ"'"}')" 2> "$TSTATE/stderr")
eq 'a prepare from a borrowing checkout exits 0' "$?" 0
BR="$ROOT/threads/threadborrow1/repo"
eq 'the clone is at the base, beyond what the borrowed store has' "$(git -C "$BR" rev-parse HEAD)" "$C3"
[ -e "$BR/.git/objects/info/alternates" ] && fail 'the clone borrows no store itself' 'no alternates' "$(cat "$BR/.git/objects/info/alternates")"
bpack=$(ls "$BAKED/.git/objects/pack/"*.pack | head -1)
[ -e "$BR/.git/objects/pack/multi-pack-index" ] && fail 'the prepare runs no maintenance in the clone' 'no multi-pack-index' present
[ "$(find "$BR/.git/objects/pack" -name 'pack-*.pack' | wc -l)" -gt 1 ] || fail 'and leaves its packs unrepacked' 'the linked pack and the fetched ones' "$(ls "$BR/.git/objects/pack")"
eq "the borrowed pack is linked, not copied" "$(ls -i "$BR/.git/objects/pack/${bpack##*/}" 2>/dev/null | awk '{print $1}')" "$(ls -i "$bpack" | awk '{print $1}')"
git -C "$BR" cat-file -e "$BLIVE^{commit}" 2>/dev/null && fail "the checkout's unpushed commit stays out of a linked clone" absent present
eq 'and no refs/termag/ are left' "$(git -C "$BR" for-each-ref refs/termag/)" ''
eq 'it is on its branch, tracking the default one' "$(git -C "$BR" branch --show-current) $(git -C "$BR" rev-parse --abbrev-ref '@{upstream}')" 'feat/borrow origin/main'
[ -x "$BR/.git/hooks/pre-push" ] || fail 'a linked clone has the pre-push hook' present absent
eq "origin/main is at GitHub's tip, past the base" "$(git -C "$BR" log -1 --format=%s origin/main)" c4
# The fetch from GitHub offers the base as a commit the clone has, so it brings
# only c4, not the base's history over again (no object in two packs).
eq 'and GitHub sent only what lies beyond the base' "$(git -C "$BR" count-objects -v | awk '$1 == "count:" || $1 == "in-pack:" { n += $2 } END { print n }')" "$(git -C "$BR" cat-file --batch-all-objects --batch-check | wc -l | tr -d ' ')"
has '--prepare says how long the clone took' "$(printf '%s' "$out" | jq -r '.cloneSeconds | type')" number
has 'and the log says so, and that it linked' "$(cat "$TSTATE/stderr")" "the thread's clone took "
has 'naming the links' "$(cat "$TSTATE/stderr")" 'packs linked from the stores'
# The borrowed store gc'd away and the checkout removed: the clone has its own objects.
rm -rf "$BAKED" "$BPROJ"
git -C "$BR" fsck --connectivity-only >/dev/null 2>&1 || fail 'the clone outlives the store it linked and the checkout' 'fsck clean' "$(git -C "$BR" fsck --connectivity-only 2>&1 | head -3)"
eq 'and reads its whole history' "$(git -C "$BR" log --format=%s | tr '\n' ' ')" 'c3 c2 pushed '
out=$(GIT_CONFIG_GLOBAL="$WORK/box-gitconfig-push" "$SCRIPT" --prepare "$(job '' threadborrow1 '{"waitForCheckout":false,"cwd":"'"$PROJ"'"}')" 2>/dev/null)
lacks "a later prepare of the thread makes no new clone, and says no clone time" "$out" cloneSeconds
# A store the checkout borrows that can't be read: nothing is linked, and the
# whole history is fetched from the checkout, as with no store.
BAKED2="$WORK/baked2"; BPROJ2="$HOME/bproj2"
git clone -q --no-local "$ORIGIN" "$BAKED2" 2>/dev/null
git clone -q --reference "$BAKED2" "$ORIGIN" "$BPROJ2" 2>/dev/null
echo "$WORK/no-such-store/objects" >> "$BPROJ2/.git/objects/info/alternates"
git -C "$BPROJ2" remote set-url origin https://github.com/org/repo.git
GIT_CONFIG_GLOBAL="$WORK/box-gitconfig-push" "$SCRIPT" --prepare "$(job '' threadborrow2 '{"pushBranch":"feat/borrow2","waitForCheckout":false,"cwd":"'"$BPROJ2"'"}')" >/dev/null 2> "$TSTATE/stderr"
eq 'a prepare whose borrowed store is unreadable exits 0' "$?" 0
BR2="$ROOT/threads/threadborrow2/repo"
has 'and fetches the whole history' "$(cat "$TSTATE/stderr")" 'the whole history fetched from'
eq 'into a clone at the base' "$(git -C "$BR2" rev-parse HEAD)" "$C4"
for bp in "$BAKED2/.git/objects/pack/"*.pack; do
  [ -e "$BR2/.git/objects/pack/${bp##*/}" ] && fail 'with nothing of the store linked' absent "${bp##*/}"
done
rm -rf "$BAKED2" "$BPROJ2"
git -C "$BR2" fsck --connectivity-only >/dev/null 2>&1 || fail 'which stands alone too' 'fsck clean' "$(git -C "$BR2" fsck --connectivity-only 2>&1 | head -3)"
# A full checkout that borrows a shallow store: the store's tips have no history
# behind them there, so none is offered as a have and nothing of it is linked;
# the whole history is fetched from the checkout, which has it all.
BAKED3="$WORK/baked3"; BPROJ3="$HOME/bproj3"
git clone -q --depth 1 "file://$ORIGIN" "$BAKED3" 2>/dev/null
[ -f "$BAKED3/.git/shallow" ] || fail 'the borrowed store is shallow' shallow full
echo c5 > "$SEED/c5.txt"; gitb -C "$SEED" add c5.txt; gitb -C "$SEED" commit -q -m c5; gitb -C "$SEED" push -q origin HEAD:main 2>/dev/null
C5=$(git -C "$SEED" rev-parse HEAD)
git clone -q --no-local "$ORIGIN" "$BPROJ3" 2>/dev/null
echo "$BAKED3/.git/objects" > "$BPROJ3/.git/objects/info/alternates"
git -C "$BPROJ3" remote set-url origin https://github.com/org/repo.git
eq 'the checkout is full' "$(git -C "$BPROJ3" rev-parse --is-shallow-repository)" false
GIT_CONFIG_GLOBAL="$WORK/box-gitconfig-push" "$SCRIPT" --prepare "$(job '' threadborrow3 '{"pushBranch":"feat/borrow3","waitForCheckout":false,"cwd":"'"$BPROJ3"'"}')" >/dev/null 2> "$TSTATE/stderr"
eq 'a prepare whose borrowed store is shallow exits 0' "$?" 0
BR3="$ROOT/threads/threadborrow3/repo"
has 'and fetches the whole history' "$(cat "$TSTATE/stderr")" 'the whole history fetched from'
eq 'into a clone at the base' "$(git -C "$BR3" rev-parse HEAD)" "$C5"
eq 'with no shallow boundary' "$(git -C "$BR3" rev-parse --is-shallow-repository)" false
rm -rf "$BAKED3" "$BPROJ3"
git -C "$BR3" fsck --connectivity-only >/dev/null 2>&1 || fail 'and its whole history, standing alone' 'fsck clean' "$(git -C "$BR3" fsck --connectivity-only 2>&1 | head -3)"
eq 'which reads to the first commit' "$(git -C "$BR3" log --format=%s | tail -1)" pushed
echo commit > "$TSTATE/claude-mode"
gitp remote set-url origin "$SAVED_ORIGIN"

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
  echo 'PASS: committed-only clone, run as the box user, bundle, PR description, several PRs, push mode, resume, errors, sweep, cancel'
  exit 0
fi
echo "$failures failure(s)"
exit 1
