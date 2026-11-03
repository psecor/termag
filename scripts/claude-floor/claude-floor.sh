#!/usr/bin/env bash
# claude-floor -- one-off (2026-10-29): put every Claude Code on this host at
# >= FLOOR (Anthropic's notice: CVE-2026-111943, CVE-2026-111497, 2.1.308 or
# later), and stop and resume every live session still on an older binary.
#
# Run as root on a box or the orchestrator host (SSM AWS-RunShellScript), or
# as a box user for that user alone. For each box user (the linger list, minus
# termag-guest), in parallel:
#   1. Update. The npm global under the user's nvm default where it is
#      installed (what the box image bakes), and a native install in
#      ~/.local/bin where there is one (termag-claude-runner prefers it). If
#      the claude a runner would start is still below FLOOR, stop here and
#      touch nothing: a restart would come back on the old binary.
#   2. Find what still runs a replaced binary: cloud-session runners, and the
#      interactive session in each tmux pane (the top claude of the pane; its
#      sub-claudes go with it). Anything else (chat-runner turns, desktop
#      threads, sessions outside tmux) is counted as other=, not touched: it
#      ends on its own, and a rerun shows it gone.
#   3. Stop runners: SIGTERM. A runner drains (--drain-wait-sec 600 lets a
#      running turn finish), pushes its outcome and exits; the cloud session's
#      next message is served by a new runner, on the new binary. A runner
#      still alive after the drain is never SIGKILLed: it is left running and
#      counted as runners_left=, and the exit is 1 so a rerun picks it up.
#   4. Wait up to DRAIN_SEC for every pane session to be out of a turn (its
#      session file's status is not "busy") and the runners to be gone, then
#      stop the pane sessions: SIGTERM, SIGKILL after 20 s. A session still
#      busy at the deadline is cut anyway; cut= counts them.
#   5. Resume. Agent panes (<...>-agent sessions): restart the per-user agent,
#      whose reconnect reconstructs the owner's sessions and relaunches each
#      agent pane with the backend's own launch line (claude --continue, with
#      its backend, model and telemetry) -- only where termag-box-update would
#      restart it: active, KillMode=process, the shared launcher loaded, and
#      nothing tracked under agent/ changed since it started. Every other pane,
#      and an agent pane still at a shell 45 s later: `claude --resume <id>`
#      typed into the pane (`claude --continue` without a session file).
#      A user with no claude installed (state=none) still gets steps 2 to 4:
#      every live claude is on an old binary then. Nothing is installed and
#      nothing typed (resume_via=none(no-claude)), and the exit is 1.
#
# On the orchestrator host (claude-runner-orchestrator.service installed), with
# ORCHESTRATOR=1, it first updates /usr/bin/claude (root's npm global) and
# try-restarts the unit (a stopped unit on a draining host stays stopped). It
# then waits up to 15 s for the unit's new process before reporting
# unit_binary= (current; - when the unit wasn't running; STALE(<what the
# process runs>), or DOWN(<state>) when a restart left no process: both fail
# the run). Without
# ORCHESTRATOR=1 it only reports there. Every orchestrator deploy replaces the
# host, and cloud-init reinstalls the version the infra repo pins.
# So this update lasts only
# until the next deploy, unless that pin is at the floor too. There the
# per-user agent unit is termag-agent-host.service (TERMAG_AGENT_UNIT). It
# isn't started through the shared launcher, so resumes there are typed.
#
# Env: FLOOR (2.1.308), TARGET (npm dist-tag or version; latest), DRAIN_SEC
# (600), DRY_RUN=1 (report what it would do: one `npm view` for TARGET, then
# would_update= and the sessions a real run would stop; installs and stops
# nothing),
# ORCHESTRATOR=1, TERMAG_AGENT_UNIT (termag-agent.service).
# Output: one `claude-floor host=... user=...` line per user and one for the
# orchestrator. Exit 1 when anything is below the floor or still on an old
# binary, so SSM marks the host. Rerunning is safe.
set -u
FLOOR=${FLOOR:-2.1.308}
TARGET=${TARGET:-latest}
DRAIN_SEC=${DRAIN_SEC:-600}
DRY_RUN=${DRY_RUN:-0}
ORCHESTRATOR=${ORCHESTRATOR:-0}
UNIT=${TERMAG_AGENT_UNIT:-termag-agent.service}
# TARGET and UNIT reach `claude install` and `systemctl` as arguments, so a
# leading '-' (an option) is refused too. DRY_RUN and ORCHESTRATOR are 0 or 1:
# a typo like DRY_RUN=true must not mean a real run.
case "$TARGET" in ''|-*|*[!A-Za-z0-9.-]*) echo "claude-floor: bad TARGET '$TARGET'" >&2; exit 2 ;; esac
case "$FLOOR" in ''|*[!0-9.]*) echo "claude-floor: bad FLOOR '$FLOOR'" >&2; exit 2 ;; esac
case "$DRAIN_SEC" in ''|*[!0-9]*) echo "claude-floor: bad DRAIN_SEC '$DRAIN_SEC'" >&2; exit 2 ;; esac
case "$UNIT" in ''|-*|*[!A-Za-z0-9@._-]*) echo "claude-floor: bad TERMAG_AGENT_UNIT '$UNIT'" >&2; exit 2 ;; esac
case "$DRY_RUN" in 0|1) ;; *) echo "claude-floor: bad DRY_RUN '$DRY_RUN' (0 or 1)" >&2; exit 2 ;; esac
case "$ORCHESTRATOR" in 0|1) ;; *) echo "claude-floor: bad ORCHESTRATOR '$ORCHESTRATOR' (0 or 1)" >&2; exit 2 ;; esac
host=$(hostname -s 2>/dev/null || hostname)

