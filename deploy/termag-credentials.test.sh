#!/bin/sh
# Tests deploy/termag-credentials in a sandboxed HOME, with gh stubbed and the
# legacy managed-settings path redirected (no sudo).
#
# Run: sh deploy/termag-credentials.test.sh
set -u

SCRIPT="$(cd "$(dirname "$0")" && pwd)/termag-credentials"
HELPER="$(cd "$(dirname "$0")" && pwd)/termag-claude-token"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
# Outside any git checkout: telemetry-launch adds the checkout's termag.repo only where a case makes one.
cd "$WORK" || exit 1

failures=0
fail() {
  echo "FAIL: $1"
  echo "      want: $2"
  echo "      got:  $3"
  failures=$((failures + 1))
}

H="$WORK/home"; STUB="$WORK/bin"; MANAGED="$WORK/etc/claude-code/managed-settings.json"
CS="$H/.claude/settings.json"; CSTATE="$H/.config/termag/claude-gateway.json"
mkdir -p "$H" "$STUB"
GH_STATE="$WORK/gh-token"; GH_LOG="$WORK/gh.log"
# gh keeps one token per host in $GH_STATE.<host>.
cat > "$STUB/gh" <<STUBEOF
#!/bin/sh
echo "\$*" >> "$GH_LOG"
case "\$*" in
  'auth token -h '*) f="$GH_STATE.\$4"; [ -s "\$f" ] && cat "\$f" || exit 1 ;;
  'auth login --hostname '*' --with-token') cat > "$GH_STATE.\$4" ;;
  'auth logout -h '*) : > "$GH_STATE.\$4" ;;
esac
exit 0
STUBEOF
chmod 755 "$STUB/gh"

SYSGIT="$WORK/etc/gitconfig"; PROFILE_D="$WORK/etc/profile.d"; mkdir -p "$PROFILE_D"
CONFIG="$WORK/agent.config.json"; BOX_TOKEN='tmag_boxsentinel_boxsentinel_0123' # gitleaks:allow
printf '{"termag_url":"wss://b","token":"%s"}\n' "$BOX_TOKEN" > "$CONFIG"
# The config locations the script takes from the environment are pinned to $H
# too: GitHub's runners set XDG_CONFIG_HOME, and an owner may set the others.
run() {
  HOME="$H" XDG_CONFIG_HOME="$H/.config" CODEX_HOME="$H/.codex" VIBE_HOME="$H/.vibe" PATH="$STUB:$PATH" TERMAG_CLAUDE_MANAGED_SETTINGS="$MANAGED" TERMAG_CREDENTIALS_SUDO='' \
    GIT_CONFIG_SYSTEM="$SYSGIT" TERMAG_PROFILE_D="$PROFILE_D" TERMAG_AGENT_CONFIG="$CONFIG" \
    "$SCRIPT" "$@"
}
boxgit() { HOME="$H" GIT_CONFIG_SYSTEM="$SYSGIT" git "$@"; }

SETTINGS='{"apiKeyHelper":"@TERMAG_CLAUDE_TOKEN@","env":{"CLAUDE_CODE_USE_BEDROCK":"1","ANTHROPIC_BEDROCK_BASE_URL":"https://gw/bedrock"}}'

# ── Claude gateway ──────────────────────────────────────────────────────────
# An owner's settings.json with hooks and a key of their own; it must survive.
mkdir -p "$H/.claude"
printf '{"hooks":{"Stop":[]},"env":{"BASH_DEFAULT_TIMEOUT_MS":"600000"}}' > "$CS"
chmod 640 "$CS"
# What an earlier revision delivered, in managed settings: the next apply removes it.
mkdir -p "$(dirname "$MANAGED")"
printf '{"apiKeyHelper":"/x/termag-claude-token"}' > "$MANAGED"
printf '%s' "$SETTINGS" | run apply claude-gateway 2>/dev/null
[ ! -e "$MANAGED" ] || fail 'apply removes the managed settings an earlier revision wrote' 'absent' 'present'
got="$(jq -r .apiKeyHelper "$CS" 2>/dev/null)"
[ "$got" = "'$HELPER' '$CONFIG'" ] || fail 'apiKeyHelper runs the token helper next to the script on the agent config' "'$HELPER' '$CONFIG'" "$got"
got="$(sh -c "$(jq -r .apiKeyHelper "$CS")")"
[ "$got" = "$BOX_TOKEN" ] || fail "the apiKeyHelper command prints the box's agent token" "$BOX_TOKEN" "$got"
grep -qF "$BOX_TOKEN" "$CS" "$CSTATE" && fail 'the settings never hold the token' 'no token' 'token present'
got="$(sh "$HELPER" "$WORK/no-such.json" 2>&1)"; code=$?
[ "$code" != 0 ] && [ -n "$got" ] && case $got in *"$BOX_TOKEN"*) false ;; esac \
  || fail 'the helper fails loudly, with no token, when the config is missing' 'non-zero + message' "$code $got"
got="$(jq -r .env.ANTHROPIC_BEDROCK_BASE_URL "$CS" 2>/dev/null)"
[ "$got" = https://gw/bedrock ] || fail "the gateway env lands in the owner's user settings" https://gw/bedrock "$got"
got="$(jq -c '[.hooks, .env.BASH_DEFAULT_TIMEOUT_MS]' "$CS")"
[ "$got" = '[{"Stop":[]},"600000"]' ] || fail "the owner's own settings are kept" '[{"Stop":[]},"600000"]' "$got"
got="$(stat -c %a "$CS")"
[ "$got" = 640 ] || fail "the owner's file keeps its mode" 640 "$got"
got="$(jq -c '[.apiKeyHelper != null, (.env | keys)]' "$CSTATE")"
[ "$got" = '[true,["ANTHROPIC_BEDROCK_BASE_URL","CLAUDE_CODE_USE_BEDROCK"]]' ] \
  || fail 'the state records exactly the keys apply wrote' '[true,[BASE_URL,USE_BEDROCK]]' "$got"

out="$(printf '%s' "$SETTINGS" | run apply claude-gateway 2>&1)"
[ -z "$out" ] || fail 'a repeated delivery is silent' '' "$out"

# A changed delivery replaces our keys, and a key no longer delivered goes.
printf '%s' "$SETTINGS" | jq -c '.env.ANTHROPIC_BEDROCK_BASE_URL = "https://gw2" | .env.AWS_REGION = "us-east-2"' | run apply claude-gateway 2>/dev/null
printf '%s' "$SETTINGS" | jq -c '.env.ANTHROPIC_BEDROCK_BASE_URL = "https://gw3"' | run apply claude-gateway 2>/dev/null
got="$(jq -c '[.env.ANTHROPIC_BEDROCK_BASE_URL, .env.AWS_REGION]' "$CS")"
[ "$got" = '["https://gw3",null]' ] || fail 'a new delivery replaces the last one key by key' '["https://gw3",null]' "$got"

# A key the owner set to their own value stays theirs, through apply and remove.
jq '.env.ANTHROPIC_BEDROCK_BASE_URL = "https://mine"' "$CS" > "$WORK/cs" && cat "$WORK/cs" > "$CS"
out="$(printf '%s' "$SETTINGS" | run apply claude-gateway 2>&1)"
got="$(jq -r .env.ANTHROPIC_BEDROCK_BASE_URL "$CS")"
[ "$got" = https://mine ] || fail "apply leaves a key the owner set" https://mine "$got"
case $out in *'left your own env.ANTHROPIC_BEDROCK_BASE_URL'*) : ;; *) fail 'apply says which key it left' 'left your own env.ANTHROPIC_BEDROCK_BASE_URL' "$out" ;; esac
run remove claude-gateway 2>/dev/null
got="$(jq -c '[.apiKeyHelper, .env]' "$CS")"
[ "$got" = '[null,{"BASH_DEFAULT_TIMEOUT_MS":"600000","ANTHROPIC_BEDROCK_BASE_URL":"https://mine"}]' ] \
  || fail "remove takes out only termag's keys" '[null,{BASH_DEFAULT_TIMEOUT_MS, the owner'"'"'s BASE_URL}]' "$got"
[ ! -e "$CSTATE" ] || fail 'remove clears the state' 'absent' 'present'
printf '{"hooks":{"Stop":[]},"env":{"BASH_DEFAULT_TIMEOUT_MS":"600000"}}' > "$CS"

printf '{"env":{}}' | run apply claude-gateway 2>/dev/null; got=$?
[ "$got" != 0 ] || fail 'settings without Bedrock mode are refused' 'non-zero' "$got"
printf 'not json' > "$CS"
printf '{"apiKeyHelper":"/x/termag-claude-token"}' > "$MANAGED"
printf '%s' "$SETTINGS" | run apply claude-gateway 2>/dev/null; got=$?
[ "$got" != 0 ] && [ "$(cat "$CS")" = 'not json' ] || fail 'a settings file that is not JSON is left alone' 'non-zero, unchanged' "$got $(cat "$CS")"
[ -e "$MANAGED" ] || fail 'an apply that cannot write the user settings keeps the earlier managed settings' 'present' 'absent'
rm -f "$MANAGED"
rm -rf "$H/.claude"
printf '%s' "$SETTINGS" | run apply claude-gateway 2>/dev/null
jq -e '.env.CLAUDE_CODE_USE_BEDROCK == "1"' "$CS" >/dev/null 2>&1 || fail 'apply creates ~/.claude/settings.json on a box with no ~/.claude' 'gateway keys' "$(ls -la "$H" 2>&1)"
got="$(stat -c %a "$CS" 2>/dev/null)"
[ "$got" = 600 ] || fail 'a settings file apply creates is 0600' 600 "$got"
run remove claude-gateway 2>/dev/null
got="$(cat "$CS")"
[ "$got" = '{}' ] || fail 'remove leaves an empty object, not an empty env' '{}' "$got"

# Through a symlink (dotfiles), the target is written and the link kept.
mkdir -p "$WORK/dotfiles"; printf '{}' > "$WORK/dotfiles/settings.json"
rm -f "$CS"; ln -s "$WORK/dotfiles/settings.json" "$CS"
printf '%s' "$SETTINGS" | run apply claude-gateway 2>/dev/null
[ -L "$CS" ] && jq -e '.env.CLAUDE_CODE_USE_BEDROCK == "1"' "$WORK/dotfiles/settings.json" >/dev/null \
  || fail 'a symlinked settings file is written through' 'link kept, target written' "$(ls -l "$CS")"
run remove claude-gateway 2>/dev/null
rm -f "$CS"

run skip claude-gateway 2>/dev/null
printf '%s' "$SETTINGS" | run apply claude-gateway 2>/dev/null
[ ! -e "$CS" ] || fail 'a skipped box ignores later deliveries' 'absent' 'present'
got="$(run status)"
case "$got" in *'claude-gateway: skipped'*) : ;; *) fail 'status reports the skip' 'skipped' "$got" ;; esac
run unskip claude-gateway 2>/dev/null
printf '%s' "$SETTINGS" | run apply claude-gateway 2>/dev/null
jq -e '.env.CLAUDE_CODE_USE_BEDROCK == "1"' "$CS" >/dev/null 2>&1 || fail 'unskip lets the next delivery apply' 'gateway keys' "$(cat "$CS" 2>&1)"
run skip claude-gateway 2>/dev/null
jq -e '.env == null and .apiKeyHelper == null' "$CS" >/dev/null 2>&1 || fail 'skip removes the gateway settings' '{}' "$(cat "$CS")"
run unskip claude-gateway 2>/dev/null

printf '{"apiKeyHelper":"/opt/other"}' > "$MANAGED"
run remove claude-gateway 2>/dev/null
[ -e "$MANAGED" ] || fail 'remove leaves managed settings someone else wrote' 'present' 'absent'
rm -f "$MANAGED"

# The agent runs the checkout's copy; the owner types `skip` into the copy
# termag-reconcile put on PATH.
ONPATH="$WORK/local-bin"; mkdir -p "$ONPATH"
cp "$SCRIPT" "$HELPER" "$ONPATH/"
printf '%s' "$SETTINGS" | run apply claude-gateway 2>/dev/null
HOME="$H" TERMAG_CLAUDE_MANAGED_SETTINGS="$MANAGED" TERMAG_CREDENTIALS_SUDO='' \
  "$ONPATH/termag-credentials" skip claude-gateway 2>/dev/null
jq -e '.apiKeyHelper == null' "$CS" >/dev/null 2>&1 || fail 'skip from the PATH copy removes what the agent wrote' 'no apiKeyHelper' "$(cat "$CS")"
run unskip claude-gateway 2>/dev/null

# ── GitHub, through the broker ──────────────────────────────────────────────
BROKER='https://agent.termag.example.com'
HOST='agent.termag.example.com'
PAYLOAD='{"broker":"https://agent.termag.example.com/","login":"octocat"}'

# What the pre-broker revision left behind, plus the baked ~/.gitconfig rule.
LEGACY='gho_legacysentinel_legacysentinel_01'
mkdir -p "$H/.ssh" "$H/.config/termag"
printf 'KEY\n' > "$H/.ssh/termag_github"; printf 'PUB\n' > "$H/.ssh/termag_github.pub"
printf '# >>> termag github (managed by termag-credentials)\nHost github.com\n  IdentityFile x\n# <<< termag github\nHost example\n  User me\n' > "$H/.ssh/config"
printf '%s' "$LEGACY" > "$GH_STATE.github.com"
printf '%s' "$LEGACY" | sha256sum | cut -d' ' -f1 > "$H/.config/termag/github-token.sha256"
git config -f "$H/.gitconfig" url.ssh://git@github.com/example-org/.insteadOf https://github.com/example-org/
# A box usually has no /etc/gitconfig and no ~/.zshenv yet, and may have no
# GitHub insteadOf rule of its own.
rm -f "$SYSGIT" "$H/.zshenv"; mv "$H/.gitconfig" "$WORK/gitconfig.baked"
out="$(printf '%s' "$PAYLOAD" | run apply github 2>&1)"; got=$?
[ "$got" = 0 ] || fail 'apply github works with no system gitconfig or ~/.zshenv yet' 0 "$got: $out"
grep -qF "[url \"$BROKER/\"]" "$SYSGIT" 2>/dev/null || fail 'and creates the system gitconfig' 'broker block' "$(cat "$SYSGIT" 2>&1)"
run remove github 2>/dev/null
mv "$WORK/gitconfig.baked" "$H/.gitconfig"
printf '# >>> termag github (managed by termag-credentials)\nHost github.com\n  IdentityFile x\n# <<< termag github\nHost example\n  User me\n' > "$H/.ssh/config"
printf 'KEY\n' > "$H/.ssh/termag_github"; printf 'PUB\n' > "$H/.ssh/termag_github.pub"
printf '%s' "$LEGACY" > "$GH_STATE.github.com"
printf '%s' "$LEGACY" | sha256sum | cut -d' ' -f1 > "$H/.config/termag/github-token.sha256"
printf '[user]\n\tname = Box Owner\n' > "$SYSGIT"

out="$(printf '%s' "$PAYLOAD" | run apply github 2>&1)"; got=$?
[ "$got" = 0 ] || fail 'apply github exits 0' 0 "$got: $out"
[ ! -e "$H/.ssh/termag_github" ] || fail 'the pre-broker key is removed' 'absent' 'present'
[ "$(cat "$H/.ssh/config")" = "$(printf 'Host example\n  User me')" ] || fail 'the pre-broker ssh block is removed' 'Host example only' "$(cat "$H/.ssh/config")"
[ ! -s "$GH_STATE.github.com" ] || fail 'the github.com gh login termag made is logged out' 'logged out' "$(cat "$GH_STATE.github.com")"

mkdir -p "$WORK/repo"; boxgit -C "$WORK/repo" init -q
for u in git@github.com:o/r https://github.com/o/r ssh://git@github.com/o/r https://github.com/example-org/webapp git@github.com:example-org/dev; do
  boxgit -C "$WORK/repo" remote add "r$(printf '%s' "$u" | cksum | cut -d' ' -f1)" "$u"
done
got="$(boxgit -C "$WORK/repo" remote -v | awk '/fetch/ {print $2}' | sort -u | tr '\n' ' ')"
[ "$got" = "$BROKER/example-org/dev $BROKER/example-org/webapp $BROKER/o/r " ] ||
  fail 'every github.com remote form, and the baked example-org rule, goes to the broker' "$BROKER/..." "$got"
grep -q 'name = Box Owner' "$SYSGIT" || fail 'the rest of the system gitconfig is kept' 'user.name kept' "$(cat "$SYSGIT")"

got="$(printf 'protocol=https\nhost=%s\n\n' "$HOST" | boxgit credential fill 2>/dev/null | sed -n 's/^password=//p')"
[ "$got" = "$BOX_TOKEN" ] || fail 'the credential helper gives the broker the box token' 'box token' "$got"
got="$(printf 'protocol=https\nhost=github.com\n\n' | GIT_TERMINAL_PROMPT=0 boxgit credential fill 2>/dev/null | sed -n 's/^password=//p')"
[ -z "$got" ] || fail 'nothing answers for github.com itself' '' "$got"

[ "$(cat "$GH_STATE.$HOST")" = "$BOX_TOKEN" ] || fail 'gh is logged in to the broker with the box token' "$BOX_TOKEN" "$(cat "$GH_STATE.$HOST" 2>/dev/null)"
if grep -q "$BOX_TOKEN" "$GH_LOG"; then fail 'the box token is never a gh argument' 'stdin only' "$(cat "$GH_LOG")"; fi
[ "$(cat "$PROFILE_D/termag-github.sh")" = "export GH_HOST=$HOST" ] || fail 'GH_HOST for login shells' "export GH_HOST=$HOST" "$(cat "$PROFILE_D/termag-github.sh")"
grep -qx "export GH_HOST=$HOST" "$H/.zshenv" || fail 'GH_HOST for zsh' 'in ~/.zshenv' "$(cat "$H/.zshenv" 2>/dev/null)"
if grep -rqs -e "$BOX_TOKEN" -e 'gho_' -e 'PRIVATE KEY' "$SYSGIT" "$H/.zshenv" "$PROFILE_D" "$H/.ssh" "$H/.config/termag"; then
  fail 'no token or key in anything apply writes' 'none' "$(grep -rls -e "$BOX_TOKEN" -e gho_ "$SYSGIT" "$H/.zshenv" "$PROFILE_D" "$H/.ssh" "$H/.config/termag")"
fi
got="$(run status)"
case "$got" in *"github: NOT WORKING: the termag broker at $HOST is unreachable"*) : ;; *) fail 'status says an unreachable broker is not working, and why' 'NOT WORKING ... unreachable' "$got" ;; esac

# The broker answering, and refusing, through a curl stub on PATH (the socket
# probe for Claude still uses the real curl).
REAL_CURL=$(command -v curl)
cat > "$STUB/curl" <<STUBEOF
#!/bin/sh
case "\$*" in *"https://$HOST/api/v3/user"*) ;; *) exec "$REAL_CURL" "\$@" ;; esac
printf '%s\n' "\$*" >> "$WORK/curl.argv"; cat > "$WORK/curl.stdin"
out=; while [ \$# -gt 0 ]; do [ "\$1" = -o ] && out=\$2; shift; done
case "\$(cat "$WORK/curl.mode")" in
  ok) printf '{"login":"octocat"}' > "\$out"; printf 200 ;;
  refused) printf '{"message":"Only a termag-managed box can use the GitHub broker"}' > "\$out"; printf 403 ;;
esac
STUBEOF
chmod 755 "$STUB/curl"
echo ok > "$WORK/curl.mode"
got="$(run status)"
case "$got" in *"github: on, through the termag broker ($HOST) as @octocat"*) : ;; *) fail 'status shows a working broker and the GitHub login' 'on ... as @octocat' "$got" ;; esac
grep -q "$BOX_TOKEN" "$WORK/curl.stdin" || fail 'the probe authenticates with the box token' 'token in curl config on stdin' 'absent'
if grep -q "$BOX_TOKEN" "$WORK/curl.argv"; then fail 'the box token is never a curl argument' 'stdin only' "$(cat "$WORK/curl.argv")"; fi
echo refused > "$WORK/curl.mode"
got="$(run status)"
case "$got" in *"github: NOT WORKING: the termag broker at $HOST refused (HTTP 403): Only a termag-managed box can use the GitHub broker"*) : ;;
  *) fail "status shows the broker's refusal" 'NOT WORKING ... refused (HTTP 403): ...' "$got" ;; esac
