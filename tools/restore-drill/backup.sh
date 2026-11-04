#!/usr/bin/env bash
# Watchtower: dump the Postgres database to a custom-format file (T-306d, docs/runbooks/pilot-instance.md).
#
#   tools/restore-drill/backup.sh --out /path/to/backups
#   tools/restore-drill/backup.sh --container watchtower-postgres-1 --out D:/Works/watchtower-backups
#
# Runs pg_dump INSIDE the postgres container (same version as the server) and writes the file on this host.
# It touches nothing in the database. The dump holds customer data and the integration credentials
# (encrypted under APP_ENCRYPTION_KEY, which is NOT in the dump): treat the file as a secret, keep it
# outside the repository, and keep the key somewhere else. Files in MinIO (attachments) are not in it.
#
# The password is never needed on the command line: pg_dump runs as the postgres user over the
# container's local socket. Nothing here prints a secret.
set -euo pipefail
export MSYS_NO_PATHCONV=1 MSYS2_ARG_CONV_EXCL='*' # Git Bash on Windows must not rewrite /paths given to docker

container="${WATCHTOWER_PG_CONTAINER:-watchtower-postgres-1}"
user="${POSTGRES_USER:-watchtower}"
db="${POSTGRES_DB:-watchtower}"
out=""
label=""

usage() {
  echo "usage: backup.sh --out <dir> [--container <name>] [--user <pg user>] [--db <name>] [--label <text>]" >&2
  exit 2
}
while [ $# -gt 0 ]; do
  case "$1" in
    --out) out="${2:-}"; shift 2 ;;
    --container) container="${2:-}"; shift 2 ;;
    --user) user="${2:-}"; shift 2 ;;
    --db) db="${2:-}"; shift 2 ;;
    --label) label="${2:-}"; shift 2 ;;
    -h | --help) usage ;;
    *) usage ;;
  esac
done
[ -n "$out" ] || usage
case "$label" in *[!A-Za-z0-9._-]*) echo "label: letters, digits, . _ - only" >&2; exit 2 ;; esac

docker inspect --format '{{.State.Running}}' "$container" 2>/dev/null | grep -q true || {
  echo "backup: container '$container' is not running (set --container, or WATCHTOWER_PG_CONTAINER)" >&2
  exit 1
}
mkdir -p "$out"
stamp="$(date -u '+%Y%m%d-%H%M%S')"
file="$out/watchtower-${stamp}${label:+-$label}.dump"
partial="$file.partial"
trap 'rm -f "$partial"' EXIT

umask 077
docker exec "$container" pg_dump -U "$user" -d "$db" --format=custom --no-password >"$partial"
[ -s "$partial" ] || { echo "backup: the dump is empty" >&2; exit 1; }
# The archive must be readable by pg_restore before we call it a backup.
entries="$(docker exec -i "$container" pg_restore -l <"$partial" | grep -c ' TABLE DATA ' || true)"
[ "$entries" -gt 0 ] || { echo "backup: pg_restore cannot read the dump or it has no table data" >&2; exit 1; }
mv "$partial" "$file"
trap - EXIT
bytes="$(wc -c <"$file" | tr -d ' ')"
echo "backup: ok $file ($bytes bytes, $entries tables with data)"
echo "backup: next, prove it restores: tools/restore-drill/restore-drill.sh \"$file\""
