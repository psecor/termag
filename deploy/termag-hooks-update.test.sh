#!/bin/sh
# Tests deploy/termag-hooks-update: merges the canonical termag hook lines into
# an existing ~/.claude/settings.json without disturbing the owner's own hooks.
#
# Run: sh deploy/termag-hooks-update.test.sh
set -u

HERE="$(cd "$(dirname "$0")" && pwd)"
SCRIPT="$HERE/termag-hooks-update"
CANON="$HERE/claude-settings.json"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

failures=0
fail() { echo "FAIL: $1"; echo "      $2"; failures=$((failures + 1)); }

run() { TERMAG_CLAUDE_SETTINGS="$WORK/settings.json" TERMAG_CANONICAL_HOOKS="$CANON" HOME="$WORK" "$SCRIPT" "$@"; }

# 1. Missing file: --check says so (exit 1), apply installs the canonical file.
rm -f "$WORK/settings.json"
run --check >/dev/null 2>&1 && fail 'check on missing file should exit 1' 'exit 0'
run >/dev/null || fail 'install on missing file' 'non-zero exit'
[ "$(jq -S . "$WORK/settings.json")" = "$(jq -S . "$CANON")" ] || fail 'installed file equals canonical' 'differs'

# 2. Current file: idempotent, no backup written.
run >/dev/null || fail 'apply on current file' 'non-zero exit'
run --check >/dev/null || fail 'check on current file should exit 0' 'non-zero'
[ -z "$(ls "$WORK"/settings.json.bak.* 2>/dev/null)" ] || fail 'no backup when nothing changed' 'backup present'

# 3. Old termag hook line + an owner's own hook: termag line replaced, owner's kept, backup made.
cat > "$WORK/settings.json" <<'EOF'
{
  "model": "opus",
  "hooks": {
    "PostToolUse": [
      { "matcher": ".*", "hooks": [ { "type": "command", "command": "\"$HOME/.local/bin/termag-status\" working >/dev/null 2>&1 &" } ] },
      { "matcher": "Edit", "hooks": [ { "type": "command", "command": "prettier --write \"$FILE\"" } ] }
    ],
    "Stop": [
      { "hooks": [ { "type": "command", "command": "\"$HOME/.local/bin/termag-status\" idle >/dev/null 2>&1 &" } ] }
    ],
    "SessionStart": [
      { "hooks": [ { "type": "command", "command": "echo hi" } ] }
    ]
  }
}
EOF
run --check >/dev/null 2>&1 && fail 'check on stale file should exit 1' 'exit 0'
run >/dev/null || fail 'apply on stale file' 'non-zero exit'
[ -n "$(ls "$WORK"/settings.json.bak.* 2>/dev/null)" ] || fail 'backup written on change' 'none'
jq -e '.model == "opus"' "$WORK/settings.json" >/dev/null || fail 'non-hook keys preserved' 'model missing'
jq -e '.hooks.SessionStart[0].hooks[0].command == "echo hi"' "$WORK/settings.json" >/dev/null || fail 'owner-only event preserved' 'SessionStart changed'
jq -e '[.hooks.PostToolUse[].hooks[].command] | any(test("prettier"))' "$WORK/settings.json" >/dev/null || fail 'owner hook within a termag event preserved' 'prettier gone'
jq -e '[.hooks.PostToolUse[].hooks[].command] | any(test("termag-status.* post-tool"))' "$WORK/settings.json" >/dev/null || fail 'PostToolUse now pipes into termag-status post-tool' 'not found'
jq -e '[.hooks.PostToolUse[].hooks[].command | select(test("termag-status"))] | length == 1' "$WORK/settings.json" >/dev/null || fail 'exactly one termag PostToolUse entry' 'duplicate or missing'
want=$(jq -c '.hooks | keys' "$CANON"); got=$(jq -c '.hooks | keys' "$WORK/settings.json")
[ "$want" = "$got" ] || fail 'all canonical events present' "want $want got $got"
jq -e '[.hooks.SessionStart[].hooks[].command] == ["echo hi", "\"$HOME/.local/bin/termag-status\" session-start >/dev/null 2>&1 || true", "[ \"$TERMAG_SPACE_MEMORY_MANAGED\" = 1 ] || { [ -x \"$HOME/.local/bin/termag\" ] && \"$HOME/.local/bin/termag\" space memory context --hook SessionStart --refresh 60s 2>/dev/null; } || true"]' "$WORK/settings.json" >/dev/null \
  || fail "SessionStart gains the PATH hook and the space-memory hook after the owner's" "$(jq -c '.hooks.SessionStart' "$WORK/settings.json")"
# The space-memory hooks ride in termag-status's own entries, so an update replaces them instead of adding another copy.
run >/dev/null || fail 'second apply' 'non-zero exit'
for ev in SessionStart UserPromptSubmit; do
  jq -e --arg ev "$ev" '[.hooks[$ev][].hooks[].command | select(test("termag\" space memory context --hook " + $ev))] | length == 1' "$WORK/settings.json" >/dev/null \
    || fail "exactly one space-memory $ev hook after two updates" "$(jq -c --arg ev "$ev" '.hooks[$ev]' "$WORK/settings.json")"
done

# The space-memory hooks stay quiet where the chat runner owns the session's memory: a headless
# turn, and a chat resumed in a pane (Open in full UI), both run with TERMAG_SPACE_MEMORY_MANAGED=1.
# The hook itself checks it, so the CLI isn't even started there (Security Agent, sweep 27).
FAKEHOME="$WORK/fakehome"
mkdir -p "$FAKEHOME/.local/bin"
printf '#!/bin/sh\necho "$*" >> "%s/called"\n' "$FAKEHOME" > "$FAKEHOME/.local/bin/termag"
chmod +x "$FAKEHOME/.local/bin/termag"
printf '#!/bin/sh\ncat >/dev/null\n' > "$FAKEHOME/.local/bin/termag-status"
chmod +x "$FAKEHOME/.local/bin/termag-status"
for ev in SessionStart UserPromptSubmit; do
  cmd=$(jq -r --arg ev "$ev" '[.hooks[$ev][].hooks[].command | select(test("space memory context"))][0]' "$CANON")
  rm -f "$FAKEHOME/called"
  echo '{}' | HOME="$FAKEHOME" TERMAG_SPACE_MEMORY_MANAGED=1 sh -c "$cmd" >/dev/null 2>&1
  [ ! -e "$FAKEHOME/called" ] || fail "$ev memory hook stays quiet under TERMAG_SPACE_MEMORY_MANAGED=1" "called: $(cat "$FAKEHOME/called")"
  echo '{}' | HOME="$FAKEHOME" sh -c "$cmd" >/dev/null 2>&1
  wait
  grep -q "space memory context --hook $ev" "$FAKEHOME/called" 2>/dev/null || fail "$ev memory hook runs in a plain pane" "not called"
done
run --check >/dev/null || fail 'check after apply should exit 0' 'non-zero'

# 4. Invalid JSON is left alone.
printf 'not json' > "$WORK/settings.json"
run >/dev/null 2>&1 && fail 'invalid json should fail' 'exit 0'
[ "$(cat "$WORK/settings.json")" = 'not json' ] || fail 'invalid json untouched' 'modified'

if [ "$failures" -eq 0 ]; then echo "PASS: termag-hooks-update"; exit 0; fi
echo "$failures failure(s)"; exit 1