rm -f "$STUB/curl"

: > "$GH_LOG"; cp "$SYSGIT" "$WORK/sys.before"
out="$(printf '%s' "$PAYLOAD" | run apply github 2>&1)"
[ -z "$out" ] || fail 'a repeated delivery is silent' '' "$out"
cmp -s "$SYSGIT" "$WORK/sys.before" || fail 'a repeated delivery leaves the gitconfig alone' same changed
if grep -q 'with-token' "$GH_LOG"; then fail 'a repeated delivery does not log gh in again' 'no login' "$(cat "$GH_LOG")"; fi

printf '{"login":"x"}' | run apply github 2>/dev/null; got=$?
[ "$got" != 0 ] || fail 'a payload with no broker is refused' 'non-zero' "$got"

run remove github 2>/dev/null
got="$(boxgit -C "$WORK/repo" remote -v | awk '/fetch/ {print $2}' | grep -c "$BROKER")"
[ "$got" = 0 ] || fail 'remove takes the broker out of git' 0 "$got"
[ "$(cat "$SYSGIT")" = "$(printf '[user]\n\tname = Box Owner')" ] || fail 'remove restores the system gitconfig' 'user block only' "$(cat "$SYSGIT")"
[ ! -e "$PROFILE_D/termag-github.sh" ] || fail 'remove drops GH_HOST' absent present
if grep -q GH_HOST "$H/.zshenv"; then fail 'remove drops GH_HOST from ~/.zshenv' absent present; fi
[ ! -s "$GH_STATE.$HOST" ] || fail 'remove logs gh out of the broker' 'logged out' "$(cat "$GH_STATE.$HOST")"

# Bring your own auth: `skip github` takes the broker out and keeps it out,
# leaving the owner's own gh login and git rules alone.
printf '%s' "$PAYLOAD" | run apply github 2>/dev/null
printf 'gho_owner_own_login' > "$GH_STATE.github.com"
remotes() { boxgit -C "$WORK/repo" remote -v | awk '/fetch/ {print $2}' | sort -u | tr '\n' ' '; }
run skip github 2>/dev/null
got="$(remotes)"
[ "$got" = "git@github.com:example-org/dev git@github.com:o/r https://github.com/o/r ssh://git@github.com/example-org/webapp ssh://git@github.com/o/r " ] ||
  fail 'skip github: remotes resolve as the owner configured them' 'no broker, own example-org rule' "$got"
[ ! -e "$PROFILE_D/termag-github.sh" ] || fail 'skip github drops GH_HOST for login shells' absent present
if grep -q GH_HOST "$H/.zshenv"; then fail 'skip github drops GH_HOST from ~/.zshenv' absent present; fi
[ ! -s "$GH_STATE.$HOST" ] || fail 'skip github logs gh out of the broker' 'logged out' "$(cat "$GH_STATE.$HOST")"
[ "$(cat "$GH_STATE.github.com")" = gho_owner_own_login ] || fail "skip github keeps the owner's own gh login" kept "$(cat "$GH_STATE.github.com" 2>/dev/null)"
printf '%s' "$PAYLOAD" | run apply github 2>/dev/null; got=$?
[ "$got" = 0 ] || fail 'a delivery to a skipped box succeeds' 0 "$got"
if grep -qF "$BROKER" "$SYSGIT" 2>/dev/null || [ -e "$PROFILE_D/termag-github.sh" ] || grep -q GH_HOST "$H/.zshenv"; then
  fail 'a skipped box ignores later deliveries' 'no broker, no GH_HOST' "$(cat "$SYSGIT" "$PROFILE_D/termag-github.sh" 2>&1)"
fi
case "$(run status)" in *'github: skipped on this box'*) : ;; *) fail 'status reports the github skip' skipped "$(run status)" ;; esac
run unskip github 2>/dev/null
printf '%s' "$PAYLOAD" | run apply github 2>/dev/null
[ "$(boxgit -C "$WORK/repo" remote -v | awk '/fetch/ {print $2}' | grep -c "$BROKER")" != 0 ] || fail 'unskip github lets the next delivery apply' broker none
run remove github 2>/dev/null
rm -f "$GH_STATE.github.com"

# Nothing delivered: remove is a no-op (the backend sends it on every connect).
out="$(run remove github 2>&1)"
[ -z "$out" ] || fail 'removing nothing is silent' '' "$out"

# ── A box without credentials says why ─────────────────────────────────────
printf '{"reason":"GitHub is not connected: paste `gh auth token` on the termag Credentials page"}' | run remove github 2>/dev/null
got="$(run status)"
case "$got" in *'github: off: GitHub is not connected: paste `gh auth token` on the termag Credentials page'*) : ;;
  *) fail "status repeats the orchestrator's reason" 'github: off: GitHub is not connected...' "$got" ;; esac
printf '%s' "$PAYLOAD" | run apply github 2>/dev/null
[ ! -e "$H/.config/termag/github.status" ] || fail 'an apply clears the recorded reason' absent present
run remove github 2>/dev/null
rm -f "$H/.config/termag/github.status" "$H/.config/termag/claude-gateway.status"
printf '{"termag_url":"ws://10.0.0.5:3040/termag/ws/agent","token":"%s"}\n' "$BOX_TOKEN" > "$CONFIG"
got="$(run status)"
case "$got" in *'claude-gateway: off: termag has delivered nothing yet'*'github: off: termag has delivered nothing yet'*) : ;;
  *) fail 'a ws:// box is not refused for its transport: it waits for a delivery like any other' 'off: termag has delivered nothing yet' "$got" ;; esac
case "$got" in *'plain ws://'*) fail 'nothing blames plain ws://' 'no ws:// reason' "$got" ;; esac
printf '{"termag_url":"wss://b","token":"%s"}\n' "$BOX_TOKEN" > "$CONFIG"
# status asks the gateway's /termag/auth-check with the box token. A stand-in
# answers 204 for this box's token, 401 for any other, and 502 in outage mode.
GW_PORT_FILE="$WORK/gw.port"; GW_SEEN="$WORK/gw.seen"
node -e '
  const [portFile, seen, want] = process.argv.slice(1);
  const fs = require("fs");
  const s = require("http").createServer((q, r) => {
    fs.appendFileSync(seen, `${q.method} ${q.url} ${q.headers.authorization === `Bearer ${want}` ? "box-token" : "other"}\n`);
    if (fs.existsSync(`${seen}.down`)) { r.writeHead(502).end("bad gateway"); return; }
    if (q.url !== "/termag/auth-check") { r.writeHead(404).end(); return; }
    if (q.headers.authorization === `Bearer ${want}`) { r.writeHead(204).end(); return; }
    r.writeHead(401, { "content-type": "application/json" }).end(JSON.stringify({ message: "Unknown or revoked box token" }));
  }).listen(0, "127.0.0.1", () => fs.writeFileSync(portFile, String(s.address().port)));
' "$GW_PORT_FILE" "$GW_SEEN" "$BOX_TOKEN" & gw_pid=$!
# A cold node start on a CI runner can take seconds; wait up to 15 s.
i=0; while [ ! -s "$GW_PORT_FILE" ] && [ "$i" -lt 150 ]; do sleep 0.1; i=$((i + 1)); done
[ -s "$GW_PORT_FILE" ] || { echo "FAIL: the stub gateway did not start (GW_PORT_FILE)"; exit 1; }
GW="http://127.0.0.1:$(cat "$GW_PORT_FILE")"
printf '%s' "$SETTINGS" | sed "s#https://gw/bedrock#$GW#" | run apply claude-gateway 2>/dev/null
got="$(run status | grep '^claude-gateway')"
[ "$got" = "claude-gateway: on ($CS), the gateway at $GW accepts this box's token" ] \
  || fail 'status says on when the gateway accepts the box token' 'claude-gateway: on (...)' "$got"
got="$(cat "$GW_SEEN")"
[ "$got" = 'GET /termag/auth-check box-token' ] || fail 'status sends the box token to the auth probe only' 'GET /termag/auth-check box-token' "$got"
printf '{"termag_url":"wss://b","token":"tmag_revoked"}\n' > "$CONFIG"
got="$(run status | grep '^claude-gateway')"
[ "$got" = "claude-gateway: NOT WORKING: the gateway at $GW refused this box (HTTP 401): Unknown or revoked box token" ] \
  || fail "status repeats the gateway's refusal" 'NOT WORKING ... refused (HTTP 401): Unknown or revoked box token' "$got"
printf '{"termag_url":"wss://b","token":"%s"}\n' "$BOX_TOKEN" > "$CONFIG"
touch "$GW_SEEN.down"
got="$(run status | grep '^claude-gateway')"
[ "$got" = "claude-gateway: NOT WORKING: the gateway at $GW could not reach termag to check this box (HTTP 502)" ] \
  || fail 'status tells a termag outage from a refusal' 'NOT WORKING ... could not reach termag (HTTP 502)' "$got"
kill "$gw_pid"; wait "$gw_pid" 2>/dev/null
got="$(run status | grep '^claude-gateway')"
case "$got" in "claude-gateway: NOT WORKING: the gateway at $GW is unreachable"*) : ;;
  *) fail 'status says when the gateway itself is unreachable' 'NOT WORKING ... unreachable' "$got" ;; esac
run remove claude-gateway 2>/dev/null

# ── Claude Code telemetry ───────────────────────────────────────────────────
TSTATE="$H/.config/termag/telemetry.json"
BOX="$(hostname -s)"
TEL='{"env":{"CLAUDE_CODE_ENABLE_TELEMETRY":"1","CLAUDE_CODE_ENHANCED_TELEMETRY_BETA":"1","OTEL_TRACES_EXPORTER":"otlp","OTEL_EXPORTER_OTLP_PROTOCOL":"http/protobuf","OTEL_EXPORTER_OTLP_ENDPOINT":"https://otel.example.test","OTEL_RESOURCE_ATTRIBUTES":"telemetry.project_id=p1,service.name=termag-claude-session"}}'
printf '{"hooks":{"Stop":[]},"env":{"BASH_DEFAULT_TIMEOUT_MS":"600000","OTEL_TRACES_EXPORTER":"none"}}' > "$CS"
printf '%s' "$TEL" | run apply telemetry 2>"$WORK/tel.err"; got=$?
[ "$got" = 0 ] || fail 'apply telemetry succeeds' 0 "$got: $(cat "$WORK/tel.err")"
got="$(jq -c '.env | [.CLAUDE_CODE_ENABLE_TELEMETRY, .CLAUDE_CODE_ENHANCED_TELEMETRY_BETA, .OTEL_EXPORTER_OTLP_ENDPOINT, .OTEL_RESOURCE_ATTRIBUTES, .BASH_DEFAULT_TIMEOUT_MS]' "$CS")"
want="[\"1\",\"1\",\"https://otel.example.test\",\"telemetry.project_id=p1,service.name=termag-claude-session,termag.box=$BOX\",\"600000\"]"
[ "$got" = "$want" ] || fail 'telemetry merges into the owner settings, with the box in the resource' "$want" "$got"
got="$(jq -r '.env.OTEL_TRACES_EXPORTER' "$CS")"
[ "$got" = none ] || fail "the owner's own value for a telemetry key wins" none "$got"
got="$(jq -c '[.env | to_entries[] | select(.key | test("HEADERS|CLIENT_|_(METRICS|LOGS|TRACES)_(ENDPOINT|PROTOCOL)$")) | .value] | [length, unique]' "$CS")"
[ "$got" = '[18,[""]]' ] || fail "telemetry blanks every header, client credential and per-signal endpoint a shell could set" '[18,[""]]' "$got"
grep -q 'left your own env.OTEL_TRACES_EXPORTER' "$WORK/tel.err" || fail 'a kept owner key is said' 'left your own env.OTEL_TRACES_EXPORTER' "$(cat "$WORK/tel.err")"
jq -e '.env | has("OTEL_TRACES_EXPORTER") | not' "$TSTATE" >/dev/null || fail "the owner's key is not recorded as termag's" 'absent from state' "$(cat "$TSTATE")"
out="$(printf '%s' "$TEL" | run apply telemetry 2>&1 | grep -v 'left your own')"
[ -z "$out" ] || fail 'a repeated telemetry delivery writes nothing' '' "$out"
got="$(run status | grep '^telemetry')"
[ "$got" = "telemetry: on ($CS), new Claude Code sessions export metrics, events and traces to https://otel.example.test" ] \
  || fail 'telemetry status names the endpoint' 'telemetry: on ...' "$got"
# The launch settings for a session the browser started: the resource as the
# settings hold it (box included) plus the replay's id; {} for anything else.
RID=huuhcqcev124emZ9urmRjjPSNXLl
got="$(run telemetry-launch "$RID")"; code=$?
want="{\"env\":{\"OTEL_RESOURCE_ATTRIBUTES\":\"telemetry.project_id=p1,service.name=termag-claude-session,termag.box=$BOX,termag.replay.id=$RID\"}}"
[ "$code" = 0 ] && [ "$got" = "$want" ] || fail 'telemetry-launch repeats the resource with the replay session id' "$want" "$code $got"
for bad in '' - short 'huuhcqcev124emZ9urmRjjPSNXLl;id' 'huuhcqcev124emZ9urmRjjPSNXLl huuhcqcev124emZ9urmRjjPSNXLl' aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa; do
  got="$(run telemetry-launch "$bad")"; code=$?
  [ "$code" = 0 ] && [ "$got" = '{}' ] || fail "telemetry-launch prints {} for an id that is not 20-64 letters and digits: '$bad'" '{}' "$code $got"
done
# The pane's project and workstream ride in from the environment, with or
# without a replay; a name that is not an id drops the pair, never the launch.
got="$(TERMAG_PROJECT=webapp TERMAG_WORKSTREAM=feature-x run telemetry-launch "$RID")"
want="{\"env\":{\"OTEL_RESOURCE_ATTRIBUTES\":\"telemetry.project_id=p1,service.name=termag-claude-session,termag.box=$BOX,termag.project=webapp,termag.workstream=feature-x,termag.replay.id=$RID\"}}"
[ "$got" = "$want" ] || fail 'telemetry-launch adds the project and workstream before the replay' "$want" "$got"
got="$(TERMAG_PROJECT=webapp TERMAG_WORKSTREAM=main run telemetry-launch -)"
want="{\"env\":{\"OTEL_RESOURCE_ATTRIBUTES\":\"telemetry.project_id=p1,service.name=termag-claude-session,termag.box=$BOX,termag.project=webapp,termag.workstream=main\"}}"
[ "$got" = "$want" ] || fail 'telemetry-launch with - as the id adds the project and workstream alone' "$want" "$got"
for pair in 'gon falon:main' 'webapp:' ':main' 'webapp:ws,x=y' "$(printf 'a%.0s' $(seq 65)):main"; do
  got="$(TERMAG_PROJECT="${pair%%:*}" TERMAG_WORKSTREAM="${pair#*:}" run telemetry-launch "$RID")"
  want="{\"env\":{\"OTEL_RESOURCE_ATTRIBUTES\":\"telemetry.project_id=p1,service.name=termag-claude-session,termag.box=$BOX,termag.replay.id=$RID\"}}"
  [ "$got" = "$want" ] || fail "telemetry-launch drops a project/workstream pair that is not two ids ($pair), keeps the replay" "$want" "$got"
done
got="$(TERMAG_PROJECT='gon falon' TERMAG_WORKSTREAM=main run telemetry-launch -)"
[ "$got" = '{}' ] || fail 'telemetry-launch with nothing valid to add prints {}' '{}' "$got"
# A launch that is not a pane (the chat runner's turns and one-shots) names
# its kind, which replaces the settings' termag.session.kind, or is added
# where they have none; a bad kind or one-shot name is dropped, never the launch.
got="$(TERMAG_SESSION_KIND=chat TERMAG_PROJECT=webapp TERMAG_WORKSTREAM=main run telemetry-launch -)"
want="{\"env\":{\"OTEL_RESOURCE_ATTRIBUTES\":\"telemetry.project_id=p1,service.name=termag-claude-session,termag.box=$BOX,termag.session.kind=chat,termag.project=webapp,termag.workstream=main\"}}"
[ "$got" = "$want" ] || fail 'telemetry-launch adds a kind the settings do not name' "$want" "$got"
cp "$CS" "$WORK/cs.kind"
jq '.env.OTEL_RESOURCE_ATTRIBUTES |= sub("service.name="; "termag.session.kind=interactive,service.name=")' "$WORK/cs.kind" > "$WORK/cs" && cat "$WORK/cs" > "$CS"
got="$(TERMAG_SESSION_KIND=oneshot TERMAG_ONESHOT=title TERMAG_PROJECT=webapp TERMAG_WORKSTREAM=main run telemetry-launch -)"
want="{\"env\":{\"OTEL_RESOURCE_ATTRIBUTES\":\"telemetry.project_id=p1,termag.session.kind=oneshot,service.name=termag-claude-session,termag.box=$BOX,termag.project=webapp,termag.workstream=main,termag.oneshot=title\"}}"
[ "$got" = "$want" ] || fail "telemetry-launch replaces the settings' kind and names the one-shot" "$want" "$got"
got="$(TERMAG_SESSION_KIND=chat run telemetry-launch -)"
want="{\"env\":{\"OTEL_RESOURCE_ATTRIBUTES\":\"telemetry.project_id=p1,termag.session.kind=chat,service.name=termag-claude-session,termag.box=$BOX\"}}"
[ "$got" = "$want" ] || fail 'telemetry-launch with a kind and no project still sets the kind' "$want" "$got"
for bad in 'chat,x=y' 'Chat' 'ch at' "$(printf 'a%.0s' $(seq 33))"; do
  got="$(TERMAG_SESSION_KIND="$bad" TERMAG_ONESHOT=title TERMAG_PROJECT=webapp TERMAG_WORKSTREAM=main run telemetry-launch -)"
  want="{\"env\":{\"OTEL_RESOURCE_ATTRIBUTES\":\"telemetry.project_id=p1,termag.session.kind=interactive,service.name=termag-claude-session,termag.box=$BOX,termag.project=webapp,termag.workstream=main\"}}"
  [ "$got" = "$want" ] || fail "telemetry-launch drops a kind that is not lowercase letters and hyphens ($bad), and the one-shot with it" "$want" "$got"
done
got="$(TERMAG_SESSION_KIND=oneshot TERMAG_ONESHOT='title,x=y' run telemetry-launch -)"
want="{\"env\":{\"OTEL_RESOURCE_ATTRIBUTES\":\"telemetry.project_id=p1,termag.session.kind=oneshot,service.name=termag-claude-session,termag.box=$BOX\"}}"
[ "$got" = "$want" ] || fail 'telemetry-launch drops a bad one-shot name, keeps the kind' "$want" "$got"
# A pane's launch names its kind too (backend services/launchCommand.ts
# PANE_KIND_ENV), the settings' own: the resource is the one it had before.
got="$(TERMAG_SESSION_KIND=interactive TERMAG_PROJECT=webapp TERMAG_WORKSTREAM=main run telemetry-launch -)"
want="$(TERMAG_PROJECT=webapp TERMAG_WORKSTREAM=main run telemetry-launch -)"
[ "$got" = "$want" ] || fail "telemetry-launch: a pane's explicit interactive leaves its resource as it was" "$want" "$got"
# The explicit kind wins over one the caller's environment carries: a pane's
# launch typed into a shell that inherited another kind is still a pane, and a
# chat turn started by an agent whose environment says interactive is a chat.
got="$(export TERMAG_SESSION_KIND=ask; TERMAG_SESSION_KIND=interactive run telemetry-launch -)"
want="{\"env\":{\"OTEL_RESOURCE_ATTRIBUTES\":\"telemetry.project_id=p1,termag.session.kind=interactive,service.name=termag-claude-session,termag.box=$BOX\"}}"
[ "$got" = "$want" ] || fail 'telemetry-launch: an explicit interactive wins over an inherited kind' "$want" "$got"
for kind in ask chat oneshot; do
  got="$(export TERMAG_SESSION_KIND=interactive; TERMAG_SESSION_KIND=$kind run telemetry-launch -)"
  want="{\"env\":{\"OTEL_RESOURCE_ATTRIBUTES\":\"telemetry.project_id=p1,termag.session.kind=$kind,service.name=termag-claude-session,termag.box=$BOX\"}}"
  [ "$got" = "$want" ] || fail "telemetry-launch: an explicit $kind wins over an inherited interactive" "$want" "$got"
done
# The session's work (work_resource): the checkout's repository as owner/name
# (never the remote URL, which can carry a token), branch and commit, read from
# TERMAG_WORK_DIR or the working directory, and a spawned agent's spawn, each
# bad value dropped on its own.
git init -q "$WORK/wr" && git -C "$WORK/wr" checkout -q -b feature/x
# A remote URL carrying a token, assembled here so no credential-shaped URL
# sits in the source (the password is the word secret, not a real token).
FAKE_USERINFO="x-access-token:$(printf '%s' secret)"
git -C "$WORK/wr" remote add origin "https://${FAKE_USERINFO}@github.example.test/acme/widgets.git"
git -C "$WORK/wr" -c user.name=t -c user.email=t@example.test commit -q --allow-empty -m init
WSHA=$(git -C "$WORK/wr" rev-parse HEAD)
WORKATTRS="termag.repo=acme/widgets,termag.git.branch=feature/x,termag.git.commit=$WSHA"
got="$(cd "$WORK/wr" && TERMAG_SESSION_KIND=interactive TERMAG_PROJECT=webapp TERMAG_WORKSTREAM=main run telemetry-launch -)"
want="{\"env\":{\"OTEL_RESOURCE_ATTRIBUTES\":\"telemetry.project_id=p1,termag.session.kind=interactive,service.name=termag-claude-session,termag.box=$BOX,termag.project=webapp,termag.workstream=main,$WORKATTRS\"}}"
[ "$got" = "$want" ] || fail "telemetry-launch adds the checkout's repository, branch and commit" "$want" "$got"
case $got in *secret*|*x-access-token*|*github.example.test*) fail 'the remote URL never reaches the resource' 'owner/name only' "$got" ;; esac
got="$(TERMAG_WORK_DIR="$WORK/wr" TERMAG_SESSION_KIND=chat run telemetry-launch -)"
case $got in *",$WORKATTRS\""*) : ;; *) fail 'telemetry-launch reads the checkout from TERMAG_WORK_DIR (the chat runner)' "$WORKATTRS" "$got" ;; esac
git -C "$WORK/wr" checkout -q --detach
got="$(cd "$WORK/wr" && run work-resource)"
[ "$got" = ",termag.repo=acme/widgets,termag.git.commit=$WSHA" ] || fail 'a detached HEAD names no branch' ",termag.repo=acme/widgets,termag.git.commit=$WSHA" "$got"
git -C "$WORK/wr" remote set-url origin /srv/git/widgets.git
got="$(cd "$WORK/wr" && run work-resource)"
[ "$got" = ",termag.git.commit=$WSHA" ] || fail 'a local-path origin names no repository' ",termag.git.commit=$WSHA" "$got"
for u in file://localhost/srv/git/acme/widgets.git file:///srv/git/acme/widgets.git rsync://host/acme/widgets.git; do
  git -C "$WORK/wr" remote set-url origin "$u"
  got="$(cd "$WORK/wr" && run work-resource)"
  [ "$got" = ",termag.git.commit=$WSHA" ] || fail "a $u origin names no repository" ",termag.git.commit=$WSHA" "$got"
