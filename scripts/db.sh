#!/usr/bin/env bash
# Local Postgres for development and tests.
#
#   scripts/db.sh up      start the server (idempotent)
#   scripts/db.sh reset   drop, recreate, reload the schema and seed
#   scripts/db.sh bare    the same without the seed, for tests with their own fixture
#   scripts/db.sh ensure  schema + fixtures only if app.world is missing
#   scripts/db.sh psql    open a shell on the dev database
#   scripts/db.sh url     print the connection string
#
# Production uses a hosted Postgres via DATABASE_URL. This script exists so a
# contributor and CI both get the same schema without a manual sequence of psql
# invocations, and so "reset" is one command rather than a remembered ritual.
set -euo pipefail

DB_NAME="${DB_NAME:-adata}"
PGPORT="${PGPORT:-5432}"
PGDATA="${PGDATA:-/var/lib/postgresql/demo-pgdata}"
PGBIN="${PGBIN:-$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | sort -V | tail -1)}"
ADMIN_URL="postgresql://postgres@127.0.0.1:${PGPORT}/postgres"
DEV_URL="postgresql://postgres@127.0.0.1:${PGPORT}/${DB_NAME}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

up() {
	if pg_isready -h 127.0.0.1 -p "$PGPORT" >/dev/null 2>&1; then return 0; fi
	if [ ! -s "$PGDATA/PG_VERSION" ]; then
		mkdir -p "$PGDATA"
		chown postgres:postgres "$PGDATA"
		chmod 700 "$PGDATA"
		su postgres -c "$PGBIN/initdb -D $PGDATA -U postgres --auth=trust -E UTF8" >/tmp/initdb.log 2>&1
	fi
	su postgres -c "$PGBIN/pg_ctl -D $PGDATA -l /tmp/pg.log -o '-p $PGPORT -k /tmp' start" >/tmp/pg-start.log 2>&1 || true
	for _ in $(seq 1 20); do
		pg_isready -h 127.0.0.1 -p "$PGPORT" >/dev/null 2>&1 && return 0
		sleep 0.5
	done
	echo "postgres did not come up; see /tmp/pg.log" >&2
	tail -20 /tmp/pg.log >&2 || true
	exit 1
}

reset() {
	up
	# FORCE detaches any session still holding the database, so a reset never
	# blocks on a psql shell someone left open in another terminal.
	psql "$ADMIN_URL" -q -c "DROP DATABASE IF EXISTS ${DB_NAME} WITH (FORCE);" >/dev/null
	psql "$ADMIN_URL" -q -c "CREATE DATABASE ${DB_NAME};" >/dev/null
	psql "$DEV_URL" -q -v ON_ERROR_STOP=1 -f "$ROOT/db/schema.sql" -f "$ROOT/db/post.sql" >/tmp/schema-load.log 2>&1 || {
		echo "schema failed to load:" >&2
		grep -E 'ERROR|FATAL' /tmp/schema-load.log >&2 | head -20
		exit 1
	}
	if [ -f "$ROOT/db/seed.sql" ] && [ "${SKIP_SEED:-}" != "1" ]; then
		psql "$DEV_URL" -q -v ON_ERROR_STOP=1 -f "$ROOT/db/seed.sql" >/tmp/seed-load.log 2>&1 || {
			echo "seed failed to load:" >&2
			grep -E 'ERROR|FATAL' /tmp/seed-load.log >&2 | head -20
			exit 1
		}
	fi
	echo "${DB_NAME} reset"
}

ensure() {
	local url="${DATABASE_URL:-}"
	if [ -z "$url" ]; then
		up
		url="$DEV_URL"
	fi
	local has_world
	has_world="$(psql "$url" -t -A -v ON_ERROR_STOP=1 -c "SELECT EXISTS (
		SELECT 1 FROM pg_class c
		JOIN pg_namespace n ON n.oid = c.relnamespace
		WHERE n.nspname = 'app' AND c.relname = 'world'
	)")"
	if [ "$has_world" != "t" ]; then
		psql "$url" -q -v ON_ERROR_STOP=1 -1 \
			-f "$ROOT/db/schema.sql" -f "$ROOT/db/post.sql" >/tmp/ensure-schema.log 2>&1 || {
			echo "ensure failed to load schema:" >&2
			grep -E 'ERROR|FATAL' /tmp/ensure-schema.log >&2 | head -20
			exit 1
		}
	fi
	local has_row
	has_row="$(psql "$url" -t -A -v ON_ERROR_STOP=1 -c "SELECT EXISTS (SELECT 1 FROM app.world)")"
	if [ "$has_row" = "t" ]; then
		echo "world already present; skip"
		return 0
	fi
	psql "$url" -q -v ON_ERROR_STOP=1 -1 -f "$ROOT/db/fixtures.sql" >/tmp/ensure-fixtures.log 2>&1 || {
		echo "ensure failed to load fixtures:" >&2
		grep -E 'ERROR|FATAL' /tmp/ensure-fixtures.log >&2 | head -20
		exit 1
	}
	echo "loaded programme fixtures into empty database"
}

case "${1:-up}" in
up) up ;;
reset) reset ;;
bare)
	SKIP_SEED=1 reset
	;;
ensure) ensure ;;
psql)
	up
	shift
	psql "$DEV_URL" "$@"
	;;
url) echo "$DEV_URL" ;;
*)
	echo "usage: scripts/db.sh {up|reset|bare|ensure|psql|url}" >&2
	exit 1
	;;
esac
