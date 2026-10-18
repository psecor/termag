#!/bin/sh
# Tests deploy/termag-rds-cutover and deploy/termag-rds-bootstrap.sql against a
# throwaway Postgres cluster: one database stands in for the host's container,
# another for Aurora. `rds_iam` is an ordinary NOLOGIN role here, and trust
# auth accepts whatever token the tool presents.
#
# Covers:
#   * the bootstrap runs, and re-runs, as a non-owner admin, and leaves
#     `application` with DML and no DDL on everything a restore creates
#   * preflight refuses an un-bootstrapped target
#   * rehearse leaves Aurora empty, and --keep makes migrate refuse
#   * wipe needs --yes and keeps the grants
#   * migrate copies everything, verifies exact counts, writes the marker
#   * verify catches a difference; rollback-to-docker copies Aurora back and
#     writes ALLOW_DOCKER_ROLLBACK
#   * the token never appears in the tool's output
#   * a client newer than the server: both restores go through a script with
#     the settings the server doesn't know filtered out. pg_restore 17's scripts
#     open with SET transaction_timeout, which the host's Postgres 14 rejects.
#     A stand-in pg_restore makes every script open with a setting no server
#     knows, so this is tested whatever Postgres is installed. With
#     TERMAG_TEST_PG_SOURCE_BIN pointing at an older major (e.g. 14) and
#     TERMAG_TEST_PG_BIN at 17, the container is that older server for real;
#     TERMAG_TEST_REAL_CLIENT=1 also leaves the stand-in out.
#
# Skips (exit 0) when no PostgreSQL server binaries are installed.
# Run: sh deploy/termag-rds-cutover.test.sh
#      TERMAG_TEST_PG_SOURCE_BIN=/usr/lib/postgresql/14/bin TERMAG_TEST_PG_BIN=/usr/lib/postgresql/17/bin sh deploy/termag-rds-cutover.test.sh
set -u

SCRIPT="$(cd "$(dirname "$0")" && pwd)/termag-rds-cutover"
BOOTSTRAP="$(cd "$(dirname "$0")" && pwd)/termag-rds-bootstrap.sql"

PG_BIN=${TERMAG_TEST_PG_BIN:-}
if [ -z "$PG_BIN" ]; then
  if command -v pg_config >/dev/null 2>&1 && [ -x "$(pg_config --bindir)/initdb" ]; then
    PG_BIN=$(pg_config --bindir)
  else
    PG_BIN=$(find /usr/lib/postgresql -maxdepth 2 -name bin -type d 2>/dev/null | sort -V | tail -n1)
  fi
fi
if [ -z "$PG_BIN" ] || [ ! -x "$PG_BIN/initdb" ]; then
  echo "SKIP: no PostgreSQL server binaries (set TERMAG_TEST_PG_BIN)"
  exit 0
fi
SOURCE_BIN=${TERMAG_TEST_PG_SOURCE_BIN:-$PG_BIN}
[ -x "$SOURCE_BIN/initdb" ] || { echo "TERMAG_TEST_PG_SOURCE_BIN: no initdb in $SOURCE_BIN"; exit 1; }

WORK="$(mktemp -d)"
cleanup() {
  "$PG_BIN/pg_ctl" -D "$WORK/pg" -m immediate stop >/dev/null 2>&1 || true
  "$SOURCE_BIN/pg_ctl" -D "$WORK/pg-source" -m immediate stop >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT

# The stand-in pg_restore: a client newer than every server here. pg_restore -d
# runs its script through psql the way the real one sends it to the server.
mkdir -p "$WORK/bin"
cat >"$WORK/bin/pg_restore" <<EOF
#!/bin/sh
conn=; take=
for a do
  shift
  if [ -n "\$take" ]; then conn=\$a; take=; continue; fi
  case \$a in -d) take=1; continue ;; esac
  set -- "\$@" "\$a"