done
for u in ssh://git@github.com/acme/widgets git@github.com:acme/widgets.git http://github.example.test/acme/widgets; do
  git -C "$WORK/wr" remote set-url origin "$u"
  got="$(cd "$WORK/wr" && run work-resource)"
  [ "$got" = ",termag.repo=acme/widgets,termag.git.commit=$WSHA" ] || fail "a $u origin names acme/widgets" ",termag.repo=acme/widgets,…" "$got"
done
got="$(run work-resource)"
[ -z "$got" ] || fail 'outside a checkout and with no spawn, work-resource prints nothing' '' "$got"
got="$(cd "$WORK/wr" && TERMAG_WORK_DIR=- run work-resource)"
[ -z "$got" ] || fail "TERMAG_WORK_DIR=- names no checkout, not the caller's directory" '' "$got"
got="$(TERMAG_SPAWN_ID=cmvzxo7xt5v0ekz4bc2obb2ee TERMAG_SPAWN_ROOT=cmvzxjz445ngekz4bhkrf6yv8 TERMAG_SPAWN_DEPTH=2 TERMAG_SPAWN_PARENT_PROJECT=termag TERMAG_SPAWN_PARENT_WORKSTREAM=main TERMAG_SPAWN_PARENT_BOX=cmvtr3c1n0hg2afsfacusxv7j run work-resource)"
[ "$got" = ',termag.spawn.id=cmvzxo7xt5v0ekz4bc2obb2ee,termag.spawn.root=cmvzxjz445ngekz4bhkrf6yv8,termag.spawn.depth=2,termag.spawn.parent.project=termag,termag.spawn.parent.workstream=main,termag.spawn.parent.box=cmvtr3c1n0hg2afsfacusxv7j' ] \
  || fail 'work-resource names the spawn, its root, depth and parent' 'termag.spawn.*' "$got"
got="$(TERMAG_SPAWN_ID=cmvzxo7xt5v0ekz4bc2obb2ee TERMAG_SPAWN_ROOT='x,y=z' TERMAG_SPAWN_DEPTH=0 TERMAG_SPAWN_PARENT_PROJECT='a b' TERMAG_SPAWN_PARENT_WORKSTREAM=main TERMAG_SPAWN_PARENT_BOX=short run work-resource)"
[ "$got" = ',termag.spawn.id=cmvzxo7xt5v0ekz4bc2obb2ee' ] || fail 'work-resource drops each bad spawn value, keeps the id' ',termag.spawn.id=…' "$got"
got="$(TERMAG_SPAWN_ID='CMV,x=y' TERMAG_SPAWN_DEPTH=2 run work-resource)"
[ -z "$got" ] || fail 'no termag.spawn.* without a well-formed spawn id' '' "$got"
# A delivered `interactive` becomes `external` in the owner's settings: what a
# session termag did not launch exports with. Every termag launch names its
# kind. In a home of its own, so the settings the cases below read stay as they are.
XH="$WORK/xhome"; mkdir -p "$XH/.claude"; echo '{}' > "$XH/.claude/settings.json"
xrun() { HOME="$XH" XDG_CONFIG_HOME="$XH/.config" PATH="$STUB:$PATH" TERMAG_CLAUDE_MANAGED_SETTINGS="$MANAGED" TERMAG_CREDENTIALS_SUDO='' "$SCRIPT" "$@"; }
printf '%s' "$TEL" | jq -c '.env.OTEL_RESOURCE_ATTRIBUTES |= sub("service.name="; "termag.session.kind=interactive,service.name=")' | xrun apply telemetry 2>/dev/null
got="$(jq -r '.env.OTEL_RESOURCE_ATTRIBUTES' "$XH/.claude/settings.json")"
[ "$got" = "telemetry.project_id=p1,termag.session.kind=external,service.name=termag-claude-session,termag.box=$BOX" ] \
  || fail "the settings' resource says external, not the delivered interactive" "…termag.session.kind=external…" "$got"
got="$(TERMAG_SESSION_KIND=interactive xrun telemetry-launch -)"
want="{\"env\":{\"OTEL_RESOURCE_ATTRIBUTES\":\"telemetry.project_id=p1,termag.session.kind=interactive,service.name=termag-claude-session,termag.box=$BOX\"}}"
[ "$got" = "$want" ] || fail "a pane's launch still names interactive over the settings' external" "$want" "$got"
# A launch that names no kind inside an agent's session (one agent starting
# another by hand) takes the session's: the environment it runs in says so.
got="$(export TERMAG_SESSION_KIND=chat; run telemetry-launch -)"
want="{\"env\":{\"OTEL_RESOURCE_ATTRIBUTES\":\"telemetry.project_id=p1,termag.session.kind=chat,service.name=termag-claude-session,termag.box=$BOX\"}}"
[ "$got" = "$want" ] || fail "telemetry-launch: a nested launch with no kind of its own takes its session's" "$want" "$got"
# An ask's turn says who asked: the thread, the hop and the parent session's
# box, project, workstream and Claude Code session. Each bad value is dropped
# on its own (project and workstream as a pair), and nothing without a thread.
ASKBASE="telemetry.project_id=p1,termag.session.kind=ask,service.name=termag-claude-session,termag.box=$BOX,termag.project=webapp,termag.workstream=ask-thr12345678"
SID=0b7c2f7e-1c1d-4c55-9a43-2f0e6d1b8a10
ask_launch() {
  TERMAG_SESSION_KIND=ask TERMAG_PROJECT=webapp TERMAG_WORKSTREAM=ask-thr12345678 TERMAG_ASK_THREAD="$1" TERMAG_ASK_HOP="$2" \
    TERMAG_ASK_PARENT_BOX="$3" TERMAG_ASK_PARENT_PROJECT="$4" TERMAG_ASK_PARENT_WORKSTREAM="$5" TERMAG_ASK_PARENT_SESSION="$6" run telemetry-launch -
}
got="$(ask_launch thr12345678 3 devbox termag main "$SID")"
want="{\"env\":{\"OTEL_RESOURCE_ATTRIBUTES\":\"$ASKBASE,termag.ask.thread=thr12345678,termag.ask.hop=3,termag.ask.parent.box=devbox,termag.ask.parent.project=termag,termag.ask.parent.workstream=main,termag.ask.parent.session=$SID\"}}"
[ "$got" = "$want" ] || fail 'telemetry-launch names the ask thread, its hop and who asked' "$want" "$got"
got="$(ask_launch thr12345678 '' '' '' '' '')"
want="{\"env\":{\"OTEL_RESOURCE_ATTRIBUTES\":\"$ASKBASE,termag.ask.thread=thr12345678\"}}"
[ "$got" = "$want" ] || fail 'telemetry-launch names the thread alone when nobody else is known' "$want" "$got"
got="$(ask_launch thr12345678 '0' 'dev box' 'termag' '' 'a,b=c')"
[ "$got" = "$want" ] || fail 'telemetry-launch drops a bad hop, box, half a parent pair and a bad session, keeps the thread' "$want" "$got"
got="$(ask_launch thr12345678 1234567 devbox 'ter,mag' main "$SID")"
want="{\"env\":{\"OTEL_RESOURCE_ATTRIBUTES\":\"$ASKBASE,termag.ask.thread=thr12345678,termag.ask.parent.box=devbox,termag.ask.parent.session=$SID\"}}"
[ "$got" = "$want" ] || fail 'telemetry-launch drops a hop over six digits and a parent pair with a bad project, keeps the rest' "$want" "$got"
for bad in '' 'THR12345678' 'thr1' 'thr12345678,x=y' "$(printf 'a%.0s' $(seq 41))"; do
  got="$(ask_launch "$bad" 3 devbox termag main "$SID")"
  want="{\"env\":{\"OTEL_RESOURCE_ATTRIBUTES\":\"$ASKBASE\"}}"
  [ "$got" = "$want" ] || fail "telemetry-launch adds no termag.ask.* without a well-formed thread ($bad)" "$want" "$got"
done
cat "$WORK/cs.kind" > "$CS"

for bad in '{"env":{"OTEL_LOG_USER_PROMPTS":"1","OTEL_EXPORTER_OTLP_ENDPOINT":"https://otel.example.test"}}' \
           '{"env":{"OTEL_EXPORTER_OTLP_HEADERS":"Authorization=x","OTEL_EXPORTER_OTLP_ENDPOINT":"https://otel.example.test"}}' \
           '{"env":{"OTEL_EXPORTER_OTLP_TRACES_ENDPOINT":"https://elsewhere.example.test","OTEL_EXPORTER_OTLP_ENDPOINT":"https://otel.example.test"}}' \
           '{"env":{"OTEL_EXPORTER_OTLP_LOGS_CLIENT_KEY":"/k.pem","OTEL_EXPORTER_OTLP_ENDPOINT":"https://otel.example.test"}}' \
           '{"env":{"OTEL_EXPORTER_OTLP_ENDPOINT":"http://otel.example.test"}}' \
           '{"apiKeyHelper":"x","env":{"OTEL_EXPORTER_OTLP_ENDPOINT":"https://otel.example.test"}}'; do
  before="$(cat "$CS")"
  printf '%s' "$bad" | run apply telemetry 2>/dev/null; got=$?
  [ "$got" = 1 ] || fail "telemetry refuses a content gate, a filled header, key or per-signal endpoint, plain http or a non-telemetry key: $bad" 1 "$got"
  [ "$(cat "$CS")" = "$before" ] || fail "a refused telemetry delivery leaves the settings alone: $bad" 'unchanged' "$(cat "$CS")"
done

printf '%s' "$TEL" | jq -c '.env.OTEL_EXPORTER_OTLP_HEADERS = "" | .env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT = ""' | run apply telemetry 2>/dev/null; got=$?
[ "$got" = 0 ] || fail 'telemetry accepts a delivery that names the blanks itself' 0 "$got"

# An owner's own exporter: termag's keys come out and none go in.
jq '.env.OTEL_EXPORTER_OTLP_HEADERS = "Authorization=Bearer mine"' "$CS" > "$WORK/cs" && cat "$WORK/cs" > "$CS"
printf '%s' "$TEL" | run apply telemetry 2>/dev/null; got=$?
[ "$got" = 0 ] || fail 'apply telemetry beside an owner exporter succeeds' 0 "$got"
got="$(jq -c '.env' "$CS")"
[ "$got" = '{"BASH_DEFAULT_TIMEOUT_MS":"600000","OTEL_TRACES_EXPORTER":"none","OTEL_EXPORTER_OTLP_HEADERS":"Authorization=Bearer mine"}' ] \
  || fail "an owner with their own exporter gets none of termag's telemetry" "the owner's keys only" "$got"
[ ! -e "$TSTATE" ] || fail 'telemetry state cleared beside an owner exporter' 'absent' 'present'
got="$(run telemetry-launch "$RID")"
[ "$got" = '{}' ] || fail "telemetry-launch adds nothing beside an owner exporter" '{}' "$got"
got="$(run status | grep '^telemetry')"
case "$got" in 'telemetry: off: your own OpenTelemetry exporter'*) : ;; *) fail 'telemetry status says the owner exporter wins' 'telemetry: off: your own ...' "$got" ;; esac
jq 'del(.env.OTEL_EXPORTER_OTLP_HEADERS)' "$CS" > "$WORK/cs" && cat "$WORK/cs" > "$CS"

printf '%s' "$TEL" | run apply telemetry 2>/dev/null
printf '{"reason":"the orchestrator ships no telemetry"}' | run remove telemetry 2>/dev/null
got="$(jq -c '.' "$CS")"
[ "$got" = '{"hooks":{"Stop":[]},"env":{"BASH_DEFAULT_TIMEOUT_MS":"600000","OTEL_TRACES_EXPORTER":"none"}}' ] \
  || fail "remove telemetry takes out only termag's keys" "the owner's settings" "$got"
got="$(run status | grep '^telemetry')"
[ "$got" = 'telemetry: off: the orchestrator ships no telemetry' ] || fail "telemetry status repeats the orchestrator's reason" 'telemetry: off: ...' "$got"
got="$(run telemetry-launch "$RID")"
[ "$got" = '{}' ] || fail "telemetry-launch is {} once telemetry is removed" '{}' "$got"

# ── Codex, Cursor, Devin and pi telemetry ───────────────────────────────────
ASTATE="$H/.config/termag/agent-telemetry.json"; CH="$H/.cursor/hooks.json"; DEPLOY="$(dirname "$SCRIPT")"
HOOKCMD="'$DEPLOY/termag-cursor-otel-hook'"
ATEL='{"endpoint":"https://otel.example.test","resourceAttributes":"telemetry.project_id=abc123,termag.session.kind=interactive,termag.user.id=u1,termag.box.id=b1"}'
# An owner's Cursor hooks file with a hook of their own on one of our events.
mkdir -p "$H/.cursor"
printf '{"version":1,"hooks":{"stop":[{"command":"./mine.sh"}],"beforeShellExecution":[{"command":"./guard.sh"}]}}' > "$CH"
printf '%s' "$ATEL" | run apply agent-telemetry 2>"$WORK/atel.err"; got=$?
[ "$got" = 0 ] || fail 'apply agent-telemetry succeeds' 0 "$got: $(cat "$WORK/atel.err")"
got="$(jq -c . "$ASTATE" 2>&1)"
want="{\"endpoint\":\"https://otel.example.test\",\"resourceAttributes\":\"telemetry.project_id=abc123,termag.session.kind=interactive,termag.user.id=u1,termag.box.id=b1,termag.box=$(hostname -s)\"}"
[ "$got" = "$want" ] || fail 'agent telemetry records the destination with the box in the resource' "$want" "$got"
got="$(stat -c %a "$ASTATE" 2>/dev/null)"
[ "$got" = 600 ] || fail 'the agent telemetry record is 600' 600 "$got"
got="$(jq -c --arg cmd "$HOOKCMD" '[.hooks.stop[].command, ([.hooks | to_entries[] | select(any(.value[]; .command == $cmd)) | .key] | sort), .hooks.beforeShellExecution]' "$CH")"
want="[\"./mine.sh\",$(printf '%s' "$HOOKCMD" | jq -R .),[\"postToolUse\",\"postToolUseFailure\",\"sessionEnd\",\"sessionStart\",\"stop\",\"subagentStop\"],[{\"command\":\"./guard.sh\"}]]"
[ "$got" = "$want" ] || fail "the Cursor hook goes on its six events, after the owner's own, touching no other event" "$want" "$got"
out="$(printf '%s' "$ATEL" | run apply agent-telemetry 2>&1)"
[ -z "$out" ] || fail 'a repeated agent telemetry delivery writes nothing' '' "$out"
got="$(jq '[.hooks.stop[] | select(.command | test("termag-cursor-otel-hook"))] | length' "$CH")"
[ "$got" = 1 ] || fail 'a repeated delivery adds the hook once' 1 "$got"
# A moved checkout (renamed home): the recorded old command is replaced, not kept.
jq '.command = "'"'"'/old/home/deploy/termag-cursor-otel-hook'"'"'"' "$H/.config/termag/cursor-hooks.json" > "$WORK/ch.json" && cp "$WORK/ch.json" "$H/.config/termag/cursor-hooks.json"
jq '.hooks.stop += [{"command": "'"'"'/old/home/deploy/termag-cursor-otel-hook'"'"'"}]' "$CH" > "$WORK/h.json" && cp "$WORK/h.json" "$CH"
printf '%s' "$ATEL" | run apply agent-telemetry 2>/dev/null
got="$(jq -c '[.hooks.stop[].command]' "$CH")"
[ "$got" = "[\"./mine.sh\",$(printf '%s' "$HOOKCMD" | jq -R .)]" ] || fail "a moved checkout's old hook command is replaced" "mine + new" "$got"
got="$(run status | grep '^agent-telemetry')"
[ "$got" = 'agent-telemetry: on, termag-launched Codex and Devin sessions, every Cursor session and termag'"'"'s pi sessions export to https://otel.example.test' ] \
  || fail 'agent-telemetry status names the endpoint' 'agent-telemetry: on ...' "$got"
# status from another copy of the script (the reconciled ~/.local/bin one) checks the recorded hook.
mkdir -p "$WORK/localbin"; cp "$SCRIPT" "$WORK/localbin/termag-credentials"
got="$(HOME="$H" PATH="$STUB:$PATH" TERMAG_AGENT_CONFIG="$CONFIG" GIT_CONFIG_SYSTEM="$SYSGIT" TERMAG_PROFILE_D="$PROFILE_D" \
  TERMAG_CLAUDE_MANAGED_SETTINGS="$MANAGED" "$WORK/localbin/termag-credentials" status </dev/null | grep '^agent-telemetry')"
