#!/usr/bin/env bash
# Two lenders accept the same listing at the same instant.
#
# PRD §14 calls duplicate acceptance the thing that must not happen, and the
# brief calls it the worst possible failure in front of a bank. This drives it
# with two real connections rather than reasoning about it.
#
# It also pins the EvalPlanQual behaviour that ledger.post()'s header warns
# about: the loser must come back with a readable "listing is filled", not with
# zero rows, which would surface as a mystery 404 on stage.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../.."

URL="$(scripts/db.sh url)"
scripts/db.sh reset >/dev/null
psql "$URL" -q -v ON_ERROR_STOP=1 -f tests/ledger/fixture.sql >/dev/null

SUPP='0x509911000000000000000000000000000000f88a'
BANK='0x1e4de40000000000000000000000000000004b13'
FUND='0xfe5700000000000000000000000000000000d902'
PAYABLE='9a000000-0000-0000-0000-000000000141'
LISTING='7a000000-0000-0000-0000-000000000001'

# One listing, two competing bids at the same price.
psql "$URL" -q -v ON_ERROR_STOP=1 >/dev/null <<SQL
SELECT ledger.post(jsonb_build_object(
  'idempotencyKey','00000000-0000-0000-0000-00000000c001','actorUserId','11111111-0000-0000-0000-000000000003',
  'intent', jsonb_build_object('kind','publish_listing','listingId','$LISTING','payableId','$PAYABLE',
                               'sellerWallet','$SUPP','quantityBase',2500000000,'minPriceBase',2446250000)));
SELECT ledger.post(jsonb_build_object(
  'idempotencyKey','00000000-0000-0000-0000-00000000c002','actorUserId','11111111-0000-0000-0000-000000000004',
  'intent', jsonb_build_object('kind','place_bid','bidId','b0000000-0000-0000-0000-0000000000a1',
                               'listingId','$LISTING','bidderWallet','$BANK',
                               'priceBase',2446250000,'fundingCode','USDC')));
SELECT ledger.post(jsonb_build_object(
  'idempotencyKey','00000000-0000-0000-0000-00000000c003','actorUserId','11111111-0000-0000-0000-000000000005',
  'intent', jsonb_build_object('kind','place_bid','bidId','b0000000-0000-0000-0000-0000000000a2',
                               'listingId','$LISTING','bidderWallet','$FUND',
                               'priceBase',2446250000,'fundingCode','XSGD')));
SQL

echo "=== two sessions accept the same listing, overlapping ==="

# Session A takes the listing lock and holds it open for two seconds.
psql "$URL" -q -v ON_ERROR_STOP=1 >/tmp/sessionA.log 2>&1 <<SQL &
BEGIN;
SELECT ledger.post(jsonb_build_object(
  'idempotencyKey','00000000-0000-0000-0000-00000000c010','actorUserId','11111111-0000-0000-0000-000000000003',
  'intent', jsonb_build_object('kind','accept_bid','listingId','$LISTING',
                               'bidId','b0000000-0000-0000-0000-0000000000a1')));
SELECT pg_sleep(2);
COMMIT;
SQL
A_PID=$!

sleep 0.7   # long enough that B is certainly inside post() while A holds the lock

# Session B tries the competing bid on the same listing. It must block on the
# listing row, then, once A commits, see the filled status and refuse cleanly.
set +e
psql "$URL" -q -v ON_ERROR_STOP=1 >/tmp/sessionB.log 2>&1 <<SQL
BEGIN;
SELECT ledger.post(jsonb_build_object(
  'idempotencyKey','00000000-0000-0000-0000-00000000c011','actorUserId','11111111-0000-0000-0000-000000000003',
  'intent', jsonb_build_object('kind','accept_bid','listingId','$LISTING',
                               'bidId','b0000000-0000-0000-0000-0000000000a2')));
COMMIT;
SQL
B_STATUS=$?
set -e
wait $A_PID || true

echo "--- session A ---"; grep -E 'ERROR|ledger' /tmp/sessionA.log | head -3 || true
echo "--- session B ---"; grep -E 'ERROR' /tmp/sessionB.log | head -3 || true

fail() { echo "FAIL: $1" >&2; exit 1; }

[ "$B_STATUS" -ne 0 ] || fail "the second acceptance succeeded; both lenders got the payable"
grep -q 'ERROR' /tmp/sessionB.log || fail "session B reported no error"
grep -qE 'listing is filled' /tmp/sessionB.log \
  || fail "session B got an unreadable error instead of 'listing is filled' (EvalPlanQual regression?)"
echo "PASS  the loser was refused with a readable reason, not zero rows"

# Exactly one trade, one accepted bid, one superseded bid, and the books balance.
psql "$URL" -q -v ON_ERROR_STOP=1 -t <<'SQL' > /tmp/concurrency-check.txt
SELECT 'accepted=' || count(*) FROM app.bid WHERE status = 'accepted';
SELECT 'superseded=' || count(*) FROM app.bid WHERE status = 'superseded';
SELECT 'filled_listings=' || count(*) FROM app.listing WHERE status = 'filled';
SELECT 'holders=' || count(*) FROM ledger.v_holding;
SELECT 'projection_mismatches=' || count(*) FROM ledger.prove_books_balance();
SELECT 'unconserved_assets=' || count(*) FROM (
  SELECT asset_id FROM ledger.account_balance GROUP BY asset_id HAVING SUM(balance) <> 0) b;
SQL
tr -d ' ' < /tmp/concurrency-check.txt | grep -v '^$'

check() { grep -qx "$1" <(tr -d ' ' < /tmp/concurrency-check.txt) || fail "expected $1"; }
check 'accepted=1'
check 'superseded=1'
check 'filled_listings=1'
check 'holders=1'
check 'projection_mismatches=0'
check 'unconserved_assets=0'
echo "PASS  exactly one trade settled; the competing bid was superseded"
echo "PASS  the books balance after a contended accept"
