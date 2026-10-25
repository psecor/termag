#!/usr/bin/env bash
# The warm pool end to end on its own stack: E2E_WARM_POOL boxes launched
# through the EC2 fake and warmed through the on-warm unit, E2E_FLAGS
# turning warm-pool-enabled on, then Add box claiming them. Runs on its own
# ports, TMPDIR and download cache, beside a stack that is already up.
#
# The claim checks need a backend that claims (POST /api/instances answers
# `claimed`); without one they are skipped, so this also passes on a branch
# that only has the pool. The dotfiles checks need on-claim personalization
# (deploy/termag-on-claim.service) and are skipped without it.
#
# Run: bash scripts/e2e/warm-pool.test.sh
#   E2E_TEST_PORT_SHIFT=N        add N to every port
#   E2E_TEST_OLD_AGENT=<dir>     an agent/ checkout from before claims reported
#                                on-claim status, for the older-agent check
set -uo pipefail

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
repo=$(cd "$here/../.." && pwd)
WORK=$(mktemp -d)
export TMPDIR=$WORK
export E2E_CACHE_DIR=${E2E_TEST_CACHE_DIR:-${XDG_CACHE_HOME:-$HOME/.cache}/termag-e2e}
S=${E2E_TEST_PORT_SHIFT:-0}
export E2E_PORT=$((3960 + S)) E2E_FRONTEND_PORT=$((5994 + S)) E2E_PG_PORT=$((55459 + S)) E2E_BOXES=1 \
  E2E_AWS_PORT=$((4866 + S)) E2E_EC2_PORT=$((4867 + S)) E2E_GITHUB_PORT=$((4881 + S)) \
  E2E_FAKE_AWS=1 E2E_EC2_LAUNCH=1 E2E_FAKE_GITHUB=1 E2E_WARM_POOL=2 E2E_WARM_POOL_TICK=2 \
  E2E_FLAGS='{"warm-pool-enabled":true}'
# The dotfiles checks run the stub's e2e-org/dotfiles install.sh, and stand-in
# boxes run no dotfiles script unless told to (TERMAG_DOTFILES_NO_SCRIPTS).
export E2E_DOTFILES_SCRIPTS=1
trap 'bash "$here/down.sh" >/dev/null 2>&1; rm -rf "$WORK"' EXIT

fails=0 skips=0
pass() { echo "ok:   $1"; }
fail() { echo "FAIL: $1"; echo "      want: $2"; echo "      got:  $3"; fails=$((fails + 1)); }
check() { if [ "$2" = "$3" ]; then pass "$1"; else fail "$1" "$2" "$3"; fi; }
skip() { echo "skip: $1"; skips=$((skips + 1)); }

touch "$WORK/.started"
sleep 1
if ! bash "$here/up.sh" >"$WORK/up.log" 2>&1; then
  cat "$WORK/up.log"; echo "FAIL: up.sh with the warm pool"; exit 1
fi
pass "up.sh brought the stack up with E2E_WARM_POOL=2 and E2E_FLAGS"

# shellcheck source-path=SCRIPTDIR
. "$here/lib.sh"
ROOT=$(e2e_root) || { echo "FAIL: no stack root after up.sh"; exit 1; }
API="http://127.0.0.1:$E2E_PORT/termag"
PG="postgresql://termag@127.0.0.1:$E2E_PG_PORT/termag"
CTL="bash $here/ctl.sh"
JAR="$WORK/cookies"
curl -s -o /dev/null -c "$JAR" "$API/auth/login"