# Run as each user: bash -c "$per_user" claude-floor FLOOR TARGET DRY_RUN DRAIN_SEC UNIT ROOT_NPM
# (ROOT_NPM=1: root's orchestrator step updates root's npm prefix on this host first.)
# Every command that could read stdin gets </dev/null.
per_user=$(cat <<'PER_USER'
set -u
floor=$1 target=$2 dry=$3 drain=$4 unit=$5 root_npm=$6
checkout=$HOME/src/termag
ver() { "$1" --version </dev/null 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -n 1; }
at_least() { [ -n "$1" ] && [ "$(printf '%s\n%s\n' "$1" "$2" | sort -V | head -n 1)" = "$2" ]; }
export NVM_DIR=${NVM_DIR:-$HOME/.nvm}
# shellcheck disable=SC1091
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh" >/dev/null 2>&1 </dev/null
PATH="$HOME/.local/bin:$PATH"

# ── 1. update ───────────────────────────────────────────────────────────────
# TARGET is resolved once (target=). A binary already at it is left alone:
# npm reinstalls even the same version, which would replace the binary under
# every live session. With npm unreachable (target=unknown) the real run
# installs as before. A dry run installs nothing, so every live claude still
# runs a current binary; it treats one the real run would replace as already
# replaced (replaced=, would_update=), and an unknown target counts as a
# replacement, so the dry run never undercounts.
replaced=() would=()
target_ver=
if command -v npm >/dev/null 2>&1; then
  target_ver=$(timeout 60 npm view "@anthropic-ai/claude-code@$target" version </dev/null 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | tail -n 1)
fi
# would_replace <name> <before> <binary>: in a dry run, whether the real run would install over it.
would_replace() {
  [ "$2" = "${target_ver:-}" ] && return 1
  would+=("$1:${2:--}->${target_ver:-unknown}")
  replaced+=("$(readlink -f "$3")")
}
npm_note=- npm_bin=
if command -v npm >/dev/null 2>&1 && npm ls -g --depth=0 @anthropic-ai/claude-code >/dev/null 2>&1 </dev/null; then
  pkg=$(npm root -g </dev/null 2>/dev/null)/@anthropic-ai/claude-code
  pver() { sed -n 's/^ *"version": *"\([^"]*\)".*/\1/p' "$pkg/package.json" 2>/dev/null | head -n 1; }
  before=$(pver)
  if [ "$dry" = 1 ] && [ ! -w "${pkg%/@anthropic-ai/claude-code}" ]; then
    npm_note="$before(dry-run,root-owned)"
    [ "$root_npm" = 1 ] && would_replace npm "$before" "$pkg/bin/claude.exe"
  elif [ "$dry" = 1 ]; then
    npm_note="$before(dry-run)"
    would_replace npm "$before" "$pkg/bin/claude.exe"
  elif [ -n "$target_ver" ] && [ "$before" = "$target_ver" ]; then
    npm_note="$before(current)"
  elif [ ! -w "${pkg%/@anthropic-ai/claude-code}" ]; then
    # The system npm on the orchestrator host: root's prefix, which root's step updates.
    npm_note="$before(root-owned)"
  else
    npm_install() { timeout 600 npm install -g --no-fund --no-audit --loglevel=error "@anthropic-ai/claude-code@$target" </dev/null >/dev/null; }
    # One retry: the owner's own Claude may be auto-updating the same prefix.
    if npm_install || { sleep 15; npm_install; }; then npm_note="$before->$(pver)"; else npm_note="$before->FAILED"; fi
  fi
  npm_bin=$pkg/bin/claude.exe
fi
native_note=-
nat=$HOME/.local/bin/claude
if [ -x "$nat" ]; then
  case "$(readlink -f "$nat")" in
    */node_modules/*) native_note=link-to-npm ;;
    *)
      before=$(ver "$nat")
      if [ "$dry" = 1 ]; then
        native_note="$before(dry-run)"
        would_replace native "$before" "$nat"
      elif [ -n "$target_ver" ] && [ "$before" = "$target_ver" ]; then
        native_note="$before(current)"
      else
        timeout 600 "$nat" update </dev/null >/dev/null 2>&1
        # `claude update` follows the native channel, which can stop short of a pinned TARGET.
        if [ -n "$target_ver" ] && [ "$(ver "$nat")" != "$target_ver" ]; then
          timeout 600 "$nat" install "$target" </dev/null >/dev/null 2>&1
        fi
        at_least "$(ver "$nat")" "$floor" || timeout 600 "$nat" install "$target" </dev/null >/dev/null 2>&1
        native_note="$before->$(ver "$nat")"
      fi ;;
  esac
fi
# The claude termag-claude-runner would start: ~/.local/bin first, then PATH.
if [ -x "$nat" ]; then bin=$nat; else bin=$(command -v claude 2>/dev/null || true); fi
v=; [ -n "$bin" ] && v=$(ver "$bin")
if [ -z "$bin" ]; then state=none
elif at_least "$v" "$floor"; then state=ok
elif [ "$dry" = 1 ]; then state=below-floor-until-updated
else state=BELOW_FLOOR; fi
line="claude=${bin:--} version=${v:--} state=$state target=${target_ver:-unknown} npm=$npm_note native=$native_note"
if [ "$dry" = 1 ]; then
  if [ "${#would[@]}" -gt 0 ]; then line="$line would_update=$(IFS=,; echo "${would[*]}")"; else line="$line would_update=no"; fi
fi
if [ "$state" = BELOW_FLOOR ]; then echo "$line stopped=nothing"; exit 1; fi

# ── 2. what still runs a replaced binary ────────────────────────────────────
current=()
for c in "$bin" "$nat" "$npm_bin"; do
  [ -n "$c" ] && [ -e "$c" ] || continue
  c=$(readlink -f "$c")
  # (dry run) a binary the real run would replace is not current.
  for r in "${replaced[@]}"; do [ "$c" = "$r" ] && continue 2; done
  current+=("$c")
done
is_claude() {
  local exe cmd
  exe=$(readlink "/proc/$1/exe" 2>/dev/null) || return 1
  case "$exe" in
    */claude|*/claude\ \(deleted\)|*/claude.exe|*/claude.exe\ \(deleted\)|*/claude/versions/*) return 0 ;;
    */node|*/node\ \(deleted\))
      cmd=$(tr '\0' ' ' <"/proc/$1/cmdline" 2>/dev/null)
      case "$cmd" in *@anthropic-ai/claude-code*) return 0 ;; esac ;;
  esac
  return 1
}
# A replaced binary's inode is no longer any current one's, whatever the path says.
is_current() { local c; for c in "${current[@]}"; do [ "/proc/$1/exe" -ef "$c" ] && return 0; done; return 1; }
ppid_of() { sed -E 's/^.*\) [A-Za-z] ([0-9]+) .*$/\1/' "/proc/$1/stat" 2>/dev/null; }
under_claude() {
  local p; p=$(ppid_of "$1")
  while [ -n "$p" ] && [ "$p" -gt 1 ]; do is_claude "$p" && return 0; p=$(ppid_of "$p"); done
  return 1
}
env_of() { tr '\0' '\n' <"/proc/$1/environ" 2>/dev/null | sed -n "s/^$2=//p" | head -n 1; }
# A field of the session file Claude Code keeps for a live interactive session.
sess() {
  local cfg; cfg=$(env_of "$1" CLAUDE_CONFIG_DIR)
  sed -n "s/.*\"$2\":\"\([^\"]*\)\".*/\1/p" "${cfg:-$HOME/.claude}/sessions/$1.json" 2>/dev/null | head -n 1
}
# The tmux server socket a process's pane lives on, as this process can reach it
# (through /proc/<pid>/root when this command runs with a private /tmp).
socket_of() {
  local s; s=$(env_of "$1" TMUX); s=${s%%,*}
  [ -n "$s" ] || return 1
  if [ -S "$s" ]; then printf '%s' "$s"; elif [ -S "/proc/$1/root$s" ]; then printf '%s' "/proc/$1/root$s"; else return 1; fi
}

