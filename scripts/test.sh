#!/usr/bin/env bash
# Everything, in one command. This is what CI runs and what a contributor runs
# before pushing. Each stage resets the database, so they cannot contaminate
# one another and the order does not matter.
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

FAILED=0
pass() { printf '\033[32m  ok\033[0m  %s\n' "$1"; }
fail() { printf '\033[31mFAIL\033[0m  %s\n' "$1"; FAILED=1; }

stage() {
	local name="$1"
	shift
	if "$@" >/tmp/stage.log 2>&1; then
		pass "$name"
	else
		fail "$name"
		tail -25 /tmp/stage.log | sed 's/^/      /'
	fi
}

# A SQL stage fails on any psql error, and also on a FAIL notice raised by an
# assertion block, which psql itself reports as success.
sql_stage() {
	local name="$1" file="$2"
	"${RESET_CMD:-scripts/db.sh}" "${RESET_ARG:-reset}" >/tmp/stage.log 2>&1 || {
		fail "$name (database reset)"
		tail -20 /tmp/stage.log | sed 's/^/      /'
		return
	}
	if psql "$(scripts/db.sh url)" -q -v ON_ERROR_STOP=1 -f "$file" >/tmp/stage.log 2>&1 &&
		! grep -qE '^psql.*(ERROR|FATAL)|FAIL:' /tmp/stage.log; then
		pass "$name"
		grep -oE 'PASS .*' /tmp/stage.log | sed 's/^/      /'
	else
		fail "$name"
		grep -E 'ERROR|FAIL' /tmp/stage.log | head -10 | sed 's/^/      /'
	fi
}

echo "── unit ─────────────────────────────────────────────"
stage "pricing, lifecycle, clock (vitest)" npx vitest run
stage "typecheck" npx tsc --noEmit

echo "── schema ───────────────────────────────────────────"
scripts/db.sh reset >/dev/null 2>&1
# schema.sql §12: no float or arbitrary-precision decimal in the money path.
FLOATS=$(psql "$(scripts/db.sh url)" -t -A -c "
  SELECT count(*) FROM information_schema.columns
   WHERE table_schema IN ('app','ledger')
     AND data_type IN ('double precision','real','numeric')
     AND NOT (table_name = 'asset' AND column_name = 'token_id');" 2>/dev/null)
if [ "${FLOATS:-x}" = "0" ]; then
	pass "no floating point anywhere in the money path"
else
	fail "$FLOATS money columns are float or numeric"
fi

echo "── ledger ───────────────────────────────────────────"
RESET_ARG=reset sql_stage "seed matches PRD section 12" tests/ledger/seed.sql
RESET_ARG=reset sql_stage "lifecycle: ERP invoice to issued token" tests/ledger/lifecycle.sql
RESET_ARG=bare sql_stage "runbook: issue, list, bid, accept, advance, settle" tests/ledger/runbook.sql
RESET_ARG=bare sql_stage "invariants: the things PRD 14 says must not happen" tests/ledger/invariants.sql
stage "concurrency: two lenders race one listing" tests/ledger/concurrency.sh

echo
if [ "$FAILED" -eq 0 ]; then
	printf '\033[32mall green\033[0m\n'
else
	printf '\033[31msomething failed\033[0m\n'
fi
exit "$FAILED"