sql() { psql "$PG" -Atc "$1"; }
row() { sql "select $2 from instances where id = '$1'"; }
warm_ids() { sql "select id from instances where status = 'warm' and \"userId\" is null order by \"warmedAt\""; }
wait_warm() { # wait_warm N [seconds]
  for _ in $(seq 1 $((${2:-60} * 4))); do [ "$(warm_ids | grep -c .)" -ge "$1" ] && return 0; sleep 0.25; done
  return 1
}
wait_row() { # wait_row ID COLUMN VALUE [seconds]
  local v
  for _ in $(seq 1 $((${4:-30} * 4))); do v=$(row "$1" "\"$2\""); [ "$v" = "$3" ] && break; sleep 0.25; done
  printf '%s' "$v"
}
box_dir() { dirname "$(row "$1" '"hostHome"')"; }
box_name_of() { basename "$(box_dir "$1")"; }
next_name() { echo "claim-$(date +%s%N | cut -c9-16)"; }
set_dotfiles() {
  local v=null; [ "$1" = null ] || v="\"$1\""
  curl -s -b "$JAR" -X PUT -H 'content-type: application/json' -d "{\"dotfilesRepoUrl\":$v}" "$API/auth/me/preferences" >/dev/null
}
claim() { # claim NAME: sets CLAIM_JSON, CLAIM_ID
  CLAIM_JSON=$(curl -s -b "$JAR" -H 'content-type: application/json' -d "{\"name\":\"$1\"}" "$API/api/instances")
  CLAIM_ID=$(jq -r .instance.id <<<"$CLAIM_JSON" 2>/dev/null)
}
claimed() { jq -r .claimed <<<"$CLAIM_JSON"; }
# Point a box's agent at another checkout (cmds/<name> holds its argv, the
# directory first) and restart it.
agent_from() { # agent_from BOXNAME DIR
  python3 - "$ROOT/cmds/$1" "$2" <<'PY'
import sys
p, d = sys.argv[1], sys.argv[2]
a = open(p, 'rb').read().split(b'\0')
a[0] = d.encode()
open(p, 'wb').write(b'\0'.join(a))
PY
  $CTL restart "$1" >/dev/null
}

echo "--- the pool"
if wait_warm 2 90; then pass "the reconciler fills the pool to 2 warm boxes"; else fail "the pool fills" 2 "$(warm_ids | grep -c .)"; fi
first=$(warm_ids | head -1)
b=$(box_dir "$first")
check "a pool box's agent announced itself warm and ran the on-warm unit" succeeded "$(row "$first" '"onWarmStatus"')"
check "it carries the pool marker cloud-init writes" "$(row "$first" '"poolSpecHash"')" \
  "$(jq -r .poolSpecHash "$b/home/.termag/pool.json" 2>/dev/null)"
check "the stub's public dotfiles repo clones from the box with no token" yes \
  "$(HOME=$b/home GIT_CONFIG_SYSTEM=$b/etc/gitconfig GIT_CONFIG_GLOBAL=/dev/null GIT_TERMINAL_PROMPT=0 \
    git ls-remote https://github.com/e2e-org/dotfiles >/dev/null 2>&1 && echo yes || echo no)"
check "and a private one still asks for credentials" no \
  "$(HOME=$b/home GIT_CONFIG_SYSTEM=$b/etc/gitconfig GIT_CONFIG_GLOBAL=/dev/null GIT_TERMINAL_PROMPT=0 \
    git ls-remote https://github.com/e2e-org/sample >/dev/null 2>&1 && echo yes || echo no)"
check "E2E_FLAGS reaches the frontend through /api/flags" true \
  "$(curl -s -b "$JAR" "$API/api/flags" | jq -r '.flags["warm-pool-enabled"]')"

claim "$(next_name)"
if [ "$(claimed)" = null ]; then
  skip "claim checks: this backend does not claim warm boxes (no 'claimed' in POST /api/instances)"