case "$got" in 'agent-telemetry: on,'*) : ;; *) fail "status from another copy of the script still finds the recorded Cursor hook" 'agent-telemetry: on, ...' "$got" ;; esac
jq '.hooks.stop = [{"command":"./mine.sh"}] | .hooks.sessionStart = []' "$CH" > "$WORK/h.json" && cp "$WORK/h.json" "$CH"
jq -c '.hooks |= with_entries(.value |= map(select(.command | test("termag") | not)))' "$CH" > "$WORK/h.json" && cp "$WORK/h.json" "$CH"
got="$(run status | grep '^agent-telemetry')"
case "$got" in 'agent-telemetry: NOT WORKING: Cursor'*) : ;; *) fail 'agent-telemetry status says when the Cursor hook is gone' 'NOT WORKING: Cursor ...' "$got" ;; esac
printf '%s' "$ATEL" | run apply agent-telemetry 2>/dev/null

before="$(cat "$CH")"; before_state="$(cat "$ASTATE")"
for bad in \
  '{"endpoint":"http://otel.example.test","resourceAttributes":"telemetry.project_id=abc"}' \
  '{"endpoint":"https://otel.example.test/x","resourceAttributes":"telemetry.project_id=abc"}' \
  '{"endpoint":"https://otel.example.test","resourceAttributes":"termag.session.kind=interactive"}' \
  '{"endpoint":"https://otel.example.test","resourceAttributes":"telemetry.project_id=abc,x=a b"}' \
  '{"endpoint":"https://otel.example.test","resourceAttributes":"telemetry.project_id=abc","headers":{"a":"b"}}' \
  'not json'; do
  printf '%s' "$bad" | run apply agent-telemetry 2>/dev/null; got=$?
  [ "$got" = 1 ] || fail "agent telemetry refuses a non-https origin, a path, a missing project, unsafe attributes or another key: $bad" 1 "$got"
  [ "$(cat "$CH")" = "$before" ] && [ "$(cat "$ASTATE")" = "$before_state" ] || fail "a refused agent telemetry delivery changes nothing: $bad" 'unchanged' 'changed'
done

printf '{"reason":"the orchestrator ships no telemetry"}' | run remove agent-telemetry 2>/dev/null
[ ! -e "$ASTATE" ] || fail 'remove agent-telemetry deletes the record' 'absent' 'present'
got="$(jq -c . "$CH")"
[ "$got" = '{"version":1,"hooks":{"stop":[{"command":"./mine.sh"}],"beforeShellExecution":[{"command":"./guard.sh"}]}}' ] \
  || fail "remove agent-telemetry takes out only termag's hook" "the owner's hooks" "$got"
got="$(run status | grep '^agent-telemetry')"
[ "$got" = 'agent-telemetry: off: the orchestrator ships no telemetry' ] || fail "agent-telemetry status repeats the orchestrator's reason" 'agent-telemetry: off: ...' "$got"
# A box with no Cursor hooks file gets one holding only termag's hook.
rm -f "$CH"
printf '%s' "$ATEL" | run apply agent-telemetry 2>/dev/null
got="$(jq -c '[.version, (.hooks | keys | length)]' "$CH" 2>&1)"
[ "$got" = '[1,6]' ] || fail 'apply creates a Cursor hooks file when there is none' '[1,6]' "$got"
run remove agent-telemetry </dev/null 2>/dev/null
got="$(jq -c . "$CH")"
[ "$got" = '{"version":1,"hooks":{}}' ] || fail 'remove leaves an empty hooks file behind it' '{"version":1,"hooks":{}}' "$got"

# ── MCP servers ─────────────────────────────────────────────────────────────
CJ="$H/.claude.json"; MSTATE="$H/.config/termag/mcp.json"; MVER="$H/.config/termag/mcp-connectors.version"
MCPHELPER="'$(dirname "$SCRIPT")/termag-mcp-headers' '$CONFIG'"
# Claude Code's own config: other keys, the owner's own server, and one named
# like a connector, which stays theirs.
printf '{"numStartups":3,"projects":{"/x":{}},"mcpServers":{"metaterm":{"command":"m"},"jira":{"type":"http","url":"https://mine.example/mcp"}}}' > "$CJ"
chmod 600 "$CJ"
# A first delivery of no connectors changes nothing a session reads: no version.
printf '%s' '{"broker":"https://mcp-broker.example.test","connectors":[]}' | run apply mcp 2>/dev/null
[ ! -e "$MVER" ] || fail 'apply mcp of no connectors over none does not bump the version' 'absent' 'present'
MCP='{"broker":"https://mcp-broker.example.test","connectors":[{"id":"c1abc","name":"figma"},{"id":"c2abc","name":"jira"}]}'
printf '%s' "$MCP" | run apply mcp 2>"$WORK/mcp.err"; got=$?
[ "$got" = 0 ] || fail 'apply mcp succeeds' 0 "$got: $(cat "$WORK/mcp.err")"
got="$(jq -c '.mcpServers.figma' "$CJ")"
want="$(jq -cn --arg h "$MCPHELPER" '{type:"http",url:"https://mcp-broker.example.test/c/c1abc",headersHelper:$h}')"
[ "$got" = "$want" ] || fail 'apply mcp writes the connector entry, pointed at the broker with the headers helper' "$want" "$got"
got="$(jq -c '[.numStartups, .projects, .mcpServers.metaterm, .mcpServers.jira]' "$CJ")"
[ "$got" = '[3,{"/x":{}},{"command":"m"},{"type":"http","url":"https://mine.example/mcp"}]' ] \
  || fail "apply mcp keeps the other keys and the owner's same-named server" 'unchanged' "$got"
grep -q 'left your own MCP server jira' "$WORK/mcp.err" || fail 'apply mcp says it left the owner'"'"'s jira' 'a note' "$(cat "$WORK/mcp.err")"
got="$(jq -c 'keys' "$MSTATE")"
[ "$got" = '["figma"]' ] || fail 'apply mcp records only what it wrote' '["figma"]' "$got"
got="$(stat -c %a "$CJ")"
[ "$got" = 600 ] || fail 'apply mcp keeps ~/.claude.json mode' 600 "$got"
! grep -q "$BOX_TOKEN" "$CJ" || fail 'the box token is never written to ~/.claude.json' 'absent' 'present'
[ -s "$MVER" ] || fail 'apply mcp writes the version file' 'present' 'absent'
v1="$(cat "$MVER")"
# Where a CLI finds the API broker: its URL and the token helper, no token, world-readable.
ABSTATE="$H/.config/termag/api-broker.json"
got="$(jq -c . "$ABSTATE" 2>&1)"
want="$(jq -cn --arg h "$(dirname "$SCRIPT")/termag-mcp-headers" --arg c "$CONFIG" '{url:"https://mcp-broker.example.test",headers_command:[$h,$c]}')"
[ "$got" = "$want" ] || fail 'apply mcp writes api-broker.json for a CLI' "$want" "$got"
[ "$(stat -c %a "$ABSTATE")" = 644 ] || fail 'api-broker.json is 0644' 644 "$(stat -c %a "$ABSTATE")"
! grep -q "$BOX_TOKEN" "$ABSTATE" || fail 'the box token is never written to api-broker.json' 'absent' 'present'
got="$(HOME="$H" sh "$(dirname "$SCRIPT")/termag-mcp-headers" "$CONFIG")"
[ "$got" = "{\"Authorization\":\"Bearer $BOX_TOKEN\"}" ] || fail 'termag-mcp-headers prints the box token as a Bearer header' 'Authorization: Bearer …' "$got"
# A repeat is a no-op: same file, same version.
cp "$CJ" "$WORK/cj.before"
ino="$(ls -i "$CJ" | awk '{print $1}')"
printf '%s' "$MCP" | run apply mcp 2>/dev/null
cmp -s "$CJ" "$WORK/cj.before" || fail 'a repeated apply mcp leaves ~/.claude.json alone' 'unchanged' 'changed'
# Not even rewritten with the same bytes: Claude Code polls the file's stat.
[ "$(ls -i "$CJ" | awk '{print $1}')" = "$ino" ] || fail 'a repeated apply mcp does not rewrite ~/.claude.json' "inode $ino" 'a new file'
[ "$(cat "$MVER")" = "$v1" ] || fail 'a repeated apply mcp does not bump the version' "$v1" "$(cat "$MVER")"
# Claude Code rewrites the file in its own layout; the same servers are still no change.
jq -c . "$CJ" > "$CJ.t" && cat "$CJ.t" > "$CJ" && rm -f "$CJ.t"
ino="$(ls -i "$CJ" | awk '{print $1}')"
printf '%s' "$MCP" | run apply mcp 2>/dev/null
[ "$(ls -i "$CJ" | awk '{print $1}')" = "$ino" ] || fail 'apply mcp over a reformatted ~/.claude.json with the same servers writes nothing' "inode $ino" 'a new file'
[ "$(cat "$MVER")" = "$v1" ] || fail 'apply mcp over a reformatted ~/.claude.json does not bump the version' "$v1" "$(cat "$MVER")"
got="$(run status | grep '^mcp')"
[ "$got" = 'mcp: on, figma through the termag MCP broker (https://mcp-broker.example.test)' ] || fail 'mcp status names the servers and broker' 'mcp: on, figma …' "$got"
# A new connector is added and the version bumped; a dropped one is removed.
printf '%s' '{"broker":"https://mcp-broker.example.test","connectors":[{"id":"c3abc","name":"linear"}]}' | run apply mcp 2>/dev/null
got="$(jq -c '.mcpServers | keys' "$CJ")"
[ "$got" = '["jira","linear","metaterm"]' ] || fail 'apply mcp drops a removed connector and adds a new one' '["jira","linear","metaterm"]' "$got"
[ "$(cat "$MVER")" != "$v1" ] || fail 'a changed connector set bumps the version' 'a new version' "$v1"
# An entry the owner edited is no longer ours: remove leaves it.
jq '.mcpServers.linear.url = "https://elsewhere.example/mcp"' "$CJ" > "$WORK/cj" && cp "$WORK/cj" "$CJ"
got="$(run status | grep '^mcp')"
case "$got" in 'mcp: NOT WORKING: '*'linear'*) : ;; *) fail 'mcp status notices an entry that changed under it' 'mcp: NOT WORKING: … linear …' "$got" ;; esac
printf '%s' '{"broker":"https://mcp-broker.example.test","connectors":[{"id":"c3abc","name":"linear"},{"id":"c4abc","name":"notion"}]}' | run apply mcp 2>/dev/null
v2="$(cat "$MVER")"
printf '{"reason":"the orchestrator has no MCP broker (MCP_BROKER_URL), so termag adds no MCP servers here"}' | run remove mcp 2>/dev/null
got="$(jq -c '[(.mcpServers | keys), .numStartups]' "$CJ")"
[ "$got" = '[["jira","linear","metaterm"],3]' ] || fail "remove mcp takes out only termag's entries" '[["jira","linear","metaterm"],3]' "$got"
[ ! -e "$MSTATE" ] || fail 'remove mcp deletes its record' 'absent' 'present'
[ ! -e "$ABSTATE" ] || fail 'remove mcp deletes api-broker.json' 'absent' 'present'
[ "$(cat "$MVER")" != "$v2" ] || fail 'remove mcp bumps the version' 'a new version' "$v2"
got="$(run status | grep '^mcp')"
[ "$got" = 'mcp: off: the orchestrator has no MCP broker (MCP_BROKER_URL), so termag adds no MCP servers here' ] || fail "mcp status repeats the orchestrator's reason" 'mcp: off: …' "$got"
# Bad deliveries are refused and change nothing.
cp "$CJ" "$WORK/cj.before"
for bad in '{"broker":"http://x","connectors":[]}' '{"broker":"https://x","connectors":[{"id":"C1","name":"a"}]}' \
           '{"broker":"https://x","connectors":[{"id":"c1","name":"a"},{"id":"c2","name":"a"}]}' \
           '{"broker":"https://x","connectors":[{"id":"c1","name":"a b"}]}' '{"broker":"https://x/../y","connectors":[]}'; do
  printf '%s' "$bad" | run apply mcp >/dev/null 2>&1 && fail "apply mcp refuses $bad" 'non-zero exit' 0
done
cmp -s "$CJ" "$WORK/cj.before" || fail 'a refused mcp delivery leaves ~/.claude.json alone' 'unchanged' 'changed'
# No ~/.claude.json yet: one holding only termag's entry.
rm -f "$CJ"
printf '%s' '{"broker":"https://mcp-broker.example.test","connectors":[{"id":"c1abc","name":"figma"}]}' | run apply mcp 2>/dev/null
got="$(jq -c '[(.mcpServers | keys), (keys)]' "$CJ" 2>&1)"
[ "$got" = '[["figma"],["mcpServers"]]' ] || fail 'apply mcp creates ~/.claude.json when there is none' '[["figma"],["mcpServers"]]' "$got"
run remove mcp </dev/null 2>/dev/null
got="$(jq -c . "$CJ")"
[ "$got" = '{}' ] || fail 'remove mcp leaves an empty object' '{}' "$got"

# The termag-mcp-refresh mod, once termag-reconcile has installed it, is named
# in CLAUDE_CODE_PLUGIN_DIRS beside any folder of the owner's.
PD="$H/.local/share/termag/claude-plugins/termag-mcp-refresh"
cp "$CS" "$WORK/cs.saved" 2>/dev/null || true
printf '{"model":"opus","env":{"FOO":"1","CLAUDE_CODE_PLUGIN_DIRS":"/opt/mine"}}' > "$CS"
printf '%s' '{"broker":"https://mcp-broker.example.test","connectors":[]}' | run apply mcp 2>"$WORK/mcp.err"
got="$(jq -c . "$CS")"
[ "$got" = '{"model":"opus","env":{"FOO":"1","CLAUDE_CODE_PLUGIN_DIRS":"/opt/mine"}}' ] \
  || fail 'apply mcp leaves CLAUDE_CODE_PLUGIN_DIRS alone while the mod is not installed' 'unchanged' "$got"
grep -q 'no termag-mcp-refresh mod' "$WORK/mcp.err" || fail 'apply mcp says the mod is missing' 'a note' "$(cat "$WORK/mcp.err")"
mkdir -p "$PD/.claude-plugin" && echo '{}' > "$PD/.claude-plugin/plugin.json"
printf '%s' '{"broker":"https://mcp-broker.example.test","connectors":[]}' | run apply mcp 2>/dev/null
got="$(jq -c . "$CS")"
want="$(jq -cn --arg d "/opt/mine:$PD" '{model:"opus",env:{FOO:"1",CLAUDE_CODE_PLUGIN_DIRS:$d}}')"
[ "$got" = "$want" ] || fail "apply mcp adds the mod to CLAUDE_CODE_PLUGIN_DIRS after the owner's folder" "$want" "$got"
cp "$CS" "$WORK/cs.before"
printf '%s' '{"broker":"https://mcp-broker.example.test","connectors":[]}' | run apply mcp 2>/dev/null
cmp -s "$CS" "$WORK/cs.before" || fail 'a repeated apply mcp leaves settings.json alone' 'unchanged' "$(jq -c . "$CS")"
run remove mcp </dev/null 2>/dev/null
got="$(jq -c . "$CS")"
[ "$got" = '{"model":"opus","env":{"FOO":"1","CLAUDE_CODE_PLUGIN_DIRS":"/opt/mine"}}' ] \
  || fail "remove mcp takes the mod out and keeps the owner's folder" '/opt/mine only' "$got"
printf '{"model":"opus"}' > "$CS"
printf '%s' '{"broker":"https://mcp-broker.example.test","connectors":[]}' | run apply mcp 2>/dev/null
got="$(jq -r '.env.CLAUDE_CODE_PLUGIN_DIRS' "$CS")"
[ "$got" = "$PD" ] || fail 'apply mcp sets CLAUDE_CODE_PLUGIN_DIRS when there is none' "$PD" "$got"
run remove mcp </dev/null 2>/dev/null
got="$(jq -c . "$CS")"
[ "$got" = '{"model":"opus"}' ] || fail 'remove mcp leaves no empty env behind' '{"model":"opus"}' "$got"
rm -rf "$PD"
if [ -s "$WORK/cs.saved" ]; then cp "$WORK/cs.saved" "$CS"; else rm -f "$CS"; fi

# Claude Code writes ~/.claude.json between termag's read and its write: the
# merge runs again on the new file instead of reverting that write. The jq stub
# makes the write right after the first merge.
printf '{"numStartups":3}' > "$CJ"
REALJQ="$(command -v jq)"
cat > "$STUB/jq" <<STUBEOF
#!/bin/sh
"$REALJQ" "\$@"; rc=\$?
case "\$*" in *'--slurpfile d'*)
  if [ ! -e "$WORK/claude-wrote" ]; then : > "$WORK/claude-wrote"; printf '{"numStartups":4,"tipsShown":1}' > "$CJ"; fi ;;
esac
exit \$rc
STUBEOF
chmod 755 "$STUB/jq"
printf '%s' '{"broker":"https://mcp-broker.example.test","connectors":[{"id":"c1abc","name":"figma"}]}' | run apply mcp 2>"$WORK/mcp.err"; got=$?
rm -f "$STUB/jq"
[ -e "$WORK/claude-wrote" ] || fail 'the jq stub wrote ~/.claude.json mid-merge' 'written' 'not written'
got="$(jq -c '[.numStartups, .tipsShown, (.mcpServers | keys)]' "$CJ")"
[ "$got" = '[4,1,["figma"]]' ] || fail 'apply mcp keeps a write Claude Code made during the merge' '[4,1,["figma"]]' "$got $(cat "$WORK/mcp.err")"

# Another writer holds termag's lock: apply waits for it, and gives up unchanged.
if command -v flock >/dev/null 2>&1; then
  run remove mcp </dev/null 2>/dev/null
  cp "$CJ" "$WORK/cj.before"
  flock "$H/.config/termag/claude-json.lock" sleep 3 &
  holder=$!
  sleep 0.5
  export TERMAG_MCP_LOCK_WAIT=1
  printf '%s' '{"broker":"https://mcp-broker.example.test","connectors":[{"id":"c1abc","name":"figma"}]}' | run apply mcp 2>"$WORK/mcp.err"; got=$?
  unset TERMAG_MCP_LOCK_WAIT
  [ "$got" != 0 ] || fail 'apply mcp gives up while another writer holds the lock' 'non-zero exit' 0
  cmp -s "$CJ" "$WORK/cj.before" || fail 'apply mcp that gave up on the lock leaves ~/.claude.json alone' 'unchanged' 'changed'
  printf '%s' '{"broker":"https://mcp-broker.example.test","connectors":[{"id":"c1abc","name":"figma"}]}' | run apply mcp 2>"$WORK/mcp.err"; got=$?
  [ "$got" = 0 ] || fail 'apply mcp waits for the lock and then applies' 0 "$got: $(cat "$WORK/mcp.err")"
  got="$(jq -c '.mcpServers | keys' "$CJ")"
  [ "$got" = '["figma"]' ] || fail 'apply mcp after waiting for the lock writes the entry' '["figma"]' "$got"
  wait "$holder"
else
  echo 'SKIP: flock is not installed; the MCP lock test needs it'
fi

