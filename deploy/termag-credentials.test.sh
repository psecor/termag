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
printf '{"reason":"MCP connectors through termag are not enabled for you"}' | run remove mcp 2>/dev/null
got="$(jq -c '[(.mcpServers | keys), .numStartups]' "$CJ")"
[ "$got" = '[["jira","linear","metaterm"],3]' ] || fail "remove mcp takes out only termag's entries" '[["jira","linear","metaterm"],3]' "$got"
[ ! -e "$MSTATE" ] || fail 'remove mcp deletes its record' 'absent' 'present'
[ "$(cat "$MVER")" != "$v2" ] || fail 'remove mcp bumps the version' 'a new version' "$v2"
got="$(run status | grep '^mcp')"
[ "$got" = 'mcp: off: MCP connectors through termag are not enabled for you' ] || fail "mcp status repeats the orchestrator's reason" 'mcp: off: …' "$got"
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

# launch-settings: the one --settings a Claude Code launch on the backend gets, with the launch's model.
got="$(runfw launch-settings --backend fireworks --model "$KIMI" --fast "$DS" --context 512000 - 2>/dev/null \
  | jq -c '.env | [.ANTHROPIC_BASE_URL, .ANTHROPIC_MODEL, .ANTHROPIC_DEFAULT_SONNET_MODEL, .ANTHROPIC_SMALL_FAST_MODEL, .ANTHROPIC_DEFAULT_HAIKU_MODEL, .CLAUDE_CODE_MAX_CONTEXT_TOKENS]')"
[ "$got" = "[\"https://gw.example/fireworks/inference\",\"$KIMI\",\"$KIMI\",\"$DS\",\"$DS\",\"512000\"]" ] \
  || fail "launch-settings puts the launch's model on every tier, the fast one on haiku, and the window" 'kimi tiers, ds fast, 512000' "$got"
got="$(runfw launch-settings --backend fireworks --model "$KIMI" - 2>/dev/null | jq -c '.env | [.ANTHROPIC_SMALL_FAST_MODEL, .CLAUDE_CODE_MAX_CONTEXT_TOKENS]')"
[ "$got" = "[\"$KIMI\",null]" ] || fail 'without --fast the model is the fast one too, and without --context there is no window' "[kimi,null]" "$got"
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
printf '{"reason":"Fireworks through termag is not enabled for you (feature flag fireworks-enabled)"}' | runfw remove fireworks 2>/dev/null
got="$(runfw status | grep '^fireworks')"
[ "$got" = 'fireworks: off: Fireworks through termag is not enabled for you (feature flag fireworks-enabled)' ] \
  || fail "fireworks status repeats the orchestrator's reason" 'fireworks: off: ...' "$got"
out="$(runfw launch-settings --backend fireworks --model "$KIMI" - 2>&1)"; code=$?
[ "$code" != 0 ] || fail 'launch-settings fails where Fireworks was removed' non-zero "$code"
case "$out" in *'not set up on this box: Fireworks through termag is not enabled for you'*) : ;;
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
    r.writeHead(403, { "content-type": "application/json" }).end(JSON.stringify({ message: "Fireworks through termag is not enabled for you" }));
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
[ "$got" = "fireworks: NOT WORKING: the gateway at $FWGW refused this box (HTTP 403): Fireworks through termag is not enabled for you" ] \
  || fail "fireworks status repeats the gateway's refusal" 'NOT WORKING ... refused (HTTP 403): ...' "$got"
printf '{"termag_url":"wss://b","token":"%s"}\n' "$BOX_TOKEN" > "$CONFIG"
kill "$fw_pid"; wait "$fw_pid" 2>/dev/null
runfw remove fireworks </dev/null 2>/dev/null

run apply codex </dev/null >/dev/null 2>&1; got=$?
[ "$got" = 2 ] || fail 'unknown providers exit 2' 2 "$got"

if [ "$failures" -eq 0 ]; then
  echo 'PASS: termag-credentials claude-gateway apply/skip/remove + github broker apply/remove + telemetry apply/remove/launch + agent-telemetry apply/remove/cursor hooks + mcp apply/remove/plugin dirs + fireworks apply/skip/remove/status/launch-settings/pi-model + legacy cleanup'
  exit 0
fi
echo "$failures failure(s)"
exit 1
