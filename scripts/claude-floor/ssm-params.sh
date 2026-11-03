#!/usr/bin/env bash
# ssm-params.sh [VAR=value ...] -- print AWS-RunShellScript parameters that run
# claude-floor.sh (next to this file) as root with those variables, e.g.
#   ./ssm-params.sh DRY_RUN=1 > dry.json
#   ./ssm-params.sh ORCHESTRATOR=1 > orch.json
# The script travels gzip+base64 inside the command; nothing is fetched.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
# The command runs as root on every targeted host, so no argument reaches it
# raw (CWE-78): only NAME=VALUE for claude-floor.sh's own variables, the whole
# value from a closed character set, each name once, and the prefix is built
# from the checked parts, each quoted.
prefix='' seen=' '
for a in "$@"; do
  if ! [[ "$a" =~ ^(FLOOR|TARGET|DRAIN_SEC|DRY_RUN|ORCHESTRATOR|TERMAG_AGENT_UNIT)=([A-Za-z0-9._@-]+)$ ]]; then
    echo "ssm-params: bad argument '$a' (want NAME=VALUE: NAME one of FLOOR TARGET DRAIN_SEC DRY_RUN ORCHESTRATOR TERMAG_AGENT_UNIT, VALUE of A-Za-z0-9._@-)" >&2
    exit 2
  fi
  name=${BASH_REMATCH[1]} value=${BASH_REMATCH[2]}
  case "$seen" in *" $name "*) echo "ssm-params: $name given twice" >&2; exit 2 ;; esac
  seen="$seen$name "
  prefix="$prefix$name=$(printf '%q' "$value") "
done
b64=$(gzip -9c "$here/claude-floor.sh" | base64 | tr -d '\n')
cmd="f=\$(mktemp) && echo $b64 | base64 -d | gunzip > \"\$f\" && { ${prefix}bash \"\$f\"; rc=\$?; rm -f \"\$f\"; exit \$rc; }"
jq -n --arg c "$cmd" '{commands: [$c], executionTimeout: ["3600"]}'
