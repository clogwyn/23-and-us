#!/usr/bin/env bash
# Spins up a throwaway Postgres, applies the shim + every migration, runs the security suite.
# Usage: packages/db/test/run.sh   (needs Postgres 15+ binaries on PATH or in /usr/lib/postgresql/*/bin)
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
mig="${MIGRATIONS_DIR:-$here/../supabase/migrations}"

PGBIN="$(dirname "$(command -v initdb 2>/dev/null || ls -d /usr/lib/postgresql/*/bin/initdb | tail -1)")"
tmp="$(mktemp -d)"
port=55432
# Postgres refuses to run as root (e.g. in CI containers); drop to the postgres user if needed.
as_pg=()
if [ "$(id -u)" -eq 0 ]; then chown postgres "$tmp"; as_pg=(runuser -u postgres --); fi
trap '"${as_pg[@]}" "$PGBIN/pg_ctl" -D "$tmp/data" -m immediate stop >/dev/null 2>&1 || true; rm -rf "$tmp"' EXIT

"${as_pg[@]}" "$PGBIN/initdb" -D "$tmp/data" -U postgres -A trust >/dev/null
"${as_pg[@]}" "$PGBIN/pg_ctl" -D "$tmp/data" -o "-p $port -k $tmp -c listen_addresses=''" -l "$tmp/log" start -w >/dev/null

psql_() { psql -h "$tmp" -p "$port" -U postgres -d postgres -v ON_ERROR_STOP=1 -q "$@"; }

psql_ -f "$here/supabase-shim.sql"
for f in "$mig"/*.sql; do
  echo "→ $(basename "$f")"
  psql_ -f "$f"
done
psql_ -f "$here/security.test.sql"
