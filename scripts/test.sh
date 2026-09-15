#!/usr/bin/env bash
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
export PATH="/usr/lib/postgresql/16/bin:${PATH}"

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
stage "pricing, lifecycle, clock, fields (vitest)" npx vitest run
stage "typecheck" npx tsc --noEmit
stage "mutation: core parsers and formulas" node scripts/mutate.mjs

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
RESET_ARG=bare sql_stage "fixtures: the world a fresh database boots into" tests/ledger/fixtures.sql
RESET_ARG=reset sql_stage "lifecycle: ERP invoice to issued token" tests/ledger/lifecycle.sql
RESET_ARG=reset sql_stage "accounts: onboarding, personas, removal" tests/ledger/accounts.sql
RESET_ARG=reset sql_stage "programme: limits and issuer certification" tests/ledger/programme.sql
RESET_ARG=bare sql_stage "runbook: issue, list, bid, accept, advance, settle" tests/ledger/runbook.sql
RESET_ARG=bare sql_stage "invariants: the things PRD 14 says must not happen" tests/ledger/invariants.sql
RESET_ARG=bare sql_stage "decision table: fields and compliance" tests/ledger/decision-table.sql
RESET_ARG=bare sql_stage "state machines: listing, bid, certification" tests/ledger/states.sql
stage "concurrency: two lenders race one listing" tests/ledger/concurrency.sh
stage "concurrency: two transfers of the same holding" tests/ledger/concurrency-transfer.sh
stage "fault injection: rollback, kill, replay" tests/ledger/fault.sh

echo
if [ "$FAILED" -eq 0 ]; then
	printf '\033[32mall green\033[0m\n'
else
	printf '\033[31msomething failed\033[0m\n'
fi
exit "$FAILED"
