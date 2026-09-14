#!/usr/bin/env bash
# Serve the world a freshly provisioned host boots into, and drive it.
#
#   scripts/fresh.sh              load a fixtures-only database, serve it, drive it
#   SKIP_BUILD=1 scripts/fresh.sh  reuse the .next tree already on disk
#
# There are two ways a database becomes usable. Reset world replays db/seed.sql
# and gets the full PRD §12 catalogue. A host that has never been seeded takes
# the other path: src/db/ensure.ts loads db/fixtures.sql on the first request
# and nothing else, which is what a new Vercel or Neon deployment gets and what
# a visitor meets before anyone presses Reset.
#
# Every other driver runs against the seeded world, so without this the
# bootstrap path is only ever exercised in production, by the audience.
#
# Runs its own server rather than calling scripts/serve.sh, which pkills every
# next-server on the box before it honours --keep. Borrowing it here would kill
# the :3100 server the README tells you to start, so this brings up its own on
# its own port and takes it down again on the way out.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

PORT="${PORT:-3101}"
FRESH_DB="${FRESH_DB:-adata_fresh}"

# `ensure` is the same verb src/db/ensure.ts implements: schema if missing, then
# db/fixtures.sql, and nothing at all if a world row is already there. DATABASE_URL
# is cleared for both calls so an exported dev connection string cannot redirect
# them onto the world someone is demoing.
env -u DATABASE_URL DB_NAME="$FRESH_DB" scripts/db.sh bare >/dev/null
env -u DATABASE_URL DB_NAME="$FRESH_DB" scripts/db.sh ensure >/dev/null
URL="$(env -u DATABASE_URL DB_NAME="$FRESH_DB" scripts/db.sh url)"

if [ "${SKIP_BUILD:-}" != "1" ]; then
	npx next build >/tmp/fresh-build.log 2>&1 || {
		echo "build failed:" >&2
		tail -30 /tmp/fresh-build.log >&2
		exit 1
	}
fi

nohup env DATABASE_URL="$URL" npx next start -p "$PORT" >/tmp/fresh-next.log 2>&1 &
SERVER=$!
trap 'kill "$SERVER" 2>/dev/null || true' EXIT

for _ in $(seq 1 40); do
	curl -fsS -o /dev/null "http://127.0.0.1:${PORT}/lender" 2>/dev/null && break
	sleep 0.5
done
if ! curl -fsS -o /dev/null "http://127.0.0.1:${PORT}/lender" 2>/dev/null; then
	echo "fresh server did not come up on :${PORT}; see /tmp/fresh-next.log" >&2
	tail -20 /tmp/fresh-next.log >&2
	exit 1
fi

echo "serving the bootstrap world on http://127.0.0.1:${PORT}"
APP_URL="http://127.0.0.1:${PORT}" node scripts/demo.mjs
