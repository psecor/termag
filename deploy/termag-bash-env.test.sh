#!/bin/sh
# Tests deploy/termag-bash-env and the wiring that makes Claude Code's Bash tool
# run bash on a box (gotcha agent-bash-tool-shell).
#
#   * the commands agents write that the box user's zsh fails, and bash runs:
#     an unquoted glob in a flag, `echo =====`, an unquoted $var that should split
#   * a non-interactive bash with BASH_ENV gets GH_HOST and TERMAG_BOX from the
#     profile.d files, silently, under -eu too, and its PATH is left alone
#   * GH_HOST stays unset when termag-credentials has removed its file (skip github)
#   * termag-agent.service sets CLAUDE_CODE_SHELL=/bin/bash and points BASH_ENV
#     at the path termag-reconcile installs this file to
#
# Run: sh deploy/termag-bash-env.test.sh
set -u

DIR="$(cd "$(dirname "$0")" && pwd)"
ENV_FILE="$DIR/termag-bash-env"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

failures=0
fail() {
  echo "FAIL: $1"
  echo "  expected: $2"
  echo "  got:      $3"
  failures=$((failures + 1))
}

# ── the pitfalls: zsh fails them, bash runs them ────────────────────────────
mkdir -p "$WORK/src" && printf 'needle\n' > "$WORK/src/a.ts"
cmd_glob="grep -rl --include=*.ts needle $WORK/src"
cmd_equals='echo ===== done'
cmd_split='flags="-a -b"; set -- $flags; echo $#'
got="$(bash -c "$cmd_glob" 2>&1)"
[ "$got" = "$WORK/src/a.ts" ] || fail 'bash: an unquoted glob in a flag reaches grep' "$WORK/src/a.ts" "$got"
got="$(bash -c "$cmd_equals" 2>&1)"
[ "$got" = '===== done' ] || fail 'bash: echo ===== prints it' '===== done' "$got"
got="$(bash -c "$cmd_split" 2>&1)"
[ "$got" = 2 ] || fail 'bash: an unquoted $var splits' 2 "$got"
if command -v zsh >/dev/null 2>&1; then
  # The "before": what the Bash tool printed while it ran zsh.
  got="$(cd "$WORK" && zsh -fc "$cmd_glob" 2>&1)"
  case "$got" in *'no matches found'*) : ;; *) fail 'zsh: the same glob is an error' 'no matches found' "$got" ;; esac
  got="$(zsh -fc "$cmd_equals" 2>&1)"
  case "$got" in *'= not found'*) : ;; *) fail 'zsh: echo ===== is a command lookup' '= not found' "$got" ;; esac
  got="$(zsh -fc "$cmd_split" 2>&1)"
  [ "$got" = 1 ] || fail 'zsh: an unquoted $var does not split' 1 "$got"
fi

# ── BASH_ENV gives bash what zshenv gave zsh ────────────────────────────────
PD="$WORK/profile.d"; H="$WORK/home"
mkdir -p "$PD" "$H/.local/bin"
printf 'export TERMAG_BOX=1\n' > "$PD/termag-box.sh"
printf 'export GH_HOST=broker.example\n' > "$PD/termag-github.sh"
probe='printf "%s|%s|%s" "${GH_HOST:-}" "${TERMAG_BOX:-}" "$PATH"'
# stdin from /dev/null and SHLVL=1, as under claude: bash whose stdin is a
# socket and whose SHLVL is unset takes itself for an rshd/sshd command, reads
# bash.bashrc and ~/.bashrc instead, and never reads BASH_ENV.
run() { env -i HOME="$H" PATH=/usr/bin:/bin SHLVL=1 TERMAG_PROFILE_D="$PD" BASH_ENV="$ENV_FILE" bash "$@" </dev/null; }

got="$(run -c "$probe" 2>&1)"
[ "$got" = "broker.example|1|/usr/bin:/bin" ] \
  || fail 'GH_HOST and TERMAG_BOX reach a non-interactive bash, PATH untouched' "broker.example|1|/usr/bin:/bin" "$got"

got="$(run -euc "$probe" 2>&1)"
[ "$got" = "broker.example|1|/usr/bin:/bin" ] || fail 'works under bash -eu' "broker.example|1|/usr/bin:/bin" "$got"

got="$(run -c "bash -c '$probe'" 2>&1)"
[ "$got" = "broker.example|1|/usr/bin:/bin" ] || fail 'a nested bash gets the same' "broker.example|1|/usr/bin:/bin" "$got"

rm "$PD/termag-github.sh" "$PD/termag-box.sh"
got="$(run -euc "$probe; echo; echo rc=\$?" 2>&1)"
[ "$got" = "||/usr/bin:/bin
rc=0" ] || fail 'github skipped: nothing set, nothing printed, no failure' '||/usr/bin:/bin rc=0' "$got"

# ── the unit wires it, to where reconcile installs it ───────────────────────
UNIT="$DIR/termag-agent.service"
grep -qxF 'Environment=CLAUDE_CODE_SHELL=/bin/bash' "$UNIT" || fail 'the agent unit sets CLAUDE_CODE_SHELL' 'Environment=CLAUDE_CODE_SHELL=/bin/bash' 'absent'
grep -qxF 'Environment=BASH_ENV=%h/.local/share/termag/bash-env' "$UNIT" || fail 'the agent unit sets BASH_ENV' 'Environment=BASH_ENV=%h/.local/share/termag/bash-env' 'absent'
# A classified row: core, so a box with termag setup off gets it too.
grep -qxF 'termag-bash-env:$HOME/.local/share/termag/bash-env:644:file:noenable:core' "$DIR/termag-reconcile" \
  || fail 'termag-reconcile installs the file BASH_ENV names, as a core row' 'termag-bash-env:$HOME/.local/share/termag/bash-env:644:file:noenable:core' 'absent'

if [ "$failures" -gt 0 ]; then
  echo "$failures failure(s)"
  exit 1
fi
echo 'PASS: zsh pitfalls vs bash, BASH_ENV contents (GH_HOST, TERMAG_BOX), -eu safety, github skipped, unit + reconcile wiring'
