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
run() {
  HOME="$H" PATH="$STUB:$PATH" TERMAG_CLAUDE_MANAGED_SETTINGS="$MANAGED" TERMAG_CREDENTIALS_SUDO='' \
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

run apply codex </dev/null >/dev/null 2>&1; got=$?
[ "$got" = 2 ] || fail 'unknown providers exit 2' 2 "$got"

if [ "$failures" -eq 0 ]; then
  echo 'PASS: termag-credentials claude-gateway apply/skip/remove + github broker apply/remove + legacy cleanup'
  exit 0
fi
echo "$failures failure(s)"
exit 1