# ── MCP servers for the other agent CLIs (mcp-broker-v2) ────────────────────
run remove mcp </dev/null 2>/dev/null
BRIDGE="$(dirname "$SCRIPT")/termag-mcp-bridge"
CODEX="$H/.codex/config.toml"; CURSOR="$H/.cursor/mcp.json"; PI="$H/.pi/agent/mcp.json"
DEVIN="$H/.config/devin/mcp_config.json"; AST="$H/.config/termag/mcp-agents.json"
mkdir -p "$H/.codex" "$H/.cursor" "$H/.pi/agent"
printf 'model = "o3"\n\n[mcp_servers.jira]\ncommand = "mine"\n' > "$CODEX"
cp "$CODEX" "$WORK/codex.orig"
printf '{"mcpServers":{"jira":{"command":"mine"}},"other":1}' > "$CURSOR"
printf '{"mcpServers":{"metaterm":{"type":"stdio","command":"~/.local/bin/termag-metaterm-mcp"}}}' > "$PI"
ALL_AGENTS='"agents":["auggie","codex","cursor","devin","gemini","pi","vibe"]'
CONNS='"connectors":[{"id":"c1abc","name":"figma"},{"id":"c2abc","name":"jira"}]'
MCPV2="{\"broker\":\"https://mcp-broker.example.test\",$CONNS,$ALL_AGENTS}"
arun() { TERMAG_MCP_AGENTS_INSTALLED='codex cursor devin pi' run "$@"; }
printf '%s' "$MCPV2" | arun apply mcp 2>"$WORK/mcp.err"; got=$?
[ "$got" = 0 ] || fail 'apply mcp with agents succeeds' 0 "$got: $(cat "$WORK/mcp.err")"
want="$(jq -cn --arg b "$BRIDGE" --arg c "$CONFIG" '{command:$b,args:["https://mcp-broker.example.test/c/c1abc",$c]}')"
got="$(jq -c '.mcpServers.figma' "$CURSOR")"
[ "$got" = "$want" ] || fail 'cursor gets a stdio entry that runs the bridge on the broker URL and the agent config' "$want" "$got"
got="$(jq -c '[.mcpServers.jira, .other]' "$CURSOR")"
[ "$got" = '[{"command":"mine"},1]' ] || fail "cursor keeps the owner's same-named server and other keys" '[{"command":"mine"},1]' "$got"
grep -q "left your own MCP server jira in $CURSOR" "$WORK/mcp.err" || fail 'apply mcp says it left the owner'"'"'s cursor jira' 'a note' "$(cat "$WORK/mcp.err")"
got="$(jq -c '.mcpServers | keys' "$PI")"
[ "$got" = '["figma","jira","metaterm"]' ] || fail 'pi gets both connectors beside metaterm' '["figma","jira","metaterm"]' "$got"
got="$(jq -c '.mcpServers.figma.transport' "$DEVIN")"
[ "$got" = '"stdio"' ] || fail "devin's entries name their transport, and its config is created" '"stdio"' "$got"
for f in "$H/.gemini/settings.json" "$H/.augment/settings.json" "$H/.vibe/config.toml"; do
  [ ! -e "$f" ] || fail 'no config is created for an agent CLI that is not installed' 'absent' "$f"
done
got="$(grep -c 'mcp_servers.figma' "$CODEX")"
[ "$got" = 1 ] || fail 'codex gets a figma table' 1 "$got"
grep -q 'mcp_servers.jira' "$CODEX" && [ "$(grep -c '^\[mcp_servers.jira\]' "$CODEX")" = 1 ] \
  || fail "codex keeps the owner's jira and adds no second one" 'one [mcp_servers.jira]' "$(cat "$CODEX")"
if python3 -c 'import tomllib' >/dev/null 2>&1; then
  got="$(python3 -I -c 'import sys, tomllib, json; d = tomllib.load(open(sys.argv[1], "rb")); print(json.dumps([d["model"], d["mcp_servers"]["figma"]["args"][0], d["mcp_servers"]["jira"]["command"]]))' "$CODEX")"
  [ "$got" = '["o3", "https://mcp-broker.example.test/c/c1abc", "mine"]' ] || fail "codex's config still parses, with ours and theirs" 'o3, figma args, jira mine' "$got"
fi
grep -qF "$BOX_TOKEN" "$CODEX" "$CURSOR" "$PI" "$DEVIN" "$AST" && fail 'no agent config holds the token' 'no token' 'token present'
got="$(jq -c 'with_entries(.value |= keys)' "$AST")"
[ "$got" = '{"codex":["figma"],"cursor":["figma"],"devin":["figma","jira"],"pi":["figma","jira"]}' ] \
  || fail 'the agents state records exactly what was written' 'codex/cursor figma, devin/pi both' "$got"
got="$(stat -c %a "$DEVIN")"
[ "$got" = 600 ] || fail "a config termag creates is the owner's only" 600 "$got"

for f in "$CODEX" "$CURSOR" "$PI" "$DEVIN"; do cp "$f" "$WORK/$(basename "$(dirname "$f")").before"; done
printf '%s' "$MCPV2" | arun apply mcp 2>/dev/null
for f in "$CODEX" "$CURSOR" "$PI" "$DEVIN"; do
  cmp -s "$f" "$WORK/$(basename "$(dirname "$f")").before" || fail 'a repeated apply mcp leaves every agent config alone' 'unchanged' "$f"
done
got="$(run status | grep '^mcp (codex)')"
[ "$got" = "mcp (codex): on, figma through termag-mcp-bridge ($CODEX)" ] || fail 'status names each agent' 'mcp (codex): on, figma …' "$got"

# pi's /mcp writes exposure into the entry: still ours, and kept.
jq '.mcpServers.figma.exposure = "direct"' "$PI" > "$WORK/pi-mcp.json" && cp "$WORK/pi-mcp.json" "$PI"
printf '%s' "$MCPV2" | arun apply mcp 2>/dev/null
got="$(jq -c '.mcpServers.figma.exposure' "$PI")"
[ "$got" = '"direct"' ] || fail "an exposure the owner set on pi's entry survives a delivery" '"direct"' "$got"
got="$(run status | grep '^mcp (pi)')"
case "$got" in 'mcp (pi): on, figma, jira '*) : ;; *) fail 'a tuned pi entry is still on in status' 'mcp (pi): on, figma, jira …' "$got" ;; esac

# Fewer connectors and agents: termag's entries go, the owner's stay.
printf '%s' '{"broker":"https://mcp-broker.example.test","connectors":[{"id":"c1abc","name":"figma"}],"agents":["codex","pi"]}' | arun apply mcp 2>/dev/null
got="$(jq -c '[(.mcpServers | keys), .mcpServers.figma.exposure]' "$PI")"
[ "$got" = '[["figma","metaterm"],"direct"]' ] || fail 'pi loses the dropped connector only' '[["figma","metaterm"],"direct"]' "$got"
got="$(jq -c '.mcpServers | keys' "$CURSOR")"
[ "$got" = '["jira"]' ] || fail 'cursor, no longer named, keeps only the owner'"'"'s server' '["jira"]' "$got"
got="$(jq -c '.mcpServers // {} | keys' "$DEVIN")"
[ "$got" = '[]' ] || fail "devin, no longer named, has no termag server left" '[]' "$got"

# An orchestrator from before mcp-broker-v2 sends no agents: they stay as they are.
cp "$CODEX" "$WORK/codex.before"
printf '%s' '{"broker":"https://mcp-broker.example.test","connectors":[]}' | arun apply mcp 2>/dev/null
cmp -s "$CODEX" "$WORK/codex.before" || fail 'a delivery without agents leaves the agent configs alone' 'unchanged' "$(cat "$CODEX")"

for bad in '{"broker":"https://b.example","connectors":[],"agents":["emacs"]}' \
           '{"broker":"https://b.example","connectors":[],"agents":"codex"}' \
           '{"broker":"https://b.example","connectors":[],"agents":["codex","codex"]}'; do
  printf '%s' "$bad" | arun apply mcp >/dev/null 2>&1 && fail "apply mcp refuses $bad" 'non-zero exit' 0
done

# A codex config that does not parse is left alone; the other agents still converge.
if python3 -c 'import tomllib' >/dev/null 2>&1; then
  printf 'model = "o3\n' > "$WORK/bad.toml"; cp "$CODEX" "$WORK/codex.good"; cp "$WORK/bad.toml" "$CODEX"
  printf '%s' "{\"broker\":\"https://mcp-broker.example.test\",$CONNS,\"agents\":[\"codex\",\"pi\"]}" | arun apply mcp 2>"$WORK/mcp.err"; got=$?
  [ "$got" != 0 ] || fail 'apply mcp reports a codex config it could not merge into' 'non-zero exit' 0
  cmp -s "$CODEX" "$WORK/bad.toml" || fail 'an invalid codex config is left as it was' 'unchanged' "$(cat "$CODEX")"
  got="$(jq -c '.mcpServers | keys' "$PI")"
  [ "$got" = '["figma","jira","metaterm"]' ] || fail 'pi still gets its entries' '["figma","jira","metaterm"]' "$got"
  cp "$WORK/codex.good" "$CODEX"
fi

run remove mcp </dev/null 2>/dev/null
cmp -s "$CODEX" "$WORK/codex.orig" || fail "remove mcp gives the owner's codex config back as it was" "$(cat "$WORK/codex.orig")" "$(cat "$CODEX")"
got="$(jq -c '.mcpServers | keys' "$PI")"
[ "$got" = '["metaterm"]' ] || fail 'remove mcp takes termag'"'"'s pi entries out' '["metaterm"]' "$got"
[ ! -e "$AST" ] || fail 'remove mcp deletes the agents record' 'absent' 'present'

got="$("$BRIDGE" 2>&1)"; code=$?
case "$code:$got" in 2:*usage*) : ;; 127:*'no usable Node.js'*) : ;; *) fail 'termag-mcp-bridge without arguments prints its usage' '2: usage' "$code: $got" ;; esac

# Without node on PATH the bridge takes the nvm node, as agent/run-node.sh does.
# The stub nvm.sh is like the real one: it reads variables that may be unset,
# its auto-use follows the cwd's .nvmrc (here a version that is not installed,
# so no node), and with --no-use it leaves PATH alone.
NVMV="$WORK/nvm/versions/node/v99.0.0/bin"
mkdir -p "$WORK/nonode" "$NVMV" "$WORK/nvmrc-project"
for t in bash dirname sort; do ln -sf "$(command -v "$t")" "$WORK/nonode/$t"; done
printf '#!/bin/sh\necho "node $*"\n' > "$NVMV/node"; chmod +x "$NVMV/node"
cat > "$WORK/nvm/nvm.sh" <<NVM
: "\$TERMAG_TEST_UNSET_IN_NVM"
nvm() { [ "\$1 \$2" = 'which default' ] && echo "$NVMV/node"; }
case " \$* " in
  *' --no-use '*) ;;
  *) if [ -f .nvmrc ]; then echo "N/A: version \$(cat .nvmrc) is not yet installed." >&2; else PATH="$NVMV:\$PATH"; fi ;;
esac
NVM
echo v1.2.3 > "$WORK/nvmrc-project/.nvmrc"
want="node $(dirname "$BRIDGE")/../agent/mcp-bridge.js https://b.example/c/x cfg.json"
got="$(env -u TERMAG_TEST_UNSET_IN_NVM PATH="$WORK/nonode" NVM_DIR="$WORK/nvm" "$BRIDGE" https://b.example/c/x cfg.json 2>/dev/null)"
[ "$got" = "$want" ] || fail 'termag-mcp-bridge finds nvm node though nvm.sh reads an unset variable' "$want" "$got"
got="$(cd "$WORK/nvmrc-project" && env -u TERMAG_TEST_UNSET_IN_NVM PATH="$WORK/nonode" NVM_DIR="$WORK/nvm" "$BRIDGE" https://b.example/c/x cfg.json 2>/dev/null)"
[ "$got" = "$want" ] || fail "termag-mcp-bridge finds nvm node in a project whose .nvmrc names a version that isn't installed" "$want" "$got"

# ── Fireworks (pi and Claude Code, through the gateway) ─────────────────────
PIM="$WORK/pi/models.json"; FWS="$H/.config/termag/fireworks.json"; FWC="$H/.config/termag/claude-fireworks.json"
runfw() { TERMAG_PI_MODELS="$PIM" run "$@"; }
KIMI=accounts/fireworks/models/kimi-k3; DS=accounts/fireworks/routers/deepseek-v4p1-flash-spot
FW='{"baseUrl":"https://gw.example/fireworks/"}'
# The owner's pi models file, with a provider of their own; it must survive.
mkdir -p "$(dirname "$PIM")"
printf '{"providers":{"ollama":{"baseUrl":"http://localhost:11434/v1","api":"openai-completions","models":[{"id":"q"}]}}}' > "$PIM"
cp "$CS" "$WORK/cs.before" 2>/dev/null || echo '{}' > "$WORK/cs.before"
printf '%s' "$FW" | runfw apply fireworks 2>/dev/null; got=$?
[ "$got" = 0 ] || fail 'apply fireworks succeeds' 0 "$got"
got="$(jq -c '.env | [.ANTHROPIC_BASE_URL, .CLAUDE_CODE_USE_BEDROCK, .ANTHROPIC_MODEL]' "$FWC")"
[ "$got" = '["https://gw.example/fireworks/inference","",null]' ] \
  || fail "Claude Code's Fireworks settings leave Bedrock for the gateway's Anthropic route, with no model of their own" 'gw/inference, no bedrock, no model' "$got"
got="$(jq -r .apiKeyHelper "$FWC")"
[ "$got" = "'$HELPER' '$CONFIG'" ] || fail "Claude Code's Fireworks apiKeyHelper is the token helper" "'$HELPER' '$CONFIG'" "$got"
got="$(jq -c '.providers | keys' "$PIM")"
[ "$got" = '["ollama"]' ] || fail "apply adds no pi provider before a launch names a model" '["ollama"]' "$got"
cmp -s "$CS" "$WORK/cs.before" || fail "apply fireworks leaves ~/.claude/settings.json alone" unchanged changed
got="$(stat -c %a "$FWC")"
[ "$got" = 600 ] || fail 'the Claude Code settings file is 0600' 600 "$got"
out="$(printf '%s' "$FW" | runfw apply fireworks 2>&1)"
[ -z "$out" ] || fail 'a repeated fireworks delivery is silent' '' "$out"
for bad in '{"baseUrl":"http://gw/fireworks"}' '{"baseUrl":"https://gw/fireworks","models":[]}' '{}' '{"baseUrl":"https://gw/fire works"}'; do
  printf '%s' "$bad" | runfw apply fireworks >/dev/null 2>&1 && fail 'apply fireworks refuses a malformed delivery' refused "applied: $bad"
