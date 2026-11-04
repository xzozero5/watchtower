#!/usr/bin/env bash
# Watchtower: restore drill. Restores a dump made by backup.sh into a THROWAWAY Postgres container and
# checks the result (T-306d, docs/runbooks/pilot-instance.md). It never connects to the running stack.
#
#   tools/restore-drill/restore-drill.sh /path/to/watchtower-20261105-101500.dump
#   tools/restore-drill/restore-drill.sh dump.dump --source-container watchtower-postgres-1
#
# What it does: starts its own container (unique name, NO published port, trust auth inside it only),
# creates the roles the dump refers to, runs pg_restore with --exit-on-error, then checks that
#   - the pgvector extension and the migrations table are there,
#   - every table in `public` was restored, and (with --source-container) every row count equals the
#     source's (--source-container is read with SELECT count(*) only),
#   - the audit log and the two AI switches exist, and no intent is above autonomy stage 2.
# The container is removed on exit (--keep leaves it for you to look at; remove it yourself).
# Exit code: 0 = every check passed, 1 = a check failed, 2 = bad usage.
set -euo pipefail
export MSYS_NO_PATHCONV=1 MSYS2_ARG_CONV_EXCL='*'

image="${DRILL_PG_IMAGE:-pgvector/pgvector:0.8.7-pg16-trixie}" # the same image as docker-compose.yml
dump=""
source_container=""
source_user="${POSTGRES_USER:-watchtower}"
source_db="${POSTGRES_DB:-watchtower}"
keep=0

usage() {
  echo "usage: restore-drill.sh <dump-file> [--source-container <name>] [--image <pg image>] [--keep]" >&2
  exit 2
}
while [ $# -gt 0 ]; do
  case "$1" in
    --source-container) source_container="${2:-}"; shift 2 ;;
    --image) image="${2:-}"; shift 2 ;;
    --keep) keep=1; shift ;;
    -h | --help) usage ;;
    -*) usage ;;
    *) [ -z "$dump" ] || usage; dump="$1"; shift ;;
  esac
done
[ -n "$dump" ] && [ -s "$dump" ] || { echo "drill: dump file not found or empty" >&2; usage; }

name="wt-restore-drill-$$"
user="drill"
db="restored"
fail=0
pass() { echo "  PASS  $*"; }
bad() { echo "  FAIL  $*"; fail=1; }
psql_in() { docker exec "$name" psql -U "$user" -d "$db" -v ON_ERROR_STOP=1 -X -q -t -A "$@"; }

cleanup() {
  if [ "$keep" = 1 ]; then
    echo "drill: container '$name' kept (docker rm -f $name when done)"
  else
    docker rm -f -v "$name" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

echo "drill: starting throwaway container $name from $image (no published port)"
docker run -d --name "$name" -e POSTGRES_USER="$user" -e POSTGRES_HOST_AUTH_METHOD=trust \
  -e POSTGRES_DB=postgres "$image" >/dev/null
ready=0
for _ in $(seq 1 60); do
  # The image restarts postgres once after init, so wait for a real query, not only pg_isready.
  if docker exec "$name" psql -U "$user" -d postgres -X -q -t -A -c 'select 1' >/dev/null 2>&1; then
    ready=$((ready + 1))
    [ "$ready" -ge 3 ] && break
  else
    ready=0
  fi
  sleep 1
done
[ "$ready" -ge 3 ] || { echo "drill: the throwaway postgres did not come up" >&2; exit 1; }

echo "drill: copying the dump into the container"
docker exec -i "$name" sh -c 'cat > /tmp/restore.dump' <"$dump"

echo "drill: creating the roles the dump refers to (NOLOGIN, no password)"
# Roles are cluster-level, so pg_dump does not carry them. A real restore gets them from the `migrate`
# service; here we read them out of the GRANT/OWNER lines of the dump.
docker exec "$name" pg_restore --schema-only -f /tmp/schema.sql /tmp/restore.dump
roles="$(docker exec "$name" sh -c "grep -E '^(GRANT|REVOKE|ALTER .* OWNER TO|ALTER DEFAULT PRIVILEGES)' /tmp/schema.sql" |
  grep -oE '(TO|FROM|OWNER TO|FOR ROLE|IN SCHEMA [a-z_]+ GRANT [A-Z, ]+ ON [A-Z]+ TO) +\"?[a-z_][a-z0-9_]*\"?' |
  sed -E 's/.* +//; s/"//g' | grep -vE '^(PUBLIC|public|CURRENT_USER|CURRENT_ROLE|SESSION_USER|drill)$' | sort -u || true)"
