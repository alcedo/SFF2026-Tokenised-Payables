#!/usr/bin/env bash
# Build and serve the app against a freshly seeded world.
#
#   scripts/serve.sh          reset, build, start, wait until it answers
#   scripts/serve.sh --keep   same but leave the existing world alone
#
# Exists because doing this by hand is three commands in an order that matters:
# building while a server is running replaces .next underneath it, and the
# running process then serves a route table that no longer matches the files.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

PORT="${PORT:-3100}"
KEEP=0
[ "${1:-}" = "--keep" ] && KEEP=1

pkill -f "next-server" 2>/dev/null || true
pkill -f "next start" 2>/dev/null || true
sleep 1

if [ "$KEEP" -eq 0 ]; then
	scripts/db.sh reset >/dev/null
fi
export DATABASE_URL="${DATABASE_URL:-$(scripts/db.sh url)}"

npx next build >/tmp/next-build.log 2>&1 || {
	echo "build failed:" >&2
	tail -30 /tmp/next-build.log >&2
	exit 1
}

nohup env DATABASE_URL="$DATABASE_URL" npx next start -p "$PORT" >/tmp/next.log 2>&1 &

for _ in $(seq 1 40); do
	if curl -fsS -o /dev/null "http://127.0.0.1:${PORT}/lender" 2>/dev/null; then
		echo "serving on http://127.0.0.1:${PORT}"
		exit 0
	fi
	sleep 0.5
done

echo "server did not come up; see /tmp/next.log" >&2
tail -20 /tmp/next.log >&2
exit 1
