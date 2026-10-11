#!/usr/bin/env bash
# Control one process of the running e2e stack.
#
#   ctl.sh stop|start|restart <name>   name: backend, frontend, box-N, box-network,
#                                      floci, github, nginx, sshd-box-N, ec2-launch,
#                                      backend-green (E2E_OVERLAP)
#   ctl.sh fault <box-N> <mode>        needs E2E_TMUX_FAULTS=1; mode is one of
#                                      off, hang, attach-delay=<seconds>
#   ctl.sh ec2 <what>                  needs E2E_EC2_LAUNCH=1; what is one of
#                                      bake [Key=Value ...]
#                                                register a newer box image; tags
#                                                override App=termag Component=box
#                                                (e.g. Component=box-candidate)
#                                      clear     deregister every box image, so
#                                                the next launch fails
#                                      no-agent  launched or started instances
#                                                start no box agent
#                                      agent     they start a box agent again
#                                      ignore-stop  StopInstances is accepted
#                                                but the instance keeps running
#                                      honor-stop   StopInstances stops again
#                                      refuse-hibernate  every hibernate answers
#                                                EC2's "not ready to hibernate yet"
#                                      allow-hibernate   hibernates work again
#                                      hold-terminate  terminated instances
#                                                read as shutting-down, so a
#                                                teardown keeps waiting
#                                      release-terminate  they read as
#                                                terminated again
#
# start re-runs the exact command up.sh used, so it picks up an edited
# <root>/backend.env or agent config. Stopping a box leaves its tmux server
# running, as a real agent restart does.
set -euo pipefail

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source-path=SCRIPTDIR
. "$here/lib.sh"
root=$(e2e_root) || die "no e2e stack is up"

usage="usage: ctl.sh stop|start|restart <name> | fault <box-N> <mode> | ec2 bake [Key=Value ...]|clear|no-agent|agent|ignore-stop|honor-stop|refuse-hibernate|allow-hibernate|hold-terminate|release-terminate"
action=${1:-}; name=${2:-}
[ -n "$name" ] || die "$usage"

stop_one() {
  local pidfile="$root/pids/$name.pid" pid
  [ -f "$pidfile" ] || { log "$name is not running"; return 0; }
  pid=$(cat "$pidfile")
  kill -TERM -- "-$pid" 2>/dev/null || true
  for _ in $(seq 1 40); do kill -0 "$pid" 2>/dev/null || break; sleep 0.25; done
  kill -0 "$pid" 2>/dev/null && kill -KILL -- "-$pid" 2>/dev/null || true
  rm -f "$pidfile"
  log "stopped $name"
}

start_one() {
  [ -f "$root/cmds/$name" ] || die "unknown process '$name' (see $root/cmds)"
  if [ -f "$root/pids/$name.pid" ] && kill -0 "$(cat "$root/pids/$name.pid")" 2>/dev/null; then
    die "$name is already running"
  fi
  launch_daemon "$root" "$name"
  log "started $name (pid $(cat "$root/pids/$name.pid"))"
}

case $action in
  stop) stop_one ;;
  start) start_one ;;
  restart) stop_one; start_one ;;
  fault)
    mode=${3:-}
    [ -f "$root/boxes/$name/tmux-fault" ] || die "$name has no fault hook (start the stack with E2E_TMUX_FAULTS=1)"
    case $mode in
      off) : >"$root/boxes/$name/tmux-fault" ;;
      hang|attach-delay=[0-9]*) printf '%s\n' "$mode" >"$root/boxes/$name/tmux-fault" ;;
      *) die "fault mode must be off, hang or attach-delay=<seconds>" ;;
    esac
    log "$name tmux fault: $mode" ;;
  ec2)
    # shellcheck disable=SC1091
    . "$root/stack.env"
    [ -n "${EC2_URL:-}" ] || die "the stack was started without E2E_EC2_LAUNCH=1"
    launcher() {
      env -i "PATH=$PATH" "HOME=$root/orchestrator-home" "E2E_FLOCI_URL=$AWS_URL" "AWS_REGION=$AWS_REGION" \
        node "$here/fakes/ec2-launcher.mjs" "$1" "$root" "${@:2}"
    }
    case $name in
      bake) log "registered box image $(launcher bake "${@:3}")${3:+ tagged ${*:3}}" ;;
      clear) log "$(launcher clear)" ;;
      no-agent) touch "$root/ec2/no-agent"; log "launched instances now start no box agent" ;;
      agent) rm -f "$root/ec2/no-agent"; log "launched instances start a box agent again" ;;
      ignore-stop) touch "$root/ec2/ignore-stop"; log "StopInstances is now accepted and ignored" ;;
      honor-stop) rm -f "$root/ec2/ignore-stop"; log "StopInstances stops instances again" ;;
      refuse-hibernate) touch "$root/ec2/refuse-hibernate"; log "StopInstances with Hibernate is now refused as not ready" ;;
      allow-hibernate) rm -f "$root/ec2/refuse-hibernate"; log "StopInstances with Hibernate hibernates again" ;;
      hold-terminate) touch "$root/ec2/hold-terminate"; log "terminated instances now read as shutting-down" ;;
      release-terminate) rm -f "$root/ec2/hold-terminate"; log "terminated instances read as terminated again" ;;
      *) die "$usage" ;;
    esac ;;
  *) die "$usage" ;;
esac