done
future() { echo 'SET termag_test_future_setting = 0;'; cat; }
if [ -n "\$conn" ]; then
  "$PG_BIN/pg_restore" "\$@" -f - | future | "$PG_BIN/psql" -X -q -v ON_ERROR_STOP=1 -d "\$conn"
else
  "$PG_BIN/pg_restore" "\$@" | future
fi
EOF
chmod +x "$WORK/bin/pg_restore"
# TERMAG_TEST_REAL_CLIENT=1 leaves the stand-in out, for a run against real
# mismatched versions.
if [ -n "${TERMAG_TEST_REAL_CLIENT:-}" ]; then PATH="$PG_BIN:$PATH"; else PATH="$WORK/bin:$PG_BIN:$PATH"; fi
export PATH

failures=0
fail() {
  echo "FAIL: $1"
  echo "      want: $2"
  echo "      got:  $3"
  failures=$((failures + 1))
}
expect_status() { # <name> <want> <got>
  [ "$2" = "$3" ] || fail "$1" "exit $2" "exit $3 ($(tail -n 3 "$WORK/out" | tr '\n' ' '))"
}

# start_cluster <bin dir> <data dir> <first port>: prints the port it got. Next port
# up whenever the start fails: sh has no /dev/tcp to probe with.
start_cluster() {
  "$1/initdb" -D "$2" -U admin --auth=trust -E UTF8 >"$2.initdb.log" 2>&1 || { cat "$2.initdb.log" >&2; exit 1; }
  p=$3
  until "$1/pg_ctl" -D "$2" -l "$2.log" -w -o "-p $p -k $WORK -c listen_addresses=127.0.0.1" start >/dev/null 2>&1; do
    p=$((p + 1))
    [ "$p" -lt $(($3 + 50)) ] || { cat "$2.log" >&2; exit 1; }
  done
  echo "$p"
}
port=$(start_cluster "$PG_BIN" "$WORK/pg" 55600) || exit 1
sport=$(start_cluster "$SOURCE_BIN" "$WORK/pg-source" $((port + 1))) || exit 1

adm() { psql -X -q -v ON_ERROR_STOP=1 -At -h 127.0.0.1 -p "$port" -U admin "$@"; }
sadm() { psql -X -q -v ON_ERROR_STOP=1 -At -h 127.0.0.1 -p "$sport" -U admin "$@"; }
as_app() { psql -X -q -v ON_ERROR_STOP=1 -At -h 127.0.0.1 -p "$port" -U application -d termag "$@"; }

# A non-superuser master, as on RDS: CREATEROLE and CREATEDB, and the owner of the
# database the cluster was created with.
adm -d postgres -c 'CREATE ROLE rds_iam NOLOGIN' \
  -c 'CREATE ROLE administrator LOGIN CREATEROLE CREATEDB' -c 'GRANT rds_iam TO administrator WITH ADMIN OPTION' \
  -c 'CREATE DATABASE termag OWNER administrator'
sadm -d postgres -c 'CREATE DATABASE src'
echo "container: $(sadm -d src -c 'SHOW server_version'), Aurora: $(adm -d termag -c 'SHOW server_version'), client: $("$PG_BIN/psql" --version)"

# The source: a cut-down termag schema with an enum, a serial and a foreign key.
sadm -d src <<'SQL'
CREATE TYPE kind AS ENUM ('working', 'waiting', 'idle');
CREATE TABLE users (id text PRIMARY KEY, email text NOT NULL);
CREATE TABLE status_events (id serial PRIMARY KEY, user_id text NOT NULL REFERENCES users(id), kind kind NOT NULL);
CREATE TABLE session (sid varchar PRIMARY KEY, sess json NOT NULL, expire timestamp(6) NOT NULL);
INSERT INTO users VALUES ('u1', 'a@example.test'), ('u2', 'b@example.test');
INSERT INTO status_events (user_id, kind) SELECT 'u1', 'working' FROM generate_series(1, 25);
INSERT INTO session VALUES ('s1', '{}', now());
SQL

