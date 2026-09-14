-- Series lot integrity: cost basis, bid/listing binding, and maturity settlement.
--
-- The seeded world already has SERIES-2026-Q4-30D listed as twelve 15,000
-- invoices. These cases are the ones a presenter hits: a lender buys the lot,
-- the portfolio must not 12× the purchase price, and advancing 30 days must
-- still let ADATA redeem the whole lot even if it is listed.
\set ON_ERROR_STOP on

\echo '=============================================================='
\echo ' SERIES: cost basis, bid binding, lot redemption'
\echo '=============================================================='

DO $$
DECLARE
  BANK        text := '0x1e4de40000000000000000000000000000004b13';
  BANK_USER   uuid := '11111111-0000-0000-0000-000000000006';
  SELLER_USER uuid := '11111111-0000-0000-0000-000000000004';
  PREP        uuid := '11111111-0000-0000-0000-000000000001';
  SERIES      uuid := '5e000000-0000-0000-0000-000000000430';
  LISTING     uuid := '7a000000-0000-0000-0000-000000000430';
  LOT_PRICE   bigint := 1785600000;     -- 178,560.0000 XUSD, 99.20% of 180,000
  MEMBER_QTY  bigint := 150000000;      -- 15,000.0000 each
  v_bid       uuid;
  v_bid_other uuid;
  v_listing   uuid;
  v_member    uuid;
  v_n         bigint;
  v_min       bigint;
  v_max       bigint;
  v_sum       bigint;
  v_before    bigint;
  v_after     bigint;