else
  echo "--- claim"
  check "Add box with a warm pool hands back a claimed box" true "$(claimed)"
  check "already ready" ready "$(jq -r .instance.status <<<"$CLAIM_JSON")"
  b=$(box_dir "$CLAIM_ID")
  check "with the claimer's git identity" e2e@termag.local "$(HOME=$b/home git config --global user.email)"
  check "and the box token now the claimer's" "$(sql "select id from users where \"googleEmail\"='e2e@termag.local'")" \
    "$(sql "select \"userId\" from agent_tokens where \"instanceId\"='$CLAIM_ID' and \"revokedAt\" is null")"

  # The owner's registered SSH keys reach a claimed box.
  key="$WORK/id_claim"; ssh-keygen -q -t ed25519 -N '' -C warm-pool-test -f "$key"
  curl -s -b "$JAR" -H 'content-type: application/json' -d "{\"publicKey\":\"$(cat "$key.pub")\"}" "$API/api/ssh-keys" >/dev/null
  wait_warm 1 60
  claim "$(next_name)"
  b=$(box_dir "$CLAIM_ID") body=$(cut -d' ' -f2 "$key.pub")
  for _ in $(seq 1 40); do grep -qF "$body" "$b/home/.ssh/authorized_keys" 2>/dev/null && break; sleep 0.25; done
  check "the owner's registered SSH key reaches the claimed box" yes \
    "$(grep -qF "$body" "$b/home/.ssh/authorized_keys" 2>/dev/null && echo yes || echo no)"

  # Right after a restart Postgres still reads the pool as connected, but no
  # socket here reaches it: a claim must take the cold path, not fail them.
  wait_warm 2 60
  before=$(warm_ids | tr '\n' ' ')
  restarted_at=$(sql "select to_char(now() at time zone 'utc', 'YYYY-MM-DD HH24:MI:SS.US')")
  $CTL stop backend >/dev/null
  for id in $before; do sql "update instances set \"agentDisconnectedAt\" = null where id = '$id'" >/dev/null; done
  $CTL start backend >/dev/null
  for _ in $(seq 1 120); do
    curl -s -o /dev/null -c "$JAR" "$API/auth/login"
    [ "$(curl -s -o /dev/null -w '%{http_code}' -b "$JAR" "$API/api/instances")" = 200 ] && break
    sleep 0.25
  done
  claim "$(next_name)"
  check "a claim before the pool's agents redial takes the cold path" false "$(claimed)"
  check "and fails no warm box" "$(for _ in $before; do printf 'warm '; done)" "$(for id in $before; do printf '%s ' "$(row "$id" status)"; done)"
  curl -s -b "$JAR" -X DELETE "$API/api/instances/$CLAIM_ID" >/dev/null
  for _ in $(seq 1 120); do
    live=0; for id in $before; do [ -n "$(sql "select 1 from instances where id='$id' and \"lastConnectedAt\" > '$restarted_at'")" ] && live=$((live + 1)); done
    [ "$live" -ge 2 ] && break; sleep 0.25
  done
  claim "$(next_name)"
  check "once they have redialled, Add box claims one of them" "true yes" \
    "$(claimed) $(case " $before " in *" $CLAIM_ID "*) echo yes ;; *) echo no ;; esac)"

  if [ ! -f "$repo/deploy/termag-on-claim.service" ]; then
    skip "dotfiles checks: this checkout has no on-claim personalization (deploy/termag-on-claim.service)"
  else
    echo "--- dotfiles on claim"
    set_dotfiles https://github.com/e2e-org/dotfiles
    wait_warm 1 60
    claim "$(next_name)"
    id=$CLAIM_ID b=$(box_dir "$CLAIM_ID")
    check "a dotfiles claim is personalizing" running "$(wait_row "$id" onClaimStatus running 15)"
    check "then succeeds" succeeded "$(wait_row "$id" onClaimStatus succeeded 40)"
    check "and the repo's install.sh ran for the claimer" \
      "applied for $(sql "select \"displayName\" from users where \"googleEmail\"='e2e@termag.local'") <e2e@termag.local>" \
      "$(cat "$b/home/.e2e-dotfiles-applied" 2>/dev/null)"
    stamp=$(stat -c %Y.%N "$b/home/.e2e-dotfiles-applied" 2>/dev/null)
    (cd "$b/home" && env -i HOME="$b/home" PATH="$b/bin:$PATH" GIT_CONFIG_SYSTEM="$b/etc/gitconfig" \
      TERMAG_DOTFILES_USE_OWNER_GIT=1 "$b/home/src/termag/deploy/termag-hook-run" claim >/dev/null 2>&1)
    check "a rerun of the claim hook does not run an applied install.sh again" "$stamp succeeded" \
      "$(stat -c %Y.%N "$b/home/.e2e-dotfiles-applied" 2>/dev/null) $(wait_row "$id" onClaimStatus succeeded 10)"

    # The run outlives a socket drop (a network blip, an orchestrator restart):
    # the agent reconnects in place and the result must still arrive.
    wait_warm 2 60
    for id in $(warm_ids); do echo 'E2E_DOTFILES_SECONDS=8' >"$(box_dir "$id")/home/.termag/e2e-dotfiles.env"; done
    claim "$(next_name)"
    id=$CLAIM_ID
    wait_row "$id" onClaimStatus running 15 >/dev/null
    $CTL restart box-network >/dev/null
    check "a run that ends after its socket reconnected still reaches the backend" succeeded "$(wait_row "$id" onClaimStatus succeeded 60)"
    for w in $(warm_ids); do rm -f "$(box_dir "$w")/home/.termag/e2e-dotfiles.env"; done

    # A private repo waits for the owner's GitHub login; a rerun of the claim hook,
    # with the owner's credentials, must clear the badge.
    set_dotfiles https://github.com/e2e-org/sample
    wait_warm 1 60
    claim "$(next_name)"
    id=$CLAIM_ID b=$(box_dir "$CLAIM_ID")
    check "a private dotfiles repo waits for GitHub login" "skipped Dotfiles wait for GitHub login on the box" \
      "$(wait_row "$id" onClaimStatus skipped 30) $(row "$id" '"onClaimError"')"
    git config -f "$b/etc/gitconfig" credential.helper '!f() { echo username=x-access-token; echo password=gho_e2e_owner; }; f'
    (cd "$b/home" && env -i HOME="$b/home" PATH="$b/bin:$PATH" GIT_CONFIG_SYSTEM="$b/etc/gitconfig" \
      TERMAG_DOTFILES_USE_OWNER_GIT=1 "$b/home/src/termag/deploy/termag-hook-run" claim >/dev/null 2>&1)
    check "a rerun of the claim hook after login reaches the backend and clears the badge" "succeeded " \
      "$(wait_row "$id" onClaimStatus succeeded 20) $(row "$id" '"onClaimError"')"

    if [ -z "${E2E_TEST_OLD_AGENT:-}" ]; then
      skip "older-agent check: set E2E_TEST_OLD_AGENT to an agent/ checkout from before claims reported on-claim status"
    else
      # An agent that acks box-claim without reporting on dotfiles must not
      # leave the claim pending forever.
      set_dotfiles https://github.com/e2e-org/dotfiles
      wait_warm 2 60
      for id in $(warm_ids); do agent_from "$(box_name_of "$id")" "$E2E_TEST_OLD_AGENT"; done
      sleep 4
      claim "$(next_name)"
      check "a claim on an agent that will not report is settled, not left pending" skipped \
        "$(wait_row "$CLAIM_ID" onClaimStatus skipped 15)"
      for id in $(warm_ids); do agent_from "$(box_name_of "$id")" "$repo/agent"; done
    fi
    set_dotfiles null
  fi
fi

echo "--- down"
bash "$here/down.sh" >/dev/null 2>&1
check "down.sh leaves no process of the stack running" "" "$(e2e_pids "$ROOT" | head -n 5)"
check "no files written outside the temp root" "" "$(e2e_leaks "$WORK/.started" "$WORK")"

echo
if [ "$fails" -eq 0 ]; then echo "all warm-pool checks passed ($skips skipped)"; exit 0; fi
echo "$fails warm-pool check(s) failed"; exit 1