TOKEN='s3cr3t-iam-token-value'
export TERMAG_PG_CLIENT=local TERMAG_DATA_DIR="$WORK/data" TERMAG_SERVICE_CHECK=skip TERMAG_SOURCE_CONTAINER='' \
  TERMAG_SOURCE_HOST=127.0.0.1 TERMAG_SOURCE_PORT="$sport" TERMAG_SOURCE_DB=src TERMAG_SOURCE_USER=admin \
  TERMAG_TARGET_PORT="$port" TERMAG_TARGET_DB=termag TERMAG_TARGET_USER=migration \
  TERMAG_TARGET_SSLMODE=disable TERMAG_TARGET_TOKEN_CMD="echo $TOKEN"
mkdir -p "$WORK/data"
HOST=127.0.0.1

run() { bash "$SCRIPT" "$@" --host "$HOST" >"$WORK/out" 2>&1; echo $?; }
target_tables() { adm -d termag -c "SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public'"; }

# --- before the bootstrap --------------------------------------------------------
adm -d postgres -c 'CREATE ROLE migration LOGIN'
got=$(run preflight); expect_status "preflight refuses an un-bootstrapped target" 3 "$got"
grep -q 'bootstrap' "$WORK/out" || fail "preflight names the bootstrap" "a hint to run the bootstrap" "$(cat "$WORK/out")"
adm -d postgres -c 'DROP ROLE migration'

# --- the bootstrap, twice, as the non-superuser master ---------------------------
for pass in 1 2; do
  if ! psql -X -q -h 127.0.0.1 -p "$port" -U administrator -d termag -f "$BOOTSTRAP" >"$WORK/bootstrap.log" 2>&1; then
    fail "bootstrap pass $pass" "exit 0" "$(cat "$WORK/bootstrap.log")"
  fi
done
[ "$(adm -d termag -c "SELECT pg_get_userbyid(datdba) FROM pg_database WHERE datname = 'termag'")" = migration ] \
  || fail "bootstrap hands the database to migration" "owner migration" "$(adm -d termag -c "SELECT pg_get_userbyid(datdba) FROM pg_database WHERE datname = 'termag'")"
[ "$(adm -d termag -c "SELECT pg_has_role('application', 'rds_iam', 'member')")" = t ] \
  || fail "application is an IAM login" "member of rds_iam" "not a member"

got=$(run preflight); expect_status "preflight after the bootstrap" 0 "$got"

# --- rehearse --------------------------------------------------------------------
got=$(run rehearse); expect_status "rehearse" 0 "$got"
grep -q 'row counts match on all 3 tables' "$WORK/out" || fail "rehearse compares counts" "match on 3 tables" "$(cat "$WORK/out")"
[ "$(target_tables)" = 0 ] || fail "rehearse empties Aurora again" "0 tables" "$(target_tables)"

got=$(run rehearse --keep); expect_status "rehearse --keep" 0 "$got"
got=$(run migrate); expect_status "migrate refuses a non-empty Aurora" 3 "$got"
[ ! -e "$WORK/data/DATABASE_MOVED_TO_RDS" ] || fail "a refused migrate writes no marker" "no marker" "marker present"
got=$(run wipe); expect_status "wipe without --yes" 2 "$got"
got=$(run wipe --yes); expect_status "wipe --yes" 0 "$got"
[ "$(target_tables)" = 0 ] || fail "wipe empties Aurora" "0 tables" "$(target_tables)"