BEGIN
  ---------------------------------------------------- 1. bid belongs to listing --
  -- A bid on TP-2026-0142 applied to TP-2026-0141 would debit 0142's price and
  -- move 0141's tokens. That is the theft the listing_id recheck exists to stop.
  SELECT li.id INTO v_listing
    FROM app.listing li JOIN app.payable p ON p.id = li.target_payable_id
   WHERE p.ref = 'TP-2026-0141' AND li.status = 'open';
  SELECT b.id INTO v_bid_other
    FROM app.bid b
    JOIN app.listing li ON li.id = b.listing_id
    JOIN app.payable p ON p.id = li.target_payable_id
   WHERE p.ref = 'TP-2026-0142' AND b.status = 'placed'
   LIMIT 1;
  IF v_listing IS NULL OR v_bid_other IS NULL THEN
    RAISE EXCEPTION 'FAIL: seed is missing the 0141 listing or a 0142 bid';
  END IF;

  BEGIN
    PERFORM ledger.post(jsonb_build_object(
      'idempotencyKey','dddd0000-0000-0000-0000-000000000001','actorUserId', SELLER_USER,
      'intent', jsonb_build_object('kind','accept_bid','listingId', v_listing, 'bidId', v_bid_other)));
    RAISE EXCEPTION 'FAIL: accepted a bid that belonged to a different listing';
  EXCEPTION WHEN sqlstate 'ADA11' THEN
    RAISE NOTICE 'PASS  a bid cannot settle a listing it was not placed on';
  END;

  IF (SELECT status FROM app.listing WHERE id = v_listing) <> 'open' THEN
    RAISE EXCEPTION 'FAIL: a mismatched accept closed the victim listing';
  END IF;
  IF (SELECT status FROM app.bid WHERE id = v_bid_other) <> 'placed' THEN
    RAISE EXCEPTION 'FAIL: a mismatched accept consumed the foreign bid';
  END IF;

  ---------------------------------------------------- 2. series cost basis --
  PERFORM ledger.post(jsonb_build_object(
    'idempotencyKey','dddd0000-0000-0000-0000-000000000002','actorUserId', BANK_USER,
    'intent', jsonb_build_object('kind','place_bid','listingId', LISTING,
      'bidderWallet', BANK, 'priceBase', LOT_PRICE, 'fundingCode', 'USDC')));
  SELECT id INTO v_bid FROM app.bid
   WHERE listing_id = LISTING AND status = 'placed' AND bidder_wallet = BANK;
  PERFORM ledger.post(jsonb_build_object(
    'idempotencyKey','dddd0000-0000-0000-0000-000000000003','actorUserId', SELLER_USER,
    'intent', jsonb_build_object('kind','accept_bid','listingId', LISTING, 'bidId', v_bid)));

  SELECT count(*), min(price_base), max(price_base), sum(price_base)
    INTO v_n, v_min, v_max, v_sum
    FROM ledger.v_trade
   WHERE listing_id = LISTING AND buyer_wallet = BANK;

  IF v_n <> 12 THEN
    RAISE EXCEPTION 'FAIL: series trade produced % cost-basis rows, expected 12', v_n;
  END IF;
  -- 178,560 / 12 = 14,880 exactly. Each member must carry that share, not the
  -- 178,560 lot price (which would make every 15,000 invoice look bought at
  -- ~1,190% of face and 12× the cash deployed).
  IF v_min <> LOT_PRICE / 12 OR v_max <> LOT_PRICE / 12 THEN
    RAISE EXCEPTION 'FAIL: member cost basis is %..% , expected % each (lot was %)',
      v_min, v_max, LOT_PRICE / 12, LOT_PRICE;
  END IF;
  IF v_sum <> LOT_PRICE THEN
    RAISE EXCEPTION 'FAIL: member cost bases sum to %, expected the lot price %', v_sum, LOT_PRICE;
  END IF;
  IF (SELECT quantity_base FROM ledger.v_holding
       WHERE wallet_address = BANK AND payable_id = (
         SELECT id FROM app.payable WHERE series_id = SERIES ORDER BY id LIMIT 1
       )) <> MEMBER_QTY THEN
    RAISE EXCEPTION 'FAIL: the buyer does not hold a series member';
  END IF;
  RAISE NOTICE 'PASS  series purchase allocates the lot price across members';

  -------------------------------------- 3. redeem a listed series as one lot --
  -- Relist so settlement has to unwind a 12-leg escrow. This is the booth
  -- failure: +30 days with the series still on the market, then Fund settlement.
  PERFORM ledger.post(jsonb_build_object(
    'idempotencyKey','dddd0000-0000-0000-0000-000000000004','actorUserId', BANK_USER,
    'intent', jsonb_build_object('kind','publish_listing','seriesId', SERIES,
      'sellerWallet', BANK, 'minPriceBase', LOT_PRICE)));
  IF (SELECT count(*) FROM app.listing_leg ll
        JOIN app.listing li ON li.id = ll.listing_id
       WHERE li.target_series_id = SERIES AND li.status = 'open') <> 12 THEN
    RAISE EXCEPTION 'FAIL: relisted series does not escrow all 12 members';
  END IF;

  PERFORM ledger.post(jsonb_build_object(
    'idempotencyKey','dddd0000-0000-0000-0000-000000000005','actorUserId', PREP,
    'intent', jsonb_build_object('kind','advance_clock','days', 30)));

  SELECT id INTO v_member FROM app.payable WHERE series_id = SERIES ORDER BY id LIMIT 1;
  SELECT b.balance INTO v_before
    FROM ledger.account_balance b
    JOIN ledger.account a ON a.id = b.account_id
    JOIN ledger.asset s ON s.id = b.asset_id
   WHERE a.wallet_address = BANK AND s.cash_code = 'XUSD';

  PERFORM ledger.post(jsonb_build_object(
    'idempotencyKey','dddd0000-0000-0000-0000-000000000006','actorUserId', PREP,
    'intent', jsonb_build_object('kind','settle_maturity','payableId', v_member)));

  SELECT count(*) INTO v_n FROM app.payable
   WHERE series_id = SERIES AND lifecycle_status = 'settled';
  IF v_n <> 12 THEN
    RAISE EXCEPTION 'FAIL: settled % series members, expected all 12', v_n;
  END IF;

  SELECT b.balance INTO v_after
    FROM ledger.account_balance b
    JOIN ledger.account a ON a.id = b.account_id
    JOIN ledger.asset s ON s.id = b.asset_id
   WHERE a.wallet_address = BANK AND s.cash_code = 'XUSD';
  IF v_after - v_before <> 1800000000 THEN
    RAISE EXCEPTION 'FAIL: the holder was credited %, expected the 180,000 lot face',
      v_after - v_before;
  END IF;

  IF EXISTS (
    SELECT 1 FROM app.listing WHERE target_series_id = SERIES AND status = 'open'
  ) THEN
    RAISE EXCEPTION 'FAIL: the series listing is still open after redemption';
  END IF;

  IF (SELECT count(*) FROM ledger.prove_books_balance()) <> 0 THEN
    RAISE EXCEPTION 'FAIL: books drifted after series settlement';
  END IF;

  BEGIN
    PERFORM ledger.post(jsonb_build_object(
      'idempotencyKey','dddd0000-0000-0000-0000-000000000007','actorUserId', PREP,
      'intent', jsonb_build_object('kind','settle_maturity','payableId', v_member)));
    RAISE EXCEPTION 'FAIL: the series lot settled twice';
  EXCEPTION WHEN sqlstate 'ADA16' THEN
    RAISE NOTICE 'PASS  a settled series member cannot settle again';
  END;

  RAISE NOTICE 'PASS  settling one series member redeems the whole listed lot';
END $$;
