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

# Schema and no world row, which is the state src/db/ensure.ts is written for.
#
# Deliberately NOT `scripts/db.sh ensure` here, even though that verb would load
# db/fixtures.sql in one line. Doing it with psql first leaves ensureWorld()
# nothing to do: classify() returns 'ready' on the server's first query and
# bootstrap() returns before it takes the lock. The run would prove the fixture
# data is right and prove nothing about the mechanism a hosted deployment
# actually uses. The requests below are what load the file, through the driver,
# inside beginWorldLoad's transaction, exactly as a cold instance does.
#
# DATABASE_URL is cleared so an exported dev connection string cannot redirect
# any of this onto the world someone is demoing.
env -u DATABASE_URL DB_NAME="$FRESH_DB" scripts/db.sh bare >/dev/null
URL="$(env -u DATABASE_URL DB_NAME="$FRESH_DB" scripts/db.sh url)"

if [ "${SKIP_BUILD:-}" != "1" ]; then
	npx next build >/tmp/fresh-build.log 2>&1 || {
		echo "build failed:" >&2
		tail -30 /tmp/fresh-build.log >&2
		exit 1
	}
fi

# Free this port and only this port. `npx next start` runs the real server as a
# grandchild, so killing the pid that $! returns leaves an orphaned next-server
# holding the socket: the next run then fails to bind, its requests reach the
# stale server, and that server answers from a database this script has since
# dropped and recreated. Scoped to $PORT so the :3100 server stays up.
free_port() {
	fuser -k -TERM -n tcp "$PORT" >/dev/null 2>&1 || true
	for _ in $(seq 1 20); do
		fuser -s -n tcp "$PORT" 2>/dev/null || return 0
		sleep 0.25
	done
	fuser -k -n tcp "$PORT" >/dev/null 2>&1 || true
	sleep 0.5
}

free_port
trap free_port EXIT

nohup env DATABASE_URL="$URL" npx next start -p "$PORT" >/tmp/fresh-next.log 2>&1 &

# Wait for the port to accept a connection without sending a request, so the
# bootstrap below really is the first one the server sees.
LISTENING=0
for _ in $(seq 1 60); do
	if (exec 3<>"/dev/tcp/127.0.0.1/${PORT}") 2>/dev/null; then
		LISTENING=1
		break
	fi
	sleep 0.5
done
if [ "$LISTENING" -ne 1 ]; then
	echo "nothing came up on :${PORT}; see /tmp/fresh-next.log" >&2
	tail -20 /tmp/fresh-next.log >&2
	exit 1
fi

# Three at once. ensure.ts serialises cold starts on a transaction-scoped
# advisory lock because two serverless instances can meet on the same empty
# database, and one request at a time would never reach that code. Whichever
# requests lose the race have to wait for the winner and then serve, rather than
# loading the fixtures a second time or failing.
BOOTSTRAP_LOG=/tmp/fresh-bootstrap.log
: >"$BOOTSTRAP_LOG"
REQUESTS=""
for i in 1 2 3; do
	(curl -fsS -o /dev/null --max-time 120 "http://127.0.0.1:${PORT}/lender" \
		&& echo "request $i ok" >>"$BOOTSTRAP_LOG" \
		|| echo "request $i FAILED" >>"$BOOTSTRAP_LOG") &
	REQUESTS="$REQUESTS $!"
done
# Named explicitly. A bare `wait` waits for every background job of this shell,
# and the server started above is one of them, so it would never return.
# shellcheck disable=SC2086
wait $REQUESTS

if grep -q FAILED "$BOOTSTRAP_LOG" || [ "$(grep -c ok "$BOOTSTRAP_LOG")" -ne 3 ]; then
	echo "the application failed to bootstrap an empty database:" >&2
	cat "$BOOTSTRAP_LOG" >&2
	tail -30 /tmp/fresh-next.log >&2
	exit 1
fi

# One world row, not three. A second pass through applyFixtures would duplicate
# the counterparties, and the lock is the only thing stopping it.
WORLDS="$(psql "$URL" -t -A -c 'SELECT count(*) FROM app.world')"
if [ "$WORLDS" != "1" ]; then
	echo "three concurrent cold starts left $WORLDS world rows, expected 1" >&2
	exit 1
fi

echo "the application bootstrapped an empty database under three concurrent first requests"
echo "serving the bootstrap world on http://127.0.0.1:${PORT}"
APP_URL="http://127.0.0.1:${PORT}" node scripts/demo.mjs