runners=() p_pid=() p_sock=() p_pane=() p_sess=() p_id=() other=0
for pid in $(pgrep -u "$(id -u)"); do
  is_claude "$pid" || continue
  is_current "$pid" && continue
  cmd=$(tr '\0' ' ' <"/proc/$pid/cmdline" 2>/dev/null) || continue
  case "$cmd" in
    *"self-hosted-runner orchestrator"*) continue ;;
    *self-hosted-runner*) runners+=("$pid"); continue ;;
  esac
  under_claude "$pid" && continue
  pane=$(env_of "$pid" TMUX_PANE)
  case "$cmd" in *" -p "*|*" --print "*) pane= ;; esac
  sock=
  [ -n "$pane" ] && sock=$(socket_of "$pid")
  name=
  [ -n "$sock" ] && name=$(tmux -S "$sock" display -p -t "$pane" '#{session_name}' 2>/dev/null)
  if [ -z "$name" ]; then other=$((other + 1)); continue; fi
  p_pid+=("$pid"); p_sock+=("$sock"); p_pane+=("$pane"); p_sess+=("$name"); p_id+=("$(sess "$pid" sessionId)")
done
n=${#p_pid[@]}
agent_panes=0
for s in "${p_sess[@]}"; do case "$s" in *-agent) agent_panes=$((agent_panes + 1)) ;; esac; done

