#!/bin/sh
# Tests deploy/termag-subagent-setup, which prepares a box for ask runs
# with a stub sudo and useradd:
#
#   * a fresh box gets the user (useradd --system, nologin, no home created),
#     the root and bin/ dirs, threads/ owned by the box user, the exec script,
#     the token helper (reads $CREDENTIALS_DIRECTORY/token) and a copy of
#     claude keyed by its real path
#   * a second run changes nothing; a new claude version is copied again; an
#     edited exec script is put back
#   * --check reports what is missing and changes nothing: exit 1 for what
#     setup fixes, 3 for what it can't (no claude), 0 when nothing is
#
# Run: sh deploy/termag-subagent-setup.test.sh
set -u

DIR="$(cd "$(dirname "$0")" && pwd)"
SCRIPT="$DIR/termag-subagent-setup"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

failures=0
fail() {
  echo "FAIL: $1"
  echo "      want: $2"
  echo "      got:  $3"
  failures=$((failures + 1))
}
eq() { [ "$2" = "$3" ] || fail "$1" "$3" "$2"; }
has() { case "$2" in *"$3"*) : ;; *) fail "$1" "$3" "$2" ;; esac; }

STUB="$WORK/stub"
LOG="$WORK/calls"
mkdir -p "$STUB" "$WORK/home/.local/bin" "$WORK/home/.local/share/claude/versions" "$WORK/lib"
export LOG HOME="$WORK/home"
cat > "$STUB/sudo" <<'EOF'
#!/bin/sh
[ "${1:-}" = -n ] && shift
echo "sudo $*" >> "$LOG"
exec "$@"
EOF
cat > "$STUB/useradd" <<'EOF'
#!/bin/sh
echo "useradd $*" >> "$LOG"
EOF
cat > "$STUB/systemd-run" <<'EOF'
#!/bin/sh
EOF
chmod +x "$STUB"/*
export PATH="$STUB:$PATH"

ROOT="$WORK/root"
printf '#!/bin/sh\necho v1\n' > "$HOME/.local/share/claude/versions/1.0.0"
chmod +x "$HOME/.local/share/claude/versions/1.0.0"
ln -s "$HOME/.local/share/claude/versions/1.0.0" "$HOME/.local/bin/claude"
printf '#!/bin/sh\necho exec\n' > "$WORK/lib/termag-subagent-exec"

ME=$(id -un)
export TERMAG_SUBAGENT_ROOT="$ROOT" TERMAG_SUBAGENT_OWNER="$ME" TERMAG_SUBAGENT_EXEC_SRC="$WORK/lib/termag-subagent-exec"
export TERMAG_SUBAGENT_USER=termag-subagent-test-nobody

out=$("$SCRIPT" --check 2>&1); rc=$?
eq 'check on a fresh box exits 1' "$rc" 1
has 'and names the user' "$out" 'MISSING: user termag-subagent-test-nobody'
[ -e "$ROOT" ] && fail 'check changes nothing' absent present

: > "$LOG"
out=$("$SCRIPT" 2>&1); rc=$?
eq 'apply exits 0' "$rc" 0
has 'creates the user' "$(cat "$LOG")" 'useradd --system --user-group --home-dir '"$ROOT"'/home --no-create-home --shell /usr/sbin/nologin'
eq 'threads owned by the box user' "$(stat -c '%U %a' "$ROOT/threads")" "$ME 755"
eq 'bin mode' "$(stat -c '%a' "$ROOT/bin")" 755
cmp -s "$ROOT/bin/termag-subagent-exec" "$WORK/lib/termag-subagent-exec" || fail 'exec script installed' same differs
has 'token helper reads the credential' "$(cat "$ROOT/bin/termag-subagent-token")" 'cat "$CREDENTIALS_DIRECTORY/token"'
eq 'claude copied' "$("$ROOT/bin/claude")" v1
eq 'claude keyed by its real path' "$(cat "$ROOT/bin/claude.src")" "$HOME/.local/share/claude/versions/1.0.0"

# The stub useradd made no user, so --check still wants one; pretend it exists.
export TERMAG_SUBAGENT_USER="$ME"
: > "$LOG"
out=$("$SCRIPT" 2>&1)
eq 'a second run changes nothing' "$(cat "$LOG")" ''
"$SCRIPT" --check >/dev/null 2>&1; eq 'check passes on a prepared box' "$?" 0

printf '#!/bin/sh\necho v2\n' > "$HOME/.local/share/claude/versions/2.0.0"
chmod +x "$HOME/.local/share/claude/versions/2.0.0"
ln -sfn "$HOME/.local/share/claude/versions/2.0.0" "$HOME/.local/bin/claude"
echo tampered >> "$ROOT/bin/termag-subagent-exec"
out=$("$SCRIPT" 2>&1)
eq 'a new claude version is copied' "$("$ROOT/bin/claude")" v2
cmp -s "$ROOT/bin/termag-subagent-exec" "$WORK/lib/termag-subagent-exec" || fail 'an edited exec script is put back' same differs

rm "$HOME/.local/bin/claude"
out=$("$SCRIPT" --check 2>&1); rc=$?
eq 'no claude is a check setup cannot fix' "$rc" 3
has 'and says so' "$out" 'install Claude Code'

if [ "$failures" -eq 0 ]; then
  echo 'PASS: user, dirs, exec script, token helper, claude copy, idempotence, --check'
  exit 0
fi
echo "$failures failure(s)"
exit 1