done
got="$(jq -r .baseUrl "$FWS")"
[ "$got" = https://gw.example/fireworks/ ] || fail 'a refused delivery leaves the last good one' https://gw.example/fireworks/ "$got"

# pi-model: each model a pi launch names goes into pi's provider, with its window.
runfw pi-model --model "$KIMI" --context 1048576 </dev/null 2>/dev/null || fail 'pi-model succeeds' 0 $?
runfw pi-model --model "$DS" </dev/null 2>/dev/null
runfw pi-model --model "$KIMI" --context 512000 </dev/null 2>/dev/null
got="$(jq -c '.providers["termag-fireworks"] | [.baseUrl, .api, [.models[] | [.id, .contextWindow]]]' "$PIM")"
[ "$got" = "[\"https://gw.example/fireworks/inference/v1\",\"openai-completions\",[[\"$DS\",null],[\"$KIMI\",512000]]]" ] \
  || fail "pi's provider points at the gateway's OpenAI route and holds each launched model once, with its latest window" 'gw/inference/v1 + 2 models' "$got"
got="$(jq -r '.providers.ollama.baseUrl' "$PIM")"
[ "$got" = http://localhost:11434/v1 ] || fail "the owner's own pi provider is kept" http://localhost:11434/v1 "$got"
got="$(sh -c "$(jq -r '.providers["termag-fireworks"].apiKey | ltrimstr("!")' "$PIM")")"
[ "$got" = "$BOX_TOKEN" ] || fail "pi's apiKey command prints the box token" "$BOX_TOKEN" "$got"
grep -qF "$BOX_TOKEN" "$PIM" "$FWC" "$FWS" && fail 'no Fireworks file holds the token' 'no token' 'token present'
for bad in 'gpt-5' 'accounts/fireworks/models/x;rm' ''; do
  runfw pi-model --model "$bad" </dev/null >/dev/null 2>&1 && fail 'pi-model refuses a model that is not a Fireworks id' refused "$bad"
done
runfw pi-model --model "$KIMI" --context lots </dev/null >/dev/null 2>&1 && fail 'pi-model refuses a window that is not a number' refused lots
# A new delivery (a new gateway base) keeps the launched models.
printf '{"baseUrl":"https://gw2.example/fireworks"}' | runfw apply fireworks 2>/dev/null
got="$(jq -c '.providers["termag-fireworks"] | [.baseUrl, (.models | length)]' "$PIM")"
[ "$got" = '["https://gw2.example/fireworks/inference/v1",2]' ] || fail "a new base moves pi's provider and keeps its models" '[gw2, 2]' "$got"
printf '%s' "$FW" | runfw apply fireworks 2>/dev/null

# pi-model --models: the flag's list (fireworksMenuArg) becomes pi's provider, for pi's /model:
# every model by its label and window, in the flag's order; one dropped from the flag goes.
pim() { jq -cn "$1" | base64 | tr -d '\n'; }
pimodels() { jq -c '[.providers["termag-fireworks"].models[] | [.id, .name, .contextWindow]]' "$PIM"; }
GF=accounts/fireworks/models/glm-5p3-flash DSF=accounts/fireworks/models/deepseek-v4p1-flash-1017
cp "$PIM" "$WORK/pim.keep"; cp "$H/.config/termag/fireworks-pi.json" "$WORK/pis.keep" 2>/dev/null || true
THREE="$(pim "[{id:\"$GF\",label:\"GLM 5.3 Flash\",context:1048576},{id:\"$DSF\",label:\"DeepSeek V4.1 Flash\",context:1048576},{id:\"$KIMI\",label:\"Kimi K3\",context:1048576}]")"
runfw pi-model --model "$GF" --context 1048576 --models "$THREE" </dev/null 2>/dev/null || fail 'pi-model --models succeeds' 0 $?
got="$(pimodels)"
[ "$got" = "[[\"$GF\",\"GLM 5.3 Flash\",1048576],[\"$DSF\",\"DeepSeek V4.1 Flash\",1048576],[\"$KIMI\",\"Kimi K3\",1048576]]" ] \
  || fail "pi-model --models writes all three of the flag's models, by label, with their windows, and drops models launched before" 'three rows' "$got"
got="$(jq -r '.providers.ollama.baseUrl' "$PIM")"
[ "$got" = http://localhost:11434/v1 ] || fail "--models leaves the owner's own pi provider" http://localhost:11434/v1 "$got"
# One model: only it.
runfw pi-model --model "$KIMI" --models "$(pim "[{id:\"$KIMI\",label:\"Kimi K3\",context:1048576}]")" </dev/null 2>/dev/null
got="$(pimodels)"
[ "$got" = "[[\"$KIMI\",\"Kimi K3\",1048576]]" ] || fail 'pi-model --models with one model: only it, and the other two are removed' 'one row' "$got"
# A label with spaces, a model with no window, and the launch's model missing from the list.
runfw pi-model --model "$DS" --context 200000 --models "$(pim "[{id:\"$KIMI\",label:\"  Kimi K3 (preview, 1M)  \"},{id:\"$GF\",label:\"GLM 5.3 Flash\",context:1048576}]")" </dev/null 2>/dev/null
got="$(pimodels)"
[ "$got" = "[[\"$KIMI\",\"Kimi K3 (preview, 1M)\",null],[\"$GF\",\"GLM 5.3 Flash\",1048576],[\"$DS\",\"deepseek-v4p1-flash-spot\",200000]]" ] \
  || fail 'a label with spaces is kept whole, a model with no window gets none, and the launch model is kept though the flag lacks it' 'three rows' "$got"
# The launch's window wins for its own model; an unreadable list adds the launch's model alone, saying so.
runfw pi-model --model "$GF" --context 512000 --models "$THREE" </dev/null 2>/dev/null
got="$(jq -c '[.providers["termag-fireworks"].models[] | select(.id == "'"$GF"'") | .contextWindow]' "$PIM")"
[ "$got" = '[512000]' ] || fail "the launch's --context is its model's window" '[512000]' "$got"
runfw pi-model --model "$KIMI" --models 'bm90IGpzb24=' </dev/null 2>"$WORK/err"; code=$?
got="$(pimodels | jq -c 'length')"
[ "$code" = 0 ] && [ "$got" = 3 ] && grep -q 'not a model list' "$WORK/err" \
  || fail 'an unreadable --models still launches, keeping the provider and saying why' '0, 3 rows, a reason' "$code, $got"
runfw pi-model --model "$KIMI" --models 'a;b' </dev/null >/dev/null 2>&1 || fail '--models that is not base64 does not fail the launch' 0 $?
grep -q 'termag-credentials: fireworks-pi-menu-v1' "$SCRIPT" || fail 'the script carries the fireworks-pi-menu-v1 marker agent/credentials.js reads' marker missing
grep -q 'termag-pi-fireworks: fireworks-pi-menu-v1' "$(dirname "$SCRIPT")/termag-pi-fireworks" || fail 'the launcher carries its fireworks-pi-menu-v1 marker' marker missing
# Back to the provider the tests below expect.
cp "$WORK/pim.keep" "$PIM"; if [ -s "$WORK/pis.keep" ]; then cp "$WORK/pis.keep" "$H/.config/termag/fireworks-pi.json"; fi

# launch-settings: the one --settings a Claude Code launch on the backend gets, with the launch's model.
got="$(runfw launch-settings --backend fireworks --model "$KIMI" --fast "$DS" --context 512000 - 2>/dev/null \
  | jq -c '.env | [.ANTHROPIC_BASE_URL, .ANTHROPIC_MODEL, .ANTHROPIC_DEFAULT_SONNET_MODEL, .ANTHROPIC_SMALL_FAST_MODEL, .ANTHROPIC_DEFAULT_HAIKU_MODEL, .CLAUDE_CODE_MAX_CONTEXT_TOKENS]')"
[ "$got" = "[\"https://gw.example/fireworks/inference\",\"$KIMI\",\"$KIMI\",\"$DS\",\"$DS\",\"512000\"]" ] \
  || fail "launch-settings puts the launch's model on every tier, the fast one on haiku, and the window" 'kimi tiers, ds fast, 512000' "$got"
got="$(runfw launch-settings --backend fireworks --model "$KIMI" - 2>/dev/null | jq -c '.env | [.ANTHROPIC_SMALL_FAST_MODEL, .CLAUDE_CODE_MAX_CONTEXT_TOKENS]')"
[ "$got" = "[\"$KIMI\",null]" ] || fail 'without --fast the model is the fast one too, and without --context there is no window' "[kimi,null]" "$got"
# --models: the flag's list (fireworksMenuArg) becomes Claude Code's /model menu, in its order, by label;
# every tier points at a Fireworks model and is named from the list.
fwm() { jq -cn "$1" | base64 | tr -d '\n'; }
GLMF=accounts/fireworks/models/glm-5p3-flash GLM=accounts/fireworks/models/glm-5p3 MM=accounts/fireworks/models/minimax-m3
FIVE="$(fwm "[{id:\"$GLMF\",label:\"GLM 5.3 Flash\",context:200000},{id:\"$KIMI\",label:\"Kimi K3\",context:1048576},{id:\"$DS\",label:\"DeepSeek V4.1 Flash\",context:1048576},{id:\"$GLM\",label:\"GLM 5.3\",context:131072},{id:\"$MM\",label:\"MiniMax M3\",context:512000}]")"
got="$(runfw launch-settings --backend fireworks --model "$KIMI" --fast "$DS" --context 1048576 --models "$FIVE" - 2>/dev/null \
  | jq -c '[.modelPicker.replaceBuiltInOptions, [.modelPicker.options[] | [.label, .description]]]')"
[ "$got" = '[true,[["GLM 5.3 Flash","Fireworks · 200k context"],["Kimi K3","Fireworks · 1M context"],["DeepSeek V4.1 Flash","Fireworks · 1M context"],["GLM 5.3","Fireworks · 128k context"],["MiniMax M3","Fireworks · 512k context"]]]' ] \
  || fail "launch-settings lists all five of the flag's models in its order, by label, with their windows" 'five rows' "$got"
got="$(runfw launch-settings --backend fireworks --model "$KIMI" --fast "$DS" --models "$FIVE" - 2>/dev/null \
  | jq -r '.env | [.ANTHROPIC_DEFAULT_OPUS_MODEL, .ANTHROPIC_DEFAULT_OPUS_MODEL_NAME, .ANTHROPIC_DEFAULT_SONNET_MODEL, .ANTHROPIC_DEFAULT_FABLE_MODEL, .ANTHROPIC_DEFAULT_FABLE_MODEL_NAME, .ANTHROPIC_DEFAULT_HAIKU_MODEL, .ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME, .ANTHROPIC_DEFAULT_HAIKU_MODEL_DESCRIPTION] | join("|")')"
[ "$got" = "$KIMI|Kimi K3|$KIMI|$KIMI|Kimi K3|$DS|DeepSeek V4.1 Flash|Fireworks · 1M context" ] \
  || fail 'every tier, fable included, is the launch model (haiku the fast one), named from the list' 'kimi tiers, ds haiku' "$got"
# One model; a repeated id, a bad one, a missing or blank label and an unknown window.
got="$(runfw launch-settings --backend fireworks --model "$KIMI" --models "$(fwm "[{id:\"$KIMI\"}]")" - 2>/dev/null | jq -c '[.modelPicker.options, .env.ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME]')"
[ "$got" = "[[{\"model\":\"$KIMI\",\"label\":\"kimi-k3\",\"description\":\"Fireworks\"}],\"kimi-k3\"]" ] || fail 'one model with no label is one row named by its id' 'one row' "$got"
got="$(runfw launch-settings --backend fireworks --model "$KIMI" --models "$(fwm "[{id:\"$KIMI\",label:\"Kimi K3\"},{id:\"$KIMI\",label:\"again\"},{id:\"gpt-5\"},\"x\",{id:\"$GLM\",label:\"  \"}]")" - 2>/dev/null | jq -c '[.modelPicker.options[] | .label]')"
[ "$got" = '["Kimi K3","glm-5p3"]' ] || fail 'a repeated id is listed once, a bad entry dropped, a blank label is the id' '[Kimi K3, glm-5p3]' "$got"
# A list it cannot read leaves the launch as it was without one, saying so.
got="$(runfw launch-settings --backend fireworks --model "$KIMI" --models 'bm90IGpzb24=' - 2>"$WORK/err" | jq -c '[has("modelPicker"), .env.ANTHROPIC_DEFAULT_FABLE_MODEL]')"
[ "$got" = "[false,\"$KIMI\"]" ] && grep -q 'not a model list' "$WORK/err" || fail 'an unreadable --models still launches, with no menu, and says why' "[false,kimi]" "$got"
got="$(runfw launch-settings --backend fireworks --model "$KIMI" --models 'a;b' - 2>/dev/null | jq -c 'has("modelPicker")')"
[ "$got" = false ] || fail '--models that is not base64 is ignored' false "$got"
grep -q 'termag-credentials: fireworks-menu-v1' "$SCRIPT" || fail 'the script carries the fireworks-menu-v1 marker agent/credentials.js reads' marker missing
runfw launch-settings --backend fireworks - >/dev/null 2>&1 && fail 'launch-settings on fireworks needs a model' non-zero 0
runfw launch-settings --backend fireworks --model gpt-5 - >/dev/null 2>&1 && fail 'launch-settings refuses a model that is not a Fireworks id' non-zero 0
# With termag's telemetry on, the launch's resource attributes ride in the same JSON.
cp "$CS" "$WORK/cs.keep"; TSTATE="$H/.config/termag/telemetry.json"; [ -e "$TSTATE" ] && cp "$TSTATE" "$WORK/tstate.keep"
jq '.env.OTEL_RESOURCE_ATTRIBUTES = "telemetry.project_id=abc"' "$WORK/cs.keep" > "$CS"; echo '{"env":{}}' > "$TSTATE"
got="$(TERMAG_PROJECT=webapp TERMAG_WORKSTREAM=main runfw launch-settings --backend fireworks --model "$KIMI" - 2>/dev/null \
  | jq -r '[.env.OTEL_RESOURCE_ATTRIBUTES, .env.ANTHROPIC_BASE_URL, .apiKeyHelper != null] | @tsv')"
[ "$got" = "$(printf 'telemetry.project_id=abc,termag.project=webapp,termag.workstream=main\thttps://gw.example/fireworks/inference\ttrue')" ] \
  || fail "launch-settings merges the launch's telemetry with the Fireworks settings" 'resource + gateway + helper' "$got"
cp "$WORK/cs.keep" "$CS"; if [ -e "$WORK/tstate.keep" ]; then cp "$WORK/tstate.keep" "$TSTATE"; else rm -f "$TSTATE"; fi
got="$(runfw launch-settings - 2>/dev/null)"
[ "$got" = '{}' ] || fail 'launch-settings without --backend is telemetry-launch' '{}' "$got"
# A Fireworks id /model saved as the owner's `model`: every launch off the
# backend starts on the default instead, and the file is left as it is.
cp "$CS" "$WORK/cs.keep"
jq --arg m "$KIMI" '.model = $m' "$WORK/cs.keep" > "$CS"; cp "$CS" "$WORK/cs.fw"
for cmd in telemetry-launch launch-settings; do
  got="$(runfw $cmd - 2>/dev/null)"
  [ "$got" = '{"model":""}' ] || fail "$cmd starts on the default over a saved Fireworks model" '{"model":""}' "$got"
done
cmp -s "$CS" "$WORK/cs.fw" || fail "the guard leaves the owner's settings as they are" unchanged "$(cat "$CS")"
got="$(runfw launch-settings --backend fireworks --model "$DS" - 2>/dev/null | jq -c '[has("model"), .env.ANTHROPIC_MODEL]')"
[ "$got" = "[false,\"$DS\"]" ] || fail 'a Fireworks launch is unchanged by a saved Fireworks model' "[false,ds]" "$got"
for keep in opus 'us.anthropic.claude-opus-4-5-20251101-v1:0' 'accounts/fireworks/models/x;rm'; do
  jq --arg m "$keep" '.model = $m' "$WORK/cs.keep" > "$CS"
  got="$(runfw telemetry-launch - 2>/dev/null)"
  [ "$got" = '{}' ] || fail "a saved model that is not a Fireworks id is kept ($keep)" '{}' "$got"
done
cp "$WORK/cs.keep" "$CS"
runfw launch-settings --backend bedrock - >/dev/null 2>&1 && fail 'launch-settings refuses a backend it does not know' 'non-zero' 0

# remove takes out only our provider; an owner's own under our name is theirs.
runfw remove fireworks </dev/null 2>/dev/null
got="$(jq -c '[.providers | has("termag-fireworks"), has("ollama")]' "$PIM")"
[ "$got" = '[false,true]' ] || fail "remove takes out only termag's pi provider" '[false,true]' "$got"
[ ! -e "$FWC" ] && [ ! -e "$FWS" ] || fail 'remove deletes the Fireworks settings and record' absent present
jq '.providers["termag-fireworks"] = {"baseUrl":"https://mine/v1","api":"openai-completions","models":[]}' "$PIM" > "$PIM.t" && mv "$PIM.t" "$PIM"
printf '%s' "$FW" | runfw apply fireworks 2>/dev/null
runfw pi-model --model "$KIMI" </dev/null 2>/dev/null
got="$(jq -r '.providers["termag-fireworks"].baseUrl' "$PIM")"
[ "$got" = https://mine/v1 ] || fail "an owner's own termag-fireworks provider is kept" https://mine/v1 "$got"
runfw remove fireworks </dev/null 2>/dev/null
got="$(jq -r '.providers["termag-fireworks"].baseUrl' "$PIM")"
[ "$got" = https://mine/v1 ] || fail "remove leaves an owner's own termag-fireworks provider" https://mine/v1 "$got"
jq 'del(.providers["termag-fireworks"])' "$PIM" > "$PIM.t" && mv "$PIM.t" "$PIM"
# No models file yet (pi never ran): the first pi launch makes one.
rm -f "$PIM"
printf '%s' "$FW" | runfw apply fireworks 2>/dev/null
runfw pi-model --model "$KIMI" </dev/null 2>/dev/null
got="$(jq -r '.providers | keys | join(",")' "$PIM")"
[ "$got" = termag-fireworks ] || fail 'pi-model creates pi models file when there is none' termag-fireworks "$got"

# skip: nothing set up, and the next delivery stays off until unskip.
runfw skip fireworks 2>/dev/null
[ ! -e "$FWC" ] && ! jq -e '.providers["termag-fireworks"]' "$PIM" >/dev/null 2>&1 || fail 'skip fireworks removes both agents' removed present
printf '%s' "$FW" | runfw apply fireworks 2>/dev/null
[ ! -e "$FWC" ] || fail 'a delivery to a skipped box sets nothing up' absent present
case "$(runfw status | grep '^fireworks')" in 'fireworks: skipped on this box') : ;; *) fail 'status reports the fireworks skip' skipped "$(runfw status | grep '^fireworks')" ;; esac
out="$(runfw launch-settings --backend fireworks --model "$KIMI" - 2>&1)"; code=$?
[ "$code" != 0 ] || fail 'launch-settings fails on a skipped box, so `&& claude` does not start on Bedrock' non-zero "$code"
case "$out" in *'skipped on this box'*) : ;; *) fail 'launch-settings says the box skipped Fireworks' 'skipped on this box' "$out" ;; esac
runfw pi-model --model "$KIMI" </dev/null >/dev/null 2>&1 && fail 'pi-model fails on a skipped box' non-zero 0
runfw unskip fireworks 2>/dev/null
printf '{"reason":"the orchestrator has no Fireworks gateway (FIREWORKS_GATEWAY_URL), so the Fireworks agents have no models here"}' | runfw remove fireworks 2>/dev/null
got="$(runfw status | grep '^fireworks')"
[ "$got" = 'fireworks: off: the orchestrator has no Fireworks gateway (FIREWORKS_GATEWAY_URL), so the Fireworks agents have no models here' ] \
  || fail "fireworks status repeats the orchestrator's reason" 'fireworks: off: ...' "$got"
out="$(runfw launch-settings --backend fireworks --model "$KIMI" - 2>&1)"; code=$?
[ "$code" != 0 ] || fail 'launch-settings fails where Fireworks was removed' non-zero "$code"
case "$out" in *'not set up on this box: the orchestrator has no Fireworks gateway'*) : ;;
  *) fail "launch-settings gives the orchestrator's reason" 'not set up ...: <reason>' "$out" ;; esac

# status asks <base>/auth-check with the box token as a Bearer.
FW_PORT_FILE="$WORK/fw.port"; FW_SEEN="$WORK/fw.seen"
node -e '
  const [portFile, seen, want] = process.argv.slice(1);
  const fs = require("fs");
  const s = require("http").createServer((q, r) => {
    fs.appendFileSync(seen, `${q.method} ${q.url} ${q.headers.authorization === `Bearer ${want}` ? "box-token" : "other"}\n`);
    if (q.url !== "/fireworks/auth-check") { r.writeHead(404).end(); return; }
    if (q.headers.authorization === `Bearer ${want}`) { r.writeHead(204).end(); return; }
    r.writeHead(403, { "content-type": "application/json" }).end(JSON.stringify({ message: "Only a termag-managed box can use the Fireworks gateway" }));
  }).listen(0, "127.0.0.1", () => fs.writeFileSync(portFile, String(s.address().port)));
' "$FW_PORT_FILE" "$FW_SEEN" "$BOX_TOKEN" & fw_pid=$!
i=0; while [ ! -s "$FW_PORT_FILE" ] && [ "$i" -lt 150 ]; do sleep 0.1; i=$((i + 1)); done
[ -s "$FW_PORT_FILE" ] || { echo "FAIL: the stub Fireworks gateway did not start"; exit 1; }
FWGW="http://127.0.0.1:$(cat "$FW_PORT_FILE")/fireworks"
printf '%s' "$FW" | runfw apply fireworks 2>/dev/null
# apply takes https only; status reads the recorded base, so point it at the stub.
jq --arg b "$FWGW" '.baseUrl = $b' "$FWS" > "$FWS.t" && mv "$FWS.t" "$FWS"
got="$(runfw status | grep '^fireworks')"
[ "$got" = "fireworks: on, pi and Claude Code on the fireworks backend reach Fireworks through the gateway at $FWGW, which accepts this box's token" ] \
  || fail 'fireworks status says on when the gateway accepts the box token' 'fireworks: on, ...' "$got"
[ "$(cat "$FW_SEEN")" = 'GET /fireworks/auth-check box-token' ] || fail 'fireworks status sends the box token to the auth probe only' 'GET /fireworks/auth-check box-token' "$(cat "$FW_SEEN")"
printf '{"termag_url":"wss://b","token":"tmag_flag_off"}\n' > "$CONFIG"
got="$(runfw status | grep '^fireworks')"
[ "$got" = "fireworks: NOT WORKING: the gateway at $FWGW refused this box (HTTP 403): Only a termag-managed box can use the Fireworks gateway" ] \
  || fail "fireworks status repeats the gateway's refusal" 'NOT WORKING ... refused (HTTP 403): ...' "$got"
printf '{"termag_url":"wss://b","token":"%s"}\n' "$BOX_TOKEN" > "$CONFIG"
kill "$fw_pid"; wait "$fw_pid" 2>/dev/null
runfw remove fireworks </dev/null 2>/dev/null

# ── The shared Bazel cache (data path C) ───────────────────────────────────
# The system rc is a file of the test's; "sudo" is a stub that logs each call,
# and can be made slow, to show two runs taking turns on the lock.
BRC="$WORK/etc/bazel.bazelrc"; BZS="$H/.config/termag/bazel-cache.json"; BZLOG="$WORK/bz-sudo.log"; : > "$BZLOG"
cat > "$STUB/bz-sudo" <<STUBEOF
#!/bin/sh
echo "start \$\$ \$1" >> "$BZLOG"
[ ! -s "$WORK/bz-sudo.sleep" ] || sleep "\$(cat "$WORK/bz-sudo.sleep")"
"\$@"; rc=\$?
echo "end \$\$ \$1" >> "$BZLOG"
exit \$rc
STUBEOF
chmod 755 "$STUB/bz-sudo"
# run() pins TERMAG_CREDENTIALS_SUDO to '', so these call the script themselves.
runbz_with() {  # sudo args...
  sudo=$1; shift
  HOME="$H" XDG_CONFIG_HOME="$H/.config" PATH="$STUB:$PATH" TERMAG_CREDENTIALS_SUDO="$sudo" TERMAG_BAZEL_RC="$BRC" \
    TERMAG_AGENT_CONFIG="$CONFIG" "$SCRIPT" "$@"
}
runbz() { runbz_with "$STUB/bz-sudo" "$@"; }
U1='https://termag-bazel-cache-123456789012-us-east-2-an.s3.us-east-2.amazonaws.com/g/2026w45'
U2='https://termag-bazel-cache-123456789012-us-east-2-an.s3.us-east-2.amazonaws.com/g/2026w46-1'
bz() {  # bz <seq> [jq assignments]: a payload with the code defaults
  jq -cn --argjson seq "$1" --arg url "$U1" "{seq: \$seq, url: \$url, flushGeneration: 0, remoteTimeoutSeconds: 5, remoteRetries: 1,
    jobs: 200, downloadOutputs: \"toplevel\", goHostModcache: false} ${2:+| $2}"
}
bzblock() {  # url download timeout retries jobs [gomodcache]
  cat <<EOF
# >>> termag bazel-cache >>>
# Read webapp main's build outputs from termag's shared cache (S3, through
# the VPC endpoint). Boxes only read it; a termag-owned writer fills it.
# A dead cache costs seconds, not the build.
# Added by termag-credentials.
build --remote_cache=$1
build --noremote_upload_local_results
build --remote_download_$2
build --remote_timeout=$3s
build --remote_retries=$4
build --remote_retry_max_delay=1s
build --experimental_circuit_breaker_strategy=failure
build --jobs=$5
EOF
  if [ -n "${6:-}" ]; then
    cat <<EOF
# Go modules from one module cache outside every output base (goHostModcache).
# The keys don't change.
common --repo_env=GO_REPOSITORY_USE_HOST_MODCACHE=1
common --repo_env=GOMODCACHE=$6
EOF
  fi
  echo '# <<< termag bazel-cache <<<'
}

# A box with no system rc: apply creates it with exactly the rendered block.
rm -f "$BRC"
bz 100 | runbz apply bazel-cache 2>/dev/null || fail 'apply bazel-cache succeeds' 0 "$?"
[ "$(cat "$BRC" 2>/dev/null)" = "$(bzblock "$U1" toplevel 5 1 200)" ] \
  || fail 'apply renders the tech spec block from the payload' "$(bzblock "$U1" toplevel 5 1 200)" "$(cat "$BRC" 2>/dev/null)"
[ "$(stat -c %a "$BRC")" = 644 ] || fail 'the system rc is 0644' 644 "$(stat -c %a "$BRC")"
if grep -qE 'remote_downloader|credential_helper' "$BRC"; then fail 'no remote downloader and no credential helper in the block' absent present; fi
[ ! -e "$BRC.termag-new" ] || fail 'no temporary rc is left behind' absent present
[ "$(jq -c . "$BZS")" = "{\"url\":\"$U1\",\"flushGeneration\":0,\"remoteTimeoutSeconds\":5,\"remoteRetries\":1,\"jobs\":200,\"downloadOutputs\":\"toplevel\",\"goHostModcache\":false}" ] \
  || fail 'apply records the values it applied' '{url, flushGeneration: 0, ...}' "$(cat "$BZS" 2>&1)"
[ "$(cat "$H/.config/termag/bazel-cache.seq")" = 100 ] || fail 'apply records its seq' 100 "$(cat "$H/.config/termag/bazel-cache.seq" 2>&1)"

# Idempotent: the same values again (a later seq) write nothing and say nothing.
: > "$BZLOG"; cp "$BRC" "$WORK/brc.before"
out=$(bz 101 | runbz apply bazel-cache 2>&1)
[ -z "$out" ] && [ ! -s "$BZLOG" ] && cmp -s "$BRC" "$WORK/brc.before" || fail 'a repeated delivery changes nothing' 'silent, no sudo' "$out $(cat "$BZLOG")"
# Without the tunables, the code defaults.
jq -cn --arg url "$U1" '{seq: 102, url: $url}' | runbz apply bazel-cache 2>/dev/null
cmp -s "$BRC" "$WORK/brc.before" || fail 'missing tunables take the code defaults' "$(cat "$WORK/brc.before")" "$(cat "$BRC")"

# Tuned values render as such.
bz 103 '.url = "'"$U2"'" | .remoteTimeoutSeconds = 60 | .remoteRetries = 0 | .jobs = 8 | .downloadOutputs = "all"' | runbz apply bazel-cache 2>/dev/null
[ "$(cat "$BRC")" = "$(bzblock "$U2" all 60 0 8)" ] || fail 'the tunables at their limits render' "$(bzblock "$U2" all 60 0 8)" "$(cat "$BRC")"
bz 104 '.remoteTimeoutSeconds = 1 | .remoteRetries = 5 | .jobs = 400' | runbz apply bazel-cache 2>/dev/null
[ "$(cat "$BRC")" = "$(bzblock "$U1" toplevel 1 5 400)" ] || fail 'the other limits render' "$(bzblock "$U1" toplevel 1 5 400)" "$(cat "$BRC")"
bz 105 | runbz apply bazel-cache 2>/dev/null

# goHostModcache (PR 14): true adds the module cache's two lines, with the box
# user's home as an absolute path, and creates the directory; false adds none
# and leaves the directory; it toggles both ways.
GMC="$H/.cache/bazel-gomodcache"
rm -rf "$GMC"
if grep -qE 'GOMODCACHE|GO_REPOSITORY_USE_HOST_MODCACHE' "$BRC"; then fail 'goHostModcache false renders no module cache lines' absent "$(cat "$BRC")"; fi
bz 105 '.goHostModcache = true' | runbz apply bazel-cache 2>/dev/null || fail 'apply with goHostModcache succeeds' 0 "$?"
[ "$(cat "$BRC")" = "$(bzblock "$U1" toplevel 5 1 200 "$GMC")" ] || fail 'goHostModcache true renders its two lines' "$(bzblock "$U1" toplevel 5 1 200 "$GMC")" "$(cat "$BRC")"
case $GMC in /*) grep -qxF "common --repo_env=GOMODCACHE=$GMC" "$BRC" ;; *) false ;; esac || fail 'GOMODCACHE is the absolute path under the home' "$GMC" "$(grep GOMODCACHE "$BRC")"
[ -d "$GMC" ] && [ -z "$(ls -A "$GMC")" ] || fail 'goHostModcache true creates the module cache directory, and leaves no probe in it' 'empty directory' "$(ls -A "$GMC" 2>&1)"
[ "$(jq -r .goHostModcache "$BZS")" = true ] || fail 'status records goHostModcache on' true "$(jq -r .goHostModcache "$BZS")"
: > "$BZLOG"; cp "$BRC" "$WORK/brc.gm"
out=$(bz 105 '.goHostModcache = true' | runbz apply bazel-cache 2>&1)
[ -z "$out" ] && [ ! -s "$BZLOG" ] && cmp -s "$BRC" "$WORK/brc.gm" || fail 'goHostModcache again changes nothing' 'silent, no sudo' "$out $(cat "$BZLOG")"
echo m > "$GMC/kept"
bz 105 | runbz apply bazel-cache 2>/dev/null
[ "$(cat "$BRC")" = "$(bzblock "$U1" toplevel 5 1 200)" ] || fail 'goHostModcache off takes its lines out' "$(bzblock "$U1" toplevel 5 1 200)" "$(cat "$BRC")"
[ -e "$GMC/kept" ] || fail 'goHostModcache off leaves the module cache in place' kept deleted
[ "$(jq -r .goHostModcache "$BZS")" = false ] || fail 'status records goHostModcache off' false "$(jq -r .goHostModcache "$BZS")"
bz 105 '.goHostModcache = true' | runbz apply bazel-cache 2>/dev/null
[ "$(cat "$BRC")" = "$(bzblock "$U1" toplevel 5 1 200 "$GMC")" ] && [ -e "$GMC/kept" ] || fail 'goHostModcache on again renders the lines and reuses the directory' 'lines, kept' "$(cat "$BRC")"
# A directory that can't be made, or a home the rc can't hold: the block goes
# in without the lines, says why, and status says off.
rm -rf "$GMC"; : > "$GMC"
out=$(bz 105 '.goHostModcache = true' | runbz apply bazel-cache 2>&1) || fail 'apply succeeds when the module cache cannot be made' 0 "$?"
[ "$(cat "$BRC")" = "$(bzblock "$U1" toplevel 5 1 200)" ] && case $out in *"could not be created"*) true ;; *) false ;; esac && [ "$(jq -r .goHostModcache "$BZS")" = false ] \
  || fail 'an unusable module cache directory renders no lines, and says so' 'no lines, a message, false' "$out $(cat "$BRC")"
rm -f "$GMC"
# An existing directory the box user can't write: mkdir -p succeeds, the probe
# doesn't. Root writes through 0555, so the case only means something as a
# normal user, which is what a box user is.
if [ "$(id -u)" != 0 ]; then
  mkdir -p "$GMC"; chmod 555 "$GMC"
  out=$(bz 105 '.goHostModcache = true' | runbz apply bazel-cache 2>&1) || fail 'apply succeeds when the module cache is not writable' 0 "$?"
  [ "$(cat "$BRC")" = "$(bzblock "$U1" toplevel 5 1 200)" ] && case $out in *"isn't writable"*) true ;; *) false ;; esac && [ "$(jq -r .goHostModcache "$BZS")" = false ] \
    && [ -z "$(ls -A "$GMC")" ] || fail 'an unwritable module cache directory renders no lines, says so, and leaves no probe' 'no lines, a message, false, empty' "$out $(cat "$BRC")"
  chmod 755 "$GMC"; rm -rf "$GMC"
fi
SPH="$WORK/home with space"; mkdir -p "$SPH/.config/termag"; cp -a "$H/.config/termag/." "$SPH/.config/termag/"
out=$(bz 105 '.goHostModcache = true' | HOME="$SPH" XDG_CONFIG_HOME="$SPH/.config" PATH="$STUB:$PATH" TERMAG_CREDENTIALS_SUDO="$STUB/bz-sudo" \
  TERMAG_BAZEL_RC="$BRC" TERMAG_AGENT_CONFIG="$CONFIG" "$SCRIPT" apply bazel-cache 2>&1)
! grep -q GOMODCACHE "$BRC" && [ ! -e "$SPH/.cache/bazel-gomodcache" ] && case $out in *"can't go into the rc"*) true ;; *) false ;; esac \
  || fail 'a home path the rc cannot hold renders no lines' 'no lines, no directory, a message' "$out $(cat "$BRC")"
rm -rf "$SPH"
bz 105 | runbz apply bazel-cache 2>/dev/null

# Every invalid field or URL refuses the whole payload and leaves the block as it was.
cp "$BRC" "$WORK/brc.good"; cp "$BZS" "$WORK/bzs.good"
for bad in '.seq = -1' '.seq = 1.5' '.seq = "106"' 'del(.seq)' 'del(.url)' '.url = null' \
           '.url = "http://termag-bazel-cache-1-us-east-2-an.s3.us-east-2.amazonaws.com/g/2026w45"' \
           '.url = "https://termag-bazel-cache-1-us-east-2-an.s3.us-east-2.amazonaws.com/g/2026w54"' \
           '.url = "https://termag-bazel-cache-1-us-east-2-an.s3.us-east-2.amazonaws.com/g/2026w00"' \
           '.url = "https://termag-bazel-cache-1-us-east-2-an.s3.us-east-2.amazonaws.com/g/2026w45-0"' \
           '.url = "https://termag-bazel-cache-1-us-east-2-an.s3.us-east-2.amazonaws.com/g/2026w45/"' \
           '.url = "https://termag-bazel-cache-1-us-east-2-an.s3.us-east-2.amazonaws.com/2026w45"' \
           '.url = "https://Termag-bazel-cache.s3.us-east-2.amazonaws.com/g/2026w45"' \
           '.url = "https://my.bucket.s3.us-east-2.amazonaws.com/g/2026w45"' \
           '.url = "https://evil.example/x.s3.us-east-2.amazonaws.com/g/2026w45"' \
           '.url = "https://termag-bazel-cache-1.s3.us-east-2.amazonaws.com.evil.example/g/2026w45"' \
           '.url = "https://termag-bazel-cache-1.s3.us-east-2.amazonaws.com/g/2026w45\nbuild --foo"' \
           '.flushGeneration = -1' '.flushGeneration = 2147483648' '.flushGeneration = "1"' \
           '.remoteTimeoutSeconds = 0' '.remoteTimeoutSeconds = 61' '.remoteTimeoutSeconds = 5.5' \
           '.remoteRetries = -1' '.remoteRetries = 6' '.jobs = 7' '.jobs = 401' '.jobs = "200"' \
           '.downloadOutputs = "minimal"' '.downloadOutputs = "toplevel\nbuild --x"' '.goHostModcache = "true"' '.goHostModcache = 1'; do
  bz 106 "$bad" | runbz apply bazel-cache 2>/dev/null && fail "apply refuses $bad" non-zero 0
done
for bad in 'not json' '[]' '"x"' ''; do
  printf '%s' "$bad" | runbz apply bazel-cache 2>/dev/null && fail "apply refuses the payload '$bad'" non-zero 0
done
cmp -s "$BRC" "$WORK/brc.good" && cmp -s "$BZS" "$WORK/bzs.good" && [ "$(cat "$H/.config/termag/bazel-cache.seq")" = 105 ] \
  || fail 'a refused payload leaves the block, the state and the seq alone' same changed
got=$(bz 106 '.jobs = 401' | runbz apply bazel-cache 2>&1)
case $got in *'refused'*jobs*) ;; *) fail 'a refusal names the field' 'refused: bad jobs' "$got" ;; esac

# seq: a step older than the last one applied is refused, an apply or a remove.
bz 90 '.jobs = 8' | runbz apply bazel-cache 2>"$WORK/err"; code=$?
[ "$code" = 0 ] && cmp -s "$BRC" "$WORK/brc.good" && grep -q 'refused a step older' "$WORK/err" \
  || fail 'an older apply is refused (exit 0, nothing changed, said so)' 'unchanged' "$code $(cat "$WORK/err") $(cat "$BRC")"
printf '{"reason":"a stale off","seq":90}' | runbz remove bazel-cache 2>/dev/null
cmp -s "$BRC" "$WORK/brc.good" || fail 'an older remove is refused: the later apply stands' 'block kept' "$(cat "$BRC")"
# Bugbot on #1202: a refused remove must not leave its reason for status.
[ ! -e "$H/.config/termag/bazel-cache.status" ] || fail "a refused remove records no reason" absent "$(cat "$H/.config/termag/bazel-cache.status")"
bz 105 | runbz apply bazel-cache 2>/dev/null || fail 'the same seq again is applied (a redelivery)' 0 "$?"

# remove: exactly the block; an rc apply created goes again; the seq is recorded.
printf '{"reason":"the flag is off for you","seq":110}' | runbz remove bazel-cache 2>/dev/null
[ ! -e "$BRC" ] || fail 'remove restores a box with no system rc to none' absent "$(cat "$BRC")"
[ ! -e "$BZS" ] || fail 'remove deletes the state' absent present
[ "$(cat "$H/.config/termag/bazel-cache.seq")" = 110 ] || fail 'remove records its seq' 110 "$(cat "$H/.config/termag/bazel-cache.seq")"
[ "$(cat "$H/.config/termag/bazel-cache.status")" = 'the flag is off for you' ] || fail "status keeps the remove's reason" 'the flag is off for you' "$(cat "$H/.config/termag/bazel-cache.status" 2>&1)"
bz 108 | runbz apply bazel-cache 2>/dev/null
[ ! -e "$BRC" ] || fail 'an apply older than the remove is refused' absent present
runbz remove bazel-cache </dev/null 2>/dev/null || fail 'a remove with no payload still removes (an older backend)' 0 "$?"
printf '{"seq":112}' | runbz remove bazel-cache 2>/dev/null
[ ! -e "$H/.config/termag/bazel-cache.status" ] || fail "a remove without a reason clears the last one" absent "$(cat "$H/.config/termag/bazel-cache.status")"
printf '{"reason":"x","seq":"bad","flushGeneration":-3}' | runbz remove bazel-cache 2>/dev/null || fail 'a remove with bad fields still removes' 0 "$?"

# An rc with text of its own keeps it, byte for byte, through apply, a new URL and remove.
printf 'startup --output_user_root=/var/cache/bazel\n\nbuild --announce_rc\n' > "$BRC"; cp "$BRC" "$WORK/brc.own"
bz 120 | runbz apply bazel-cache 2>/dev/null
[ "$(cat "$BRC")" = "$(cat "$WORK/brc.own"; bzblock "$U1" toplevel 5 1 200)" ] || fail "apply appends the block after the rc's own text" 'own text + block' "$(cat "$BRC")"
bz 121 '.url = "'"$U2"'"' | runbz apply bazel-cache 2>/dev/null
[ "$(grep -c 'termag bazel-cache >>>' "$BRC")" = 1 ] && grep -qxF "build --remote_cache=$U2" "$BRC" || fail 'a new generation replaces the block' 'one block, new url' "$(cat "$BRC")"
printf '{"seq":122}' | runbz remove bazel-cache 2>/dev/null
cmp -s "$BRC" "$WORK/brc.own" || fail 'remove leaves exactly the text that was there' "$(cat "$WORK/brc.own")" "$(cat "$BRC")"
# Devin on #1202: an rc whose last line has no newline keeps the marker on a line of its own.
printf 'startup --output_user_root=/var/cache/bazel' > "$BRC"
bz 122 | runbz apply bazel-cache 2>/dev/null
[ "$(head -2 "$BRC")" = "$(printf 'startup --output_user_root=/var/cache/bazel\n# >>> termag bazel-cache >>>')" ] \
  || fail 'an rc without a final newline: the block starts on its own line' 'own line, then the marker' "$(head -2 "$BRC")"
printf '{"seq":122}' | runbz remove bazel-cache 2>/dev/null
[ "$(cat "$BRC")" = 'startup --output_user_root=/var/cache/bazel' ] && ! grep -q 'termag bazel-cache' "$BRC" \
  || fail 'and remove takes the block out again' 'the one startup line' "$(cat "$BRC")"
cp "$WORK/brc.own" "$BRC"
# A sudo that fails: apply fails and leaves the rc as it was.
cat > "$STUB/bz-sudo-fail" <<'STUBEOF'
#!/bin/sh
exit 1
STUBEOF
chmod 755 "$STUB/bz-sudo-fail"
bz 123 | runbz_with "$STUB/bz-sudo-fail" apply bazel-cache 2>/dev/null && fail 'apply fails when sudo does' non-zero 0
cmp -s "$BRC" "$WORK/brc.own" && [ ! -e "$BZS" ] || fail 'a failed write leaves the rc and records nothing' same changed

# The lock: two runs take turns, never writing the rc at once.
: > "$BZLOG"; echo 1 > "$WORK/bz-sudo.sleep"
bz 130 | runbz apply bazel-cache 2>/dev/null & a=$!
sleep 0.3
bz 131 '.url = "'"$U2"'"' | runbz apply bazel-cache 2>/dev/null & b=$!
wait "$a"; wait "$b"; : > "$WORK/bz-sudo.sleep"
awk '$1 == "start" { n++; if (n > max) max = n } $1 == "end" { n-- } END { exit !(max == 1) }' "$BZLOG" \
  || fail 'two concurrent runs serialize on the lock' 'one sudo at a time' "$(cat "$BZLOG")"
grep -qxF "build --remote_cache=$U2" "$BRC" && [ "$(cat "$H/.config/termag/bazel-cache.seq")" = 131 ] || fail 'the later step wins' "$U2, seq 131" "$(grep remote_cache "$BRC")"

# The flush: a higher flushGeneration, and only a higher one, on an apply or on a
# remove with no URL, deletes the disk cache and every output base, after
# stopping each base's server.
OUR="$H/.cache/bazel/_bazel_$(id -un)"; OB="$OUR/0123456789abcdef0123456789abcdef"
mkbazel() {
  mkdir -p "$H/.cache/bazel-disk/ac" "$OB/execroot/_main/bazel-out" "$OB/server" "$OUR/install/abc" "$OUR/cache/repos" "$H/.cache/bazel-repo-contents"
  echo x > "$H/.cache/bazel-disk/ac/k"; echo x > "$OB/execroot/_main/bazel-out/o"; chmod 555 "$OB/execroot/_main/bazel-out"
}
flushed() { [ ! -e "$H/.cache/bazel-disk" ] && [ ! -e "$OB" ]; }
kept() { [ -e "$H/.cache/bazel-disk/ac/k" ] && [ -e "$OB/execroot/_main/bazel-out/o" ]; }
mkbazel
cat "$H/.config/termag/bazel-cache.flush-generation" >/dev/null 2>&1 || fail 'the first step recorded its generation' 0 none
bz 140 | runbz apply bazel-cache 2>/dev/null
kept || fail 'an equal generation flushes nothing' kept deleted
bash -c 'exec -a "bazel(_main) --output_base=$1 --workspace_directory=/w" sleep 300' _ "$OB" & srv=$!
bash -c 'exec -a unrelated sleep 300' & other=$!
sleep 0.2; echo "$srv" > "$OB/server/server.pid.txt"
bz 141 '.flushGeneration = 2' | runbz apply bazel-cache 2>/dev/null || fail 'a flushing apply succeeds' 0 "$?"
flushed || fail 'a higher generation on an apply deletes the disk cache and the output bases' deleted kept
[ -d "$OUR/install/abc" ] && [ -d "$OUR/cache/repos" ] && [ -d "$H/.cache/bazel-repo-contents" ] || fail 'the install base and the repository caches stay' kept deleted
sleep 0.3
if kill -0 "$srv" 2>/dev/null; then fail "the output base's server is stopped" stopped running; fi
wait "$srv" 2>/dev/null
kill -0 "$other" 2>/dev/null || fail 'a process that is not the base server is left alone' running stopped
kill "$other" 2>/dev/null; wait "$other" 2>/dev/null
[ "$(cat "$H/.config/termag/bazel-cache.flush-generation")" = 2 ] && grep -qF 'termag bazel-cache >>>' "$BRC" || fail 'the generation is recorded, and the block written after the flush' '2, block' "$(cat "$H/.config/termag/bazel-cache.flush-generation")"
mkbazel
bz 142 '.flushGeneration = 2' | runbz apply bazel-cache 2>/dev/null
bz 143 '.flushGeneration = 1' | runbz apply bazel-cache 2>/dev/null
kept || fail 'the same or a lower generation flushes nothing' kept deleted
[ "$(cat "$H/.config/termag/bazel-cache.flush-generation")" = 2 ] || fail 'a lower generation never lowers the recorded one' 2 "$(cat "$H/.config/termag/bazel-cache.flush-generation")"
# A remove: off now, and a flush raised while off reaches the box, which applied
# the block before.
BZUSED="$H/.config/termag/bazel-cache.used"; BZFLUSH="$H/.config/termag/bazel-cache.flush-generation"
[ -e "$BZUSED" ] || fail 'an apply marks the box as having used the cache' present absent
printf '{"reason":"off","seq":150,"flushGeneration":2}' | runbz remove bazel-cache 2>/dev/null
kept || fail 'a remove at the same generation flushes nothing' kept deleted
printf '{"reason":"off","seq":151,"flushGeneration":3}' | runbz remove bazel-cache 2>/dev/null
flushed || fail 'a remove with a higher generation flushes a box that used the cache' deleted kept
[ "$(cat "$BZFLUSH")" = 3 ] || fail 'the remove records the generation' 3 "$(cat "$BZFLUSH")"
[ ! -e "$BZUSED" ] || fail "after a remove's flush nothing from the cache is left, so the box no longer counts as used" absent present
mkbazel
printf '{"reason":"off","seq":152,"flushGeneration":4}' | runbz remove bazel-cache 2>/dev/null
kept || fail 'a box flushed since its block went off is not flushed again' kept deleted
mkbazel
printf '{"reason":"off","seq":140,"flushGeneration":9}' | runbz remove bazel-cache 2>/dev/null
kept || fail 'a stale remove flushes nothing either' kept deleted
# Review on #1202: a box that never applied the block (every flag-off box gets a
# remove at each connect) keeps its servers, output bases and baked disk cache
# when someone raises flushGeneration, and its removes leave no record.
rm -f "$BZFLUSH" "$BZUSED"; mkbazel
printf '{"reason":"off","seq":153,"flushGeneration":0}' | runbz remove bazel-cache 2>/dev/null
[ ! -e "$BZFLUSH" ] || fail "a remove on a box that never used the cache records no generation" absent "$(cat "$BZFLUSH")"
printf '{"reason":"off","seq":154,"flushGeneration":6}' | runbz remove bazel-cache 2>/dev/null
kept || fail 'a raised generation flushes nothing on a box that never used the cache' kept deleted
[ ! -e "$BZFLUSH" ] && [ ! -e "$BZUSED" ] || fail 'and leaves no record or mark' 'none' "$(cd "$H/.config/termag" && echo bazel-cache*)"
# Devin on #1202: an --output_user_root named in the system rc (outside the
# block) or ~/.bazelrc is flushed too; bases directly under it.
ALT="$WORK/alt-root"; ALT2="$H/alt2"; mkdir -p "$ALT/fedcba9876543210fedcba9876543210/execroot" "$ALT/install" "$ALT2/00112233445566778899aabbccddeeff"
cp "$BRC" "$WORK/brc.keep"; printf 'startup --output_user_root=%s\n' "$ALT" >> "$BRC"
printf 'startup --output_user_root=~/alt2\n' >> "$H/.bazelrc"
mkbazel
bz 155 '.flushGeneration = 6' | runbz apply bazel-cache 2>/dev/null
kept || fail "an apply on a box that hadn't used the cache only starts the record" kept deleted
printf '{"reason":"off","seq":156,"flushGeneration":7}' | runbz remove bazel-cache 2>/dev/null
[ ! -e "$ALT/fedcba9876543210fedcba9876543210" ] && [ ! -e "$ALT2/00112233445566778899aabbccddeeff" ] && [ -d "$ALT/install" ] && flushed \
  || fail 'the flush covers the output roots the rcs name' 'every base gone, install kept' "$(ls "$ALT" "$ALT2" 2>&1)"
cp "$WORK/brc.keep" "$BRC"; rm -f "$H/.bazelrc"; rm -rf "$ALT" "$ALT2"
# A first step ever, whatever its generation, has nothing to flush.
rm -f "$H/.config/termag/bazel-cache.flush-generation"; mkbazel
bz 160 '.flushGeneration = 7' | runbz apply bazel-cache 2>/dev/null
kept || fail 'a first step flushes nothing' kept deleted
printf '{"seq":161}' | runbz remove bazel-cache 2>/dev/null
chmod -R u+w "$OB"; rm -rf "$H/.cache"

# status: off with the reason, a .netrc that would send credentials, and S3's answer through a curl stub.
printf '{"reason":"off","seq":162}' | runbz remove bazel-cache 2>/dev/null
got=$(runbz status | grep '^bazel-cache')
[ "$got" = 'bazel-cache: off: off' ] || fail "status says off, with the remove's reason" 'bazel-cache: off: off' "$got"
bz 170 | runbz apply bazel-cache 2>/dev/null
cat > "$STUB/curl" <<STUBEOF
#!/bin/sh
printf '%s\n' "\$*" >> "$WORK/bzcurl.argv"
printf '%s' "\$(cat "$WORK/bzcurl.mode")"
STUBEOF
chmod 755 "$STUB/curl"
for m in '404 on, Bazel reads the shared cache at '"$U1" '200 on, Bazel reads the shared cache at '"$U1" \
         '403 NOT WORKING: S3 refuses this box' '000 NOT WORKING: the cache at '"$U1"' is unreachable' '503 NOT WORKING: the cache at '"$U1"' answered HTTP 503'; do
  echo "${m%% *}" > "$WORK/bzcurl.mode"
  got=$(runbz status | grep '^bazel-cache')
  case $got in "bazel-cache: ${m#* }"*) ;; *) fail "status for HTTP ${m%% *}" "bazel-cache: ${m#* }..." "$got" ;; esac
done
# S3's 404 for a bucket that isn't there is no working miss.
cat > "$STUB/curl" <<STUBEOF
#!/bin/sh
printf '%s\n' "\$*" >> "$WORK/bzcurl.argv"
out=; while [ \$# -gt 0 ]; do [ "\$1" = -o ] && out=\$2; shift; done
[ -z "\$out" ] || printf '<?xml version="1.0"?><Error><Code>NoSuchBucket</Code></Error>' > "\$out"
printf 404
STUBEOF
got=$(runbz status | grep '^bazel-cache')
case $got in "bazel-cache: NOT WORKING: the bucket in $U1 does not exist"*) ;; *) fail 'status tells a missing bucket from a miss' 'NOT WORKING: the bucket ... does not exist' "$got" ;; esac
cat > "$STUB/curl" <<STUBEOF
#!/bin/sh
printf '%s\n' "\$*" >> "$WORK/bzcurl.argv"
printf '%s' "\$(cat "$WORK/bzcurl.mode")"
STUBEOF
grep -qF "$U1/ac/$(printf '%064d' 0)" "$WORK/bzcurl.argv" || fail 'the probe asks for an unknown action key' '/ac/000…' "$(cat "$WORK/bzcurl.argv")"
if grep -q -- '-K\|--netrc\|-u ' "$WORK/bzcurl.argv"; then fail 'the probe sends no credential' 'anonymous' "$(cat "$WORK/bzcurl.argv")"; fi
echo 404 > "$WORK/bzcurl.mode"
B1=termag-bazel-cache-123456789012-us-east-2-an.s3.us-east-2.amazonaws.com
for netrc in "machine $B1 login a password b" "machine other.example login a password b
default login x password y" "machine
$B1
login a"; do
  printf '%s\n' "$netrc" > "$H/.netrc"
  got=$(runbz status | grep '^bazel-cache')
  case $got in "bazel-cache: NOT WORKING: $H/.netrc has an entry for $B1"*) ;; *) fail "status reports a .netrc that would send credentials ($netrc)" 'NOT WORKING: .netrc' "$got" ;; esac
done
printf 'machine other.example login a password b\n' > "$H/.netrc"
case $(runbz status | grep '^bazel-cache') in 'bazel-cache: on,'*) ;; *) fail 'a .netrc for other hosts is fine' on "$(runbz status | grep '^bazel-cache')" ;; esac
printf 'machine %s login a password b\n' "$B1" > "$WORK/other-netrc"
case $(NETRC="$WORK/other-netrc" runbz status | grep '^bazel-cache') in *"NOT WORKING: $WORK/other-netrc"*) ;; *) fail '$NETRC is the file Bazel reads' "$WORK/other-netrc" other ;; esac
rm -f "$H/.netrc" "$STUB/curl"
cp "$BRC" "$BRC.x"
printf 'other\n' > "$BRC"
got=$(runbz status | grep '^bazel-cache')
[ "$got" = "bazel-cache: NOT WORKING: delivered, but $BRC has no termag block" ] || fail 'status says when the block is gone' 'NOT WORKING: no termag block' "$got"
mv "$BRC.x" "$BRC"

# skip: a delivery doesn't bring the block back, but a flush still happens; unskip undoes it.
runbz skip bazel-cache 2>/dev/null
cmp -s "$BRC" "$WORK/brc.own" || fail 'skip removes the block' "$(cat "$WORK/brc.own")" "$(cat "$BRC")"
mkbazel
bz 180 '.flushGeneration = 8' | runbz apply bazel-cache 2>/dev/null
cmp -s "$BRC" "$WORK/brc.own" && [ ! -e "$BZS" ] || fail 'a skipped box keeps the block out' 'no block' "$(cat "$BRC" 2>&1)"
flushed || fail 'a skipped box still flushes on a higher generation' deleted kept
[ "$(runbz status | grep '^bazel-cache')" = 'bazel-cache: skipped on this box' ] || fail 'status says skipped' skipped "$(runbz status | grep '^bazel-cache')"
runbz unskip bazel-cache 2>/dev/null
bz 181 '.flushGeneration = 8' | runbz apply bazel-cache 2>/dev/null
grep -qF 'termag bazel-cache >>>' "$BRC" || fail 'unskip lets the next delivery write the block' present absent
printf '{"seq":182}' | runbz remove bazel-cache 2>/dev/null
cmp -s "$BRC" "$WORK/brc.own" || fail 'the last remove restores the rc' same changed

# Review on #1202: a flush that fails never keeps the block. One output base
# that can't be deleted (an rm stub refuses it) doesn't stop the disk cache or
# the other bases going; the remove still takes the block out; status says the
# flush failed; the record stays, so the next step tries again; and a failed
# flush on an apply takes the block out too.
OB2="$OUR/fedcba9876543210fedcba9876543210"
bz 190 '.flushGeneration = 8' | runbz apply bazel-cache 2>/dev/null
mkbazel; mkdir -p "$OB2/execroot"; echo x > "$OB2/execroot/o"
cat > "$STUB/rm" <<STUBEOF
#!/bin/sh
for a in "\$@"; do [ "\$a" = "$OB" ] && { echo "rm: cannot remove '\$a': Device or resource busy" >&2; exit 1; }; done
exec /bin/rm "\$@"
STUBEOF
chmod 755 "$STUB/rm"
printf '{"reason":"off","seq":191,"flushGeneration":9}' | runbz remove bazel-cache 2>/dev/null && fail 'a remove whose flush fails says so' non-zero 0
! grep -qF 'termag bazel-cache >>>' "$BRC" || fail 'a remove takes the block out even when its flush fails' 'no block' "$(cat "$BRC")"
[ ! -e "$H/.cache/bazel-disk" ] && [ ! -e "$OB2" ] && [ -e "$OB" ] || fail 'the flush deletes the disk cache and every base it can, past one it cannot' 'disk cache and OB2 gone, OB left' "$(ls "$OUR" "$H/.cache" 2>&1)"
[ "$(cat "$BZFLUSH")" = 8 ] || fail 'a failed flush leaves the record, so the next step tries again' 8 "$(cat "$BZFLUSH")"
got=$(runbz status | grep '^bazel-cache')
case $got in "bazel-cache: NOT WORKING: the last flush failed (generation 9: $OB"*) ;; *) fail 'status says the flush failed, and what is left' 'NOT WORKING: the last flush failed (generation 9: ...)' "$got" ;; esac
# Bugbot on #1202: the failed remove's seq is recorded all the same, so an older
# apply still in flight can't put the block back after the kill switch.
out=$(bz 190 '.flushGeneration = 8' | runbz apply bazel-cache 2>&1)
! grep -qF 'termag bazel-cache >>>' "$BRC" || fail "an older apply can't land after a remove whose flush failed" 'no block' "$(cat "$BRC")"
case $out in *'refused a step older than the last one applied (seq 190 < 191)'*) ;; *) fail 'it is refused as older' 'refused ... (seq 190 < 191)' "$out" ;; esac
rm -f "$STUB/rm"
printf '{"reason":"off","seq":192,"flushGeneration":9}' | runbz remove bazel-cache 2>/dev/null || fail 'the next remove retries the flush' 0 "$?"
[ ! -e "$OB" ] && [ "$(cat "$BZFLUSH")" = 9 ] && [ ! -e "$H/.config/termag/bazel-cache.flush-failed" ] || fail 'a flush that succeeds on retry clears the failure' 'OB gone, record 9' "$(cat "$BZFLUSH")"
[ "$(runbz status | grep '^bazel-cache')" = 'bazel-cache: off: off' ] || fail 'status is back to off' 'bazel-cache: off: off' "$(runbz status | grep '^bazel-cache')"
bz 193 '.flushGeneration = 9' | runbz apply bazel-cache 2>/dev/null
mkbazel
cat > "$STUB/rm" <<STUBEOF
#!/bin/sh
for a in "\$@"; do [ "\$a" = "$OB" ] && exit 1; done
exec /bin/rm "\$@"
STUBEOF
chmod 755 "$STUB/rm"
bz 194 '.flushGeneration = 10' | runbz apply bazel-cache 2>/dev/null && fail 'an apply whose flush fails says so' non-zero 0
! grep -qF 'termag bazel-cache >>>' "$BRC" && [ ! -e "$BZS" ] || fail 'a failed flush on an apply takes the block out' 'no block' "$(cat "$BRC")"
case $(runbz status | grep '^bazel-cache') in 'bazel-cache: NOT WORKING: the last flush failed'*) ;; *) fail 'status says so after an apply too' 'NOT WORKING: the last flush failed' "$(runbz status | grep '^bazel-cache')" ;; esac
rm -f "$STUB/rm"
bz 195 '.flushGeneration = 10' | runbz apply bazel-cache 2>/dev/null || fail 'the next apply retries the flush, and succeeds' 0 "$?"
grep -qF 'termag bazel-cache >>>' "$BRC" && [ ! -e "$OB" ] || fail 'then the block is back' 'block, OB gone' "$(cat "$BRC")"
printf '{"seq":196}' | runbz remove bazel-cache 2>/dev/null
cmp -s "$BRC" "$WORK/brc.own" || fail 'the last remove restores the rc' same changed
# Devin on #1202: a box whose block is in place but has no mark (an older
# install) is still flushed by a raised remove, which takes the block out first.
bz 197 '.flushGeneration = 10' | runbz apply bazel-cache 2>/dev/null
mkbazel; rm -f "$BZUSED"
printf '{"reason":"off","seq":198,"flushGeneration":11}' | runbz remove bazel-cache 2>/dev/null || fail 'that remove succeeds' 0 "$?"
flushed && ! grep -qF 'termag bazel-cache >>>' "$BRC" || fail 'a block with no mark still counts as used: the remove flushes' 'flushed, block out' "$(cd "$OUR" && echo ./*)"
[ "$(cat "$BZFLUSH")" = 11 ] || fail 'and records the generation' 11 "$(cat "$BZFLUSH")"
# Devin on #1202: the record is a high-water mark. A re-enable with a lower
# generation (a variation reset) doesn't lower it, so restoring the higher one
# flushes nothing.
bz 199 '.flushGeneration = 10' | runbz apply bazel-cache 2>/dev/null
[ "$(cat "$BZFLUSH")" = 11 ] || fail "an apply never lowers the record" 11 "$(cat "$BZFLUSH")"
mkbazel
bz 200 '.flushGeneration = 11' | runbz apply bazel-cache 2>/dev/null
kept || fail 'restoring the recorded generation flushes nothing' kept deleted
printf '{"seq":201}' | runbz remove bazel-cache 2>/dev/null
cmp -s "$BRC" "$WORK/brc.own" || fail 'the last remove restores the rc' same changed
# Bugbot on #1202: a flush doesn't hold the step lock, so a remove (the kill
# switch) never waits behind one, even with a short lock wait. The apply that
# was flushing then finds a newer step and leaves the block out.
mkbazel
cat > "$STUB/rm" <<STUBEOF
#!/bin/sh
for a in "\$@"; do [ "\$a" = "$OB" ] && sleep 6; done
exec /bin/rm "\$@"
STUBEOF
chmod 755 "$STUB/rm"
bz 202 '.flushGeneration = 12' | runbz apply bazel-cache >/dev/null 2>&1 & slow=$!
sleep 1.5
export TERMAG_BAZEL_CACHE_LOCK_WAIT=2
t0=$(date +%s)
printf '{"reason":"off","seq":203}' | runbz remove bazel-cache 2>/dev/null || fail 'a remove during a flush succeeds' 0 "$?"
t1=$(date +%s)
unset TERMAG_BAZEL_CACHE_LOCK_WAIT
[ $((t1 - t0)) -lt 5 ] || fail "a remove doesn't wait behind a flush" '< 5 s' "$((t1 - t0)) s"
! grep -qF 'termag bazel-cache >>>' "$BRC" || fail 'and takes the block out' 'no block' "$(cat "$BRC")"
wait "$slow"
! grep -qF 'termag bazel-cache >>>' "$BRC" && [ "$(cat "$H/.config/termag/bazel-cache.seq")" = 203 ] \
  || fail 'the apply that was flushing finds a newer step and leaves the block out' 'no block, seq 203' "$(cat "$H/.config/termag/bazel-cache.seq")"
[ "$(cat "$BZFLUSH")" = 12 ] && [ ! -e "$OB" ] || fail 'its flush still completes and is recorded' 12 "$(cat "$BZFLUSH")"
# Devin on #1202: the same for a remove with no seq (the orchestrator's refusal
# to an unmanaged box). It doesn't move the seq, so the step counter is what
# tells the flushing apply that a step ran meanwhile.
rm -f "$STUB/rm"
bz 204 '.flushGeneration = 12' | runbz apply bazel-cache 2>/dev/null
mkbazel
cat > "$STUB/rm" <<STUBEOF
#!/bin/sh
for a in "\$@"; do [ "\$a" = "$OB" ] && sleep 6; done
exec /bin/rm "\$@"
STUBEOF
chmod 755 "$STUB/rm"
bz 205 '.flushGeneration = 13' | runbz apply bazel-cache >/dev/null 2>&1 & slow=$!
sleep 1.5
printf '{"reason":"not managed"}' | runbz remove bazel-cache 2>/dev/null || fail 'an unsequenced remove during a flush succeeds' 0 "$?"
! grep -qF 'termag bazel-cache >>>' "$BRC" || fail 'and takes the block out' 'no block' "$(cat "$BRC")"
wait "$slow"
! grep -qF 'termag bazel-cache >>>' "$BRC" || fail 'the flushing apply leaves the block out after an unsequenced remove' 'no block' "$(cat "$BRC")"
[ "$(cat "$BZFLUSH")" = 13 ] || fail 'and its flush is still recorded' 13 "$(cat "$BZFLUSH")"
rm -f "$STUB/rm"
cmp -s "$BRC" "$WORK/brc.own" || fail 'the rc is as it was' same changed
chmod -R u+w "$OUR" 2>/dev/null; rm -rf "$H/.cache"

run apply codex </dev/null >/dev/null 2>&1; got=$?
[ "$got" = 2 ] || fail 'unknown providers exit 2' 2 "$got"

if [ "$failures" -eq 0 ]; then
  echo 'PASS: termag-credentials claude-gateway apply/skip/remove + github broker apply/remove + telemetry apply/remove/launch + agent-telemetry apply/remove/cursor hooks + mcp apply/remove/plugin dirs + mcp for the other agents + fireworks apply/skip/remove/status/launch-settings/pi-model + bazel-cache apply/remove/seq/lock/flush/skip/status/netrc + legacy cleanup'
  exit 0
fi
echo "$failures failure(s)"
exit 1