# --- migrate ---------------------------------------------------------------------
touch "$WORK/data/ALLOW_DOCKER_ROLLBACK"
got=$(run migrate); expect_status "migrate" 0 "$got"
[ -s "$WORK/data/DATABASE_MOVED_TO_RDS" ] || fail "migrate writes the marker" "DATABASE_MOVED_TO_RDS" "missing"
[ ! -e "$WORK/data/ALLOW_DOCKER_ROLLBACK" ] || fail "migrate clears a stale rollback allowance" "removed" "still there"
[ "$(adm -d termag -c 'SELECT count(*) FROM status_events')" = 25 ] || fail "migrate copies rows" "25 status_events" "$(adm -d termag -c 'SELECT count(*) FROM status_events')"
[ "$(adm -d termag -c "SELECT tableowner FROM pg_tables WHERE tablename = 'users'")" = migration ] \
  || fail "restored tables belong to migration" "migration" "$(adm -d termag -c "SELECT tableowner FROM pg_tables WHERE tablename = 'users'")"

# application: DML on restored tables and sequences, no DDL.
as_app -c "INSERT INTO status_events (user_id, kind) VALUES ('u2', 'idle')" >/dev/null 2>"$WORK/app.err" \
  || fail "application can insert (table and sequence grants)" "insert ok" "$(cat "$WORK/app.err")"
if as_app -c 'CREATE TABLE sneaky (id int)' >/dev/null 2>&1; then
  fail "application has no DDL" "CREATE TABLE refused" "CREATE TABLE succeeded"
fi
if as_app -c 'DROP TABLE session' >/dev/null 2>&1; then
  fail "application cannot drop tables" "DROP TABLE refused" "DROP TABLE succeeded"
fi

# --- verify, then roll back ------------------------------------------------------
got=$(run verify); expect_status "verify sees the application's insert" 4 "$got"
grep -q 'status_events' "$WORK/out" || fail "verify names the table" "status_events in the diff" "$(cat "$WORK/out")"

got=$(run rollback-to-docker); expect_status "rollback-to-docker" 0 "$got"
# A real 17 client against an older container: pg_restore 17's own transaction_timeout.
client_major=$("$PG_BIN/psql" -X -At -c 'SHOW server_version_num' -h 127.0.0.1 -p "$port" -U admin -d postgres | cut -c1-2)
if [ "$client_major" -ge 17 ] && [ "$(sadm -d postgres -c "SELECT count(*) FROM pg_settings WHERE name = 'transaction_timeout'")" = 0 ]; then
  grep -q 'dropped, unknown to the target server: SET transaction_timeout' "$WORK/out" \
    || fail "a 17 client's transaction_timeout is dropped for the older container" "it listed as dropped" "$(cat "$WORK/out")"
fi
[ -n "${TERMAG_TEST_REAL_CLIENT:-}" ] || grep -q 'dropped, unknown to the target server: SET termag_test_future_setting' "$WORK/out" \
  || fail "the restore names the settings it dropped" "the stand-in's setting listed" "$(cat "$WORK/out")"
[ "$(sadm -d src -c 'SELECT count(*) FROM status_events')" = 26 ] || fail "rollback copies Aurora's writes back" "26 status_events" "$(sadm -d src -c 'SELECT count(*) FROM status_events')"
[ -s "$WORK/data/ALLOW_DOCKER_ROLLBACK" ] || fail "rollback allows the container again" "ALLOW_DOCKER_ROLLBACK" "missing"
got=$(run verify); expect_status "verify after rollback" 0 "$got"

# --- the token stays out of every output ------------------------------------------
for c in preflight verify; do
  bash "$SCRIPT" "$c" --host "$HOST" >>"$WORK/all.out" 2>&1 || true
done
cat "$WORK/out" >>"$WORK/all.out"
if grep -q "$TOKEN" "$WORK/all.out"; then
  fail "the token is never printed" "absent from output" "printed"
fi

got=$(bash "$SCRIPT" bogus --host x >"$WORK/out" 2>&1; echo $?); expect_status "unknown command" 2 "$got"
got=$(bash "$SCRIPT" preflight >"$WORK/out" 2>&1; echo $?); expect_status "missing --host" 2 "$got"

if [ "$failures" -gt 0 ]; then
  echo "$failures failure(s)"
  exit 1
fi
echo "all termag-rds-cutover tests passed"
