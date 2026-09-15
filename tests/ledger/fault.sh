#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../.."

URL="$(scripts/db.sh url)"
scripts/db.sh bare >/dev/null
psql "$URL" -q -v ON_ERROR_STOP=1 -f tests/ledger/fixture.sql >/dev/null

fail() { echo "FAIL: $1" >&2; exit 1; }
pass() { echo "PASS  $1"; }

SUPP='0x509911000000000000000000000000000000f88a'
BANK='0x1e4de40000000000000000000000000000004b13'
PAYABLE='9a000000-0000-0000-0000-000000000141'

echo "=== rollback of a posted transfer leaves no movement ==="

BEFORE=$(psql "$URL" -t -A -c "SELECT COALESCE(SUM(quantity_base),0) FROM ledger.v_holding WHERE wallet_address='$SUPP'")

psql "$URL" -q -v ON_ERROR_STOP=1 >/tmp/fault-rollback.log 2>&1 <<SQL
BEGIN;
SELECT ledger.post(jsonb_build_object(
  'idempotencyKey','f1000000-0000-0000-0000-000000000001','actorUserId','11111111-0000-0000-0000-000000000003',
  'intent', jsonb_build_object('kind','transfer','payableId','$PAYABLE',
                               'fromWallet','$SUPP','toWallet','$BANK','quantityBase',1000000000)));
ROLLBACK;
SQL

AFTER=$(psql "$URL" -t -A -c "SELECT COALESCE(SUM(quantity_base),0) FROM ledger.v_holding WHERE wallet_address='$SUPP'")
[ "$BEFORE" = "$AFTER" ] || fail "a rolled-back transfer still moved quantity ($BEFORE -> $AFTER)"
pass "rolling back the caller transaction undoes the post"

echo "=== terminate the backend mid-transaction ==="

psql "$URL" -q -v ON_ERROR_STOP=1 >/tmp/fault-sleep.log 2>&1 <<SQL &
BEGIN;
SELECT ledger.post(jsonb_build_object(
  'idempotencyKey','f1000000-0000-0000-0000-000000000002','actorUserId','11111111-0000-0000-0000-000000000003',
  'intent', jsonb_build_object('kind','transfer','payableId','$PAYABLE',
                               'fromWallet','$SUPP','toWallet','$BANK','quantityBase',500000000)));
SELECT pg_sleep(8);
COMMIT;
SQL
SLEEP_PID=$!
sleep 0.4
BACKEND=$(psql "$URL" -t -A -c "SELECT pid FROM pg_stat_activity WHERE pid <> pg_backend_pid() AND state = 'active' AND query ILIKE '%pg_sleep%' LIMIT 1")
if [ -n "$BACKEND" ]; then
  psql "$URL" -q -c "SELECT pg_terminate_backend($BACKEND)" >/dev/null
fi
wait "$SLEEP_PID" || true

KILLED=$(psql "$URL" -t -A -c "SELECT COALESCE(SUM(quantity_base),0) FROM ledger.v_holding WHERE wallet_address='$SUPP'")
[ "$BEFORE" = "$KILLED" ] || fail "a killed in-flight transfer still moved quantity ($BEFORE -> $KILLED)"
pass "killing the backend mid-transaction leaves holdings unchanged"

echo "=== the same idempotency key is a replay, not a second payment ==="

psql "$URL" -q -v ON_ERROR_STOP=1 >/dev/null <<SQL
SELECT ledger.post(jsonb_build_object(
  'idempotencyKey','f1000000-0000-0000-0000-000000000003','actorUserId','11111111-0000-0000-0000-000000000003',
  'intent', jsonb_build_object('kind','transfer','payableId','$PAYABLE',
                               'fromWallet','$SUPP','toWallet','$BANK','quantityBase',250000000)));
SQL
ONCE=$(psql "$URL" -t -A -c "SELECT COALESCE(SUM(quantity_base),0) FROM ledger.v_holding WHERE wallet_address='$SUPP'")
REPLAY=$(psql "$URL" -t -A -c "SELECT (ledger.post(jsonb_build_object(
  'idempotencyKey','f1000000-0000-0000-0000-000000000003','actorUserId','11111111-0000-0000-0000-000000000003',
  'intent', jsonb_build_object('kind','transfer','payableId','$PAYABLE',
                               'fromWallet','$SUPP','toWallet','$BANK','quantityBase',250000000))))->>'replayed'")
TWICE=$(psql "$URL" -t -A -c "SELECT COALESCE(SUM(quantity_base),0) FROM ledger.v_holding WHERE wallet_address='$SUPP'")
[ "$REPLAY" = "true" ] || [ "$REPLAY" = "t" ] || fail "the second post with the same key was not marked replayed (got '$REPLAY')"
[ "$ONCE" = "$TWICE" ] || fail "a replayed transfer moved quantity a second time ($ONCE -> $TWICE)"
pass "a retried confirmation replays the receipt and does not pay twice"

DRIFT=$(psql "$URL" -t -A -c "SELECT count(*) FROM ledger.prove_books_balance()")
[ "$DRIFT" = "0" ] || fail "the books drifted after fault injection"
pass "the books still balance"

echo "PASS  fault injection"
