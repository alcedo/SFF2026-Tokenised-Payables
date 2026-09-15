#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../.."

URL="$(scripts/db.sh url)"
scripts/db.sh bare >/dev/null
psql "$URL" -q -v ON_ERROR_STOP=1 -f tests/ledger/fixture.sql >/dev/null

SUPP='0x509911000000000000000000000000000000f88a'
BANK='0x1e4de40000000000000000000000000000004b13'
FUND='0xfe5700000000000000000000000000000000d902'
PAYABLE='9a000000-0000-0000-0000-000000000141'
FACE=2500000000

fail() { echo "FAIL: $1" >&2; exit 1; }

echo "=== two sessions transfer the full holding, overlapping ==="

psql "$URL" -q -v ON_ERROR_STOP=1 >/tmp/xferA.log 2>&1 <<SQL &
BEGIN;
SELECT ledger.post(jsonb_build_object(
  'idempotencyKey','c2000000-0000-0000-0000-000000000001','actorUserId','11111111-0000-0000-0000-000000000003',
  'intent', jsonb_build_object('kind','transfer','payableId','$PAYABLE',
                               'fromWallet','$SUPP','toWallet','$BANK','quantityBase',$FACE)));
SELECT pg_sleep(2);
COMMIT;
SQL
A_PID=$!
sleep 0.7

set +e
psql "$URL" -q -v ON_ERROR_STOP=1 >/tmp/xferB.log 2>&1 <<SQL
BEGIN;
SELECT ledger.post(jsonb_build_object(
  'idempotencyKey','c2000000-0000-0000-0000-000000000002','actorUserId','11111111-0000-0000-0000-000000000003',
  'intent', jsonb_build_object('kind','transfer','payableId','$PAYABLE',
                               'fromWallet','$SUPP','toWallet','$FUND','quantityBase',$FACE)));
COMMIT;
SQL
B_STATUS=$?
set -e
wait $A_PID || true

[ "$B_STATUS" -ne 0 ] || fail "both transfers of the full holding succeeded"
grep -qE 'ERROR' /tmp/xferB.log || fail "session B reported no error"

HOLDERS=$(psql "$URL" -t -A -c "SELECT count(*) FROM ledger.v_holding WHERE payable_id='$PAYABLE' AND quantity_base > 0")
BANK_Q=$(psql "$URL" -t -A -c "SELECT COALESCE(SUM(quantity_base),0) FROM ledger.v_holding WHERE wallet_address='$BANK' AND payable_id='$PAYABLE'")
FUND_Q=$(psql "$URL" -t -A -c "SELECT COALESCE(SUM(quantity_base),0) FROM ledger.v_holding WHERE wallet_address='$FUND' AND payable_id='$PAYABLE'")
SUPP_Q=$(psql "$URL" -t -A -c "SELECT COALESCE(SUM(quantity_base),0) FROM ledger.v_holding WHERE wallet_address='$SUPP' AND payable_id='$PAYABLE'")
TOTAL=$(psql "$URL" -t -A -c "SELECT COALESCE(SUM(quantity_base),0) FROM ledger.v_holding WHERE payable_id='$PAYABLE'")
DRIFT=$(psql "$URL" -t -A -c "SELECT count(*) FROM ledger.prove_books_balance()")

[ "$TOTAL" = "$FACE" ] || fail "holdings sum to $TOTAL, not the face $FACE"
[ "$DRIFT" = "0" ] || fail "books drifted"
[ "$SUPP_Q" = "0" ] || fail "seller still holds $SUPP_Q after a full transfer"
if [ "$BANK_Q" = "$FACE" ]; then
  [ "$FUND_Q" = "0" ] || fail "both lenders received quantity"
  echo "PASS  session A won; session B was refused; face is conserved"
elif [ "$FUND_Q" = "$FACE" ]; then
  [ "$BANK_Q" = "0" ] || fail "both lenders received quantity"
  echo "PASS  session B won; session A was refused; face is conserved"
else
  fail "neither lender holds the full face (bank=$BANK_Q fund=$FUND_Q holders=$HOLDERS)"
fi