# Whether restarting the per-user agent is safe, by termag-box-update's rules.
agent_why=
agent_guard() {
  local st km es ts since f m
  st=$(systemctl --user is-active "$unit" 2>/dev/null)
  [ "$st" = active ] || { agent_why=${st:-unloaded}; return 1; }
  km=$(systemctl --user show -p KillMode --value "$unit" 2>/dev/null)
  [ "$km" = process ] || { agent_why=killmode; return 1; }
  es=$(systemctl --user show -p ExecStart --value "$unit" 2>/dev/null)
  case "$es" in
    *"$checkout/agent/run-node.sh"*|*'$HOME/src/termag/agent/run-node.sh'*|*'${HOME}/src/termag/agent/run-node.sh'*) ;;
    *) agent_why=launcher; return 1 ;;
  esac
  ts=$(systemctl --user show -p ExecMainStartTimestamp --value "$unit" 2>/dev/null)
  since=$(date -d "$ts" +%s 2>/dev/null) || { agent_why=start-unknown; return 1; }
  while IFS= read -r -d '' f; do
    case "$f" in *.test.js|*.test.sh|*.test.mjs) continue ;; esac
    m=$(stat -c %Y "$checkout/$f" 2>/dev/null) || continue
    [ "$m" -gt "$since" ] && { agent_why=agent-code-changed; return 1; }
  done < <(git -C "$checkout" ls-files -z -- agent 2>/dev/null)
  return 0
}
resume_via=typed
if [ "$state" = none ]; then
  # No claude to resume with: the agent's relaunch and a typed resume would both fail.
  resume_via="none(no-claude)"