for role in $roles; do
  docker exec "$name" psql -U "$user" -d postgres -X -q -c "CREATE ROLE \"$role\" NOLOGIN" >/dev/null 2>&1 || true
done
echo "drill: roles: $(echo "$roles" | tr '\n' ' ')"

docker exec "$name" createdb -U "$user" "$db"
echo "drill: pg_restore --exit-on-error"
if docker exec "$name" pg_restore -U "$user" -d "$db" --exit-on-error --no-password /tmp/restore.dump 2>/tmp/restore-drill.err.$$; then
  pass "pg_restore finished with no error"
else
  bad "pg_restore failed: $(head -c 600 /tmp/restore-drill.err.$$)"
fi
rm -f /tmp/restore-drill.err.$$

echo "drill: checks"
ext="$(psql_in -c "select count(*) from pg_extension where extname = 'vector'")"
[ "$ext" = 1 ] && pass "extension vector is installed" || bad "extension vector is missing"

migrations="$(psql_in -c "select count(*) from __watchtower_migrations" 2>/dev/null || echo 0)"
[ "${migrations:-0}" -gt 0 ] && pass "migrations table holds $migrations applied migrations" || bad "no applied migrations in __watchtower_migrations"

tables="$(psql_in -c "select count(*) from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE'")"
[ "${tables:-0}" -gt 20 ] && pass "$tables tables restored in schema public" || bad "only ${tables:-0} tables in public"

aiswitch="$(psql_in -c "select count(*) from ai_switch where key in ('ai_kill_switch', 'ai_stage_cap_pinned')" 2>/dev/null || echo 0)"
[ "$aiswitch" = 2 ] && pass "both AI switches exist" || bad "AI switches missing"
audit="$(psql_in -c "select count(*) from audit_log" 2>/dev/null || echo missing)"
case "$audit" in '' | missing) bad "audit_log not readable" ;; *) pass "audit_log readable ($audit rows)" ;; esac

above="$(psql_in -c "select count(*) from intent where autonomy_stage > 2" 2>/dev/null || echo missing)"
case "$above" in
  0) pass "no intent is above autonomy stage 2" ;;
  missing) bad "cannot read intent.autonomy_stage" ;;
  *) bad "$above intent(s) above autonomy stage 2 in this dump" ;;
esac

if [ -n "$source_container" ]; then
  echo "drill: comparing row counts with '$source_container' (SELECT count(*) only)"
  docker inspect --format '{{.State.Running}}' "$source_container" 2>/dev/null | grep -q true ||
    { bad "source container '$source_container' is not running"; source_container=""; }
fi
if [ -n "$source_container" ]; then
  # One query per side: "table=count" for every table of `public` (partitions are counted through their parent).
  counts_sql="select c.relname || '=' || (xpath('/row/c/text()', query_to_xml(format('select count(*) as c from public.%I', c.relname), false, true, '')))[1]::text
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind in ('r', 'p') and not c.relispartition order by 1"
  here="$(psql_in -c "$counts_sql")"
  there="$(docker exec "$source_container" psql -U "$source_user" -d "$source_db" -X -q -t -A -c "$counts_sql" 2>/dev/null || echo unreadable)"
  checked="$(printf '%s\n' "$here" | grep -c '=' || true)"
  differences="$(diff <(printf '%s\n' "$here") <(printf '%s\n' "$there") || true)"
  if [ -z "$differences" ] && [ "$checked" -gt 0 ]; then
    pass "row counts match the source in all $checked tables"
  else
    bad "row counts differ from the source: $(printf '%s' "$differences" | head -c 600)"
  fi
fi

echo
if [ "$fail" = 0 ]; then
  echo "drill: PASS (the dump restores into a clean Postgres)"
else
  echo "drill: FAIL (see above)"
fi
exit "$fail"