elif [ "$agent_panes" -gt 0 ]; then
  if agent_guard; then resume_via=agent-restart; else resume_via="typed(agent:$agent_why)"; fi
fi
busy_now() {
  local i k=0
  for i in "${!p_pid[@]}"; do
    kill -0 "${p_pid[$i]}" 2>/dev/null && [ "$(sess "${p_pid[$i]}" status)" = busy ] && k=$((k + 1))
  done
  echo "$k"
}
line="$line runners=${#runners[@]} panes=$n agent_panes=$agent_panes other=$other"
if [ "$dry" = 1 ]; then
  [ $((${#runners[@]} + n)) -gt 0 ] && line="$line would=stop-and-resume busy_now=$(busy_now) resume_via=$resume_via"
  echo "$line"; exit 0
fi
if [ $((${#runners[@]} + n)) -eq 0 ]; then
  echo "$line"; [ "$other" -eq 0 ]; exit
fi

# ── 3. stop runners; 4. wait, then stop pane sessions ───────────────────────
alive() { local k=0 p; for p in "$@"; do kill -0 "$p" 2>/dev/null && k=$((k + 1)); done; echo "$k"; }
[ "${#runners[@]}" -gt 0 ] && kill -TERM "${runners[@]}" 2>/dev/null
t0=$(date +%s)
while :; do
  el=$(( $(date +%s) - t0 )) b=$(busy_now) r=$(alive "${runners[@]}")
  [ "$r" -eq 0 ] && { [ "$b" -eq 0 ] || [ "$el" -ge "$drain" ]; } && break
  # Runners get their post-session hook's 120 s on top of the drain.
  [ "$el" -ge $((drain + 180)) ] && break
  sleep 5
done
# A runner past its drain is left running, never SIGKILLed. SIGKILL gives
# self-hosted-runner no chance to stop its Claude child, and
# termag-claude-runner's EXIT trap then removes or moves the session checkout
# while that child may still be writing to it, which breaks or loses the turn.
# runners_left= counts them, the exit is 1, and a rerun picks them up.
runners_left=$(alive "${runners[@]}")
cut=$(busy_now)
for p in "${p_pid[@]}"; do kill -TERM "$p" 2>/dev/null; done
for _ in $(seq 1 20); do [ "$(alive "${p_pid[@]}")" -eq 0 ] && break; sleep 1; done
for p in "${p_pid[@]}"; do kill -0 "$p" 2>/dev/null && kill -KILL "$p" 2>/dev/null; done

# ── 5. resume ───────────────────────────────────────────────────────────────
is_shell() {
  case "$(tmux -S "$1" display -p -t "$2" '#{pane_current_command}' 2>/dev/null)" in
    zsh|bash|sh|dash|fish|ksh|-zsh|-bash) return 0 ;;
  esac
  return 1
}
pane_exists() { tmux -S "$1" display -p -t "$2" '#{pane_id}' >/dev/null 2>&1; }
# Let each pane's shell take the foreground back (a launch wrapper exits after its claude).
for i in "${!p_pid[@]}"; do
  for _ in $(seq 1 10); do pane_exists "${p_sock[$i]}" "${p_pane[$i]}" || break; is_shell "${p_sock[$i]}" "${p_pane[$i]}" && break; sleep 1; done
done
agent_restart=-
if [ "$resume_via" = agent-restart ]; then
  if systemctl --user restart "$unit" 2>/dev/null; then agent_restart=ok; else agent_restart=failed; fi
  # Reconstruction starts 2 s after the agent connects.
  for _ in $(seq 1 45); do
    waiting=0
    for i in "${!p_pid[@]}"; do
      case "${p_sess[$i]}" in *-agent) pane_exists "${p_sock[$i]}" "${p_pane[$i]}" && is_shell "${p_sock[$i]}" "${p_pane[$i]}" && waiting=1 ;; esac
    done
    [ "$waiting" -eq 0 ] && break
    sleep 1
  done
fi
typed=0 gone=0
for i in "${!p_pid[@]}"; do
  s=${p_sock[$i]} pn=${p_pane[$i]}
  pane_exists "$s" "$pn" || { gone=$((gone + 1)); continue; }
  [ "$state" = none ] && continue
  is_shell "$s" "$pn" || continue
  id=${p_id[$i]}
  if [[ "$id" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ ]]; then
    tmux -S "$s" send-keys -t "$pn" -l "claude --resume $id"
  else
    tmux -S "$s" send-keys -t "$pn" -l 'claude --continue'
  fi
  tmux -S "$s" send-keys -t "$pn" Enter
  typed=$((typed + 1))
done
sleep 10
resumed=0
for i in "${!p_pid[@]}"; do
  pane_exists "${p_sock[$i]}" "${p_pane[$i]}" && ! is_shell "${p_sock[$i]}" "${p_pane[$i]}" && resumed=$((resumed + 1))
done
echo "$line sigterm_runners=${#runners[@]} runners_left=$runners_left stopped=$n cut=$cut agent_restart=$agent_restart resume_via=$resume_via typed=$typed resumed=$resumed/$n gone=$gone"
[ "$resumed" -eq $((n - gone)) ] && [ "$gone" -eq 0 ] && [ "$other" -eq 0 ] && [ "$runners_left" -eq 0 ]
PER_USER
)

rc=0
if [ "$(id -u)" != 0 ]; then
  out=$(bash -c "$per_user" claude-floor "$FLOOR" "$TARGET" "$DRY_RUN" "$DRAIN_SEC" "$UNIT" 0 </dev/null) || rc=1
  echo "claude-floor host=$host user=$(id -un) $out"
  exit "$rc"
fi

ver() { "$1" --version </dev/null 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -n 1; }
at_least() { [ -n "$1" ] && [ "$(printf '%s\n%s\n' "$1" "$2" | sort -V | head -n 1)" = "$2" ]; }

# ── the runner orchestrator's unit ──────────────────────────────────────────
# claude-floor.test.sh loads these functions by name, so each one is a
# top-level `name() {` ... `}` block. They read $ounit and $ob.
ustate() {
  echo "$(systemctl show -p ActiveState --value "$ounit")/$(systemctl show -p SubState --value "$ounit")"
}

# Which binary the unit's main process runs: current (the file /usr/bin/claude
# is now), - (no main process), or STALE(<what it runs>), so a report tells an
# old claude ("...claude.exe,deleted") from anything else.
unit_binary() {
  local pid exe
  pid=$(systemctl show -p MainPID --value "$ounit")
  [ "${pid:-0}" != 0 ] || { echo -; return; }
  if [ "/proc/$pid/exe" -ef "$(readlink -f "$ob")" ]; then echo current; return; fi
  exe=$(readlink "/proc/$pid/exe" 2>/dev/null) || exe=unknown
  exe=${exe// (deleted)/,deleted}
  echo "STALE(${exe// /_})"
}

# After a restart. The unit is Type=simple: systemd counts a start as done once
# it has forked the service, before that child has exec'd /usr/bin/claude.
# Checked at once, the new process can still look STALE. On the orchestrator
# host on 2026-11-02 a run reported STALE straight after its restart, and a dry
# run minutes later found it current. So give the exec unit_wait_tries x 0.5 s
# (15 s). 0 once the unit runs the new binary, 1 if it never does.
unit_wait_tries=30
unit_wait_current() {
  local i=0
  while [ "$i" -lt "$unit_wait_tries" ]; do
    [ "$(unit_binary)" = current ] && return 0
    i=$((i + 1))
    sleep 0.5
  done
  return 1
}

# The unit_binary= field for note $1. A restart that left no main process (the
# new one exited, or systemd is between restarts) is DOWN(<state>), and fails
# the run like STALE. Only a unit that wasn't running to begin with stays -.
unit_report() {
  local b
  b=$(unit_binary)
  case "$b:$1" in "-:"*restarted*) b="DOWN($(ustate))" ;; esac
  echo "$b"
}

# The orchestrator host's runner orchestrator first: it is one process, it runs
# no turns, and the backend stops and starts it on every overlapping deploy.
ounit=claude-runner-orchestrator.service
root_npm=0
if [ -f "/etc/systemd/system/$ounit" ]; then
  [ "$ORCHESTRATOR" = 1 ] && root_npm=1
  ob=/usr/bin/claude before=$(ver /usr/bin/claude) note=report-only
  otarget=$(timeout 60 npm view "@anthropic-ai/claude-code@$TARGET" version </dev/null 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | tail -n 1)
  if [ "$ORCHESTRATOR" = 1 ] && [ "$DRY_RUN" != 1 ]; then
    # Only the install cloud-init made: /usr/bin/claude under root's npm global.
    case "$(readlink -f "$ob")" in
      "$(npm root -g 2>/dev/null </dev/null)"/*)
        if [ -n "$otarget" ] && [ "$before" = "$otarget" ]; then
          note=current
        elif timeout 600 npm install -g --no-fund --no-audit --loglevel=error "@anthropic-ai/claude-code@$TARGET" </dev/null >/dev/null; then
          note=installed
        else
          note=npm-FAILED
        fi
        if [ "$note" != npm-FAILED ] && at_least "$(ver "$ob")" "$FLOOR"; then
          pid=$(systemctl show -p MainPID --value "$ounit")
          if [ "${pid:-0}" != 0 ] && ! [ "/proc/$pid/exe" -ef "$(readlink -f "$ob")" ]; then
            systemctl try-restart "$ounit" && note=$note,restarted
          elif [ "$note" = installed ] && [ "$(ustate)" = activating/auto-restart ]; then
            # Between restarts (Restart=always, backoff up to 300 s): start it on the new binary now.
            systemctl restart "$ounit" && note=$note,restarted
          fi
          case "$note" in *restarted) unit_wait_current || : ;; esac
        fi ;;
      *) note="not-root-npm($(readlink -f "$ob"))" ;;
    esac
  fi
  after=$(ver "$ob")
  state=ok; at_least "$after" "$FLOOR" || { state=BELOW_FLOOR; rc=1; }
  unit_bin=$(unit_report "$note")
  case "$unit_bin" in STALE*|DOWN*) rc=1 ;; esac
  echo "claude-floor host=$host orchestrator claude=$ob version=${before:--}->${after:--} state=$state target=${otarget:-unknown} unit=$(ustate) unit_binary=$unit_bin note=$note"
fi

outd=$(mktemp -d)
trap 'rm -rf "$outd"' EXIT
jobs_=()
for f in /var/lib/systemd/linger/*; do
  u=${f##*/}
  [ -e "$f" ] && [ "$u" != termag-guest ] || continue
  home=$(getent passwd "$u" | cut -d: -f6)
  if [ -z "$home" ] || [ ! -d "$home" ]; then continue; fi
  uid=$(id -u "$u")
  (
    out=$(cd / && sudo -u "$u" -H env XDG_RUNTIME_DIR="/run/user/$uid" DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$uid/bus" \
      bash -c "$per_user" claude-floor "$FLOOR" "$TARGET" "$DRY_RUN" "$DRAIN_SEC" "$UNIT" "$root_npm" </dev/null)
    r=$?
    echo "claude-floor host=$host user=$u $out" >"$outd/$u"
    exit "$r"
  ) &
  jobs_+=("$!")
done
for j in "${jobs_[@]}"; do wait "$j" || rc=1; done
cat "$outd"/* 2>/dev/null
exit "$rc"
