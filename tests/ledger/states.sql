\set ON_ERROR_STOP on
\i tests/ledger/fixture.sql
\i tests/ledger/helpers.sql

\echo '=============================================================='
\echo ' STATE MACHINES: listing, bid, receipt, certification'
\echo '=============================================================='

DO $$
DECLARE
  PREP  uuid := '11111111-0000-0000-0000-000000000001';
  SUPP  uuid := '11111111-0000-0000-0000-000000000003';
  BANK  uuid := '11111111-0000-0000-0000-000000000004';
  FUND  uuid := '11111111-0000-0000-0000-000000000005';
  SELL  text := '0x509911000000000000000000000000000000f88a';
  BUY   text := '0x1e4de40000000000000000000000000000004b13';
  BUY2  text := '0xfe5700000000000000000000000000000000d902';
  PAY   uuid := '9a000000-0000-0000-0000-000000000141';
  LIST  uuid := '7a000000-0000-0000-0000-000000000101';
  LIST2 uuid := '7a000000-0000-0000-0000-000000000102';
  v_bid1 uuid := 'b0000000-0000-0000-0000-000000000101';
  v_bid2 uuid := 'b0000000-0000-0000-0000-000000000102';
  v_state text;
  v_n bigint;
  v_anchor uuid := 'e0000000-0000-0000-0000-0000000000a1';
BEGIN
  PERFORM ledger.post(jsonb_build_object(
    'idempotencyKey','e1000000-0000-0000-0000-000000000001','actorUserId',SUPP,
    'intent', jsonb_build_object('kind','publish_listing','listingId', LIST,
      'payableId', PAY, 'sellerWallet', SELL, 'quantityBase', 500000000, 'minPriceBase', 489250000)));
  SELECT status::text INTO v_state FROM app.listing WHERE id = LIST;
  IF v_state <> 'open' THEN RAISE EXCEPTION 'FAIL: listing started as %', v_state; END IF;

  PERFORM ledger.post(jsonb_build_object(
    'idempotencyKey','e1000000-0000-0000-0000-000000000002','actorUserId',SUPP,
    'intent', jsonb_build_object('kind','cancel_listing','listingId', LIST)));
  SELECT status::text INTO v_state FROM app.listing WHERE id = LIST;
  IF v_state <> 'cancelled' THEN RAISE EXCEPTION 'FAIL: cancel left listing %', v_state; END IF;
  RAISE NOTICE 'PASS  listing none → open → cancelled';

  BEGIN
    PERFORM ledger.post(jsonb_build_object(
      'idempotencyKey','e1000000-0000-0000-0000-000000000003','actorUserId',BANK,
      'intent', jsonb_build_object('kind','place_bid','listingId', LIST,
        'bidderWallet', BUY, 'priceBase', 489250000, 'fundingCode','USDC')));
    RAISE EXCEPTION 'FAIL: bid on a cancelled listing';
  EXCEPTION WHEN sqlstate 'ADA11' THEN
    RAISE NOTICE 'PASS  a cancelled listing refuses a bid';
  END;

  PERFORM ledger.post(jsonb_build_object(
    'idempotencyKey','e1000000-0000-0000-0000-000000000004','actorUserId',SUPP,
    'intent', jsonb_build_object('kind','publish_listing','listingId', LIST2,
      'payableId', PAY, 'sellerWallet', SELL, 'quantityBase', 500000000, 'minPriceBase', 489250000)));
  PERFORM ledger.post(jsonb_build_object(
    'idempotencyKey','e1000000-0000-0000-0000-000000000005','actorUserId',BANK,
    'intent', jsonb_build_object('kind','place_bid','bidId', v_bid1, 'listingId', LIST2,
      'bidderWallet', BUY, 'priceBase', 489250000, 'fundingCode','USDC')));
  PERFORM ledger.post(jsonb_build_object(
    'idempotencyKey','e1000000-0000-0000-0000-000000000006','actorUserId',FUND,
    'intent', jsonb_build_object('kind','place_bid','bidId', v_bid2, 'listingId', LIST2,
      'bidderWallet', BUY2, 'priceBase', 489250000, 'fundingCode','XSGD')));
  PERFORM ledger.post(jsonb_build_object(
    'idempotencyKey','e1000000-0000-0000-0000-000000000007','actorUserId',SUPP,
    'intent', jsonb_build_object('kind','accept_bid','listingId', LIST2, 'bidId', v_bid1)));

  SELECT status::text INTO v_state FROM app.listing WHERE id = LIST2;
  IF v_state <> 'filled' THEN RAISE EXCEPTION 'FAIL: filled listing is %', v_state; END IF;
  SELECT status::text INTO v_state FROM app.bid WHERE id = v_bid1;
  IF v_state <> 'accepted' THEN RAISE EXCEPTION 'FAIL: winning bid is %', v_state; END IF;
  SELECT status::text INTO v_state FROM app.bid WHERE id = v_bid2;
  IF v_state <> 'superseded' THEN RAISE EXCEPTION 'FAIL: losing bid is %', v_state; END IF;
  RAISE NOTICE 'PASS  listing open → filled; losing bid placed → superseded';

  BEGIN
    PERFORM ledger.post(jsonb_build_object(
      'idempotencyKey','e1000000-0000-0000-0000-000000000008','actorUserId',SUPP,
      'intent', jsonb_build_object('kind','accept_bid','listingId', LIST2, 'bidId', v_bid2)));
    RAISE EXCEPTION 'FAIL: accepted a bid on a filled listing';
  EXCEPTION WHEN sqlstate 'ADA11' THEN
    RAISE NOTICE 'PASS  a filled listing refuses a second accept';
  END;

  PERFORM ledger.post(jsonb_build_object(
    'idempotencyKey','e1000000-0000-0000-0000-000000000009','actorUserId',SUPP,
    'intent', jsonb_build_object('kind','publish_listing','listingId','7a000000-0000-0000-0000-000000000103',
      'payableId', PAY, 'sellerWallet', SELL, 'quantityBase', 250000000, 'minPriceBase', 244625000)));
  PERFORM ledger.post(jsonb_build_object(
    'idempotencyKey','e1000000-0000-0000-0000-00000000000a','actorUserId',BANK,
    'intent', jsonb_build_object('kind','place_bid','bidId','b0000000-0000-0000-0000-000000000103',
      'listingId','7a000000-0000-0000-0000-000000000103',
      'bidderWallet', BUY, 'priceBase', 244625000, 'fundingCode','USDC')));
  PERFORM ledger.post(jsonb_build_object(
    'idempotencyKey','e1000000-0000-0000-0000-00000000000b','actorUserId',BANK,
    'intent', jsonb_build_object('kind','withdraw_bid','bidId','b0000000-0000-0000-0000-000000000103')));
  SELECT status::text INTO v_state FROM app.bid WHERE id = 'b0000000-0000-0000-0000-000000000103';
  IF v_state <> 'withdrawn' THEN RAISE EXCEPTION 'FAIL: withdrawn bid is %', v_state; END IF;
  RAISE NOTICE 'PASS  bid placed → withdrawn';

  PERFORM ledger.post(jsonb_build_object(
    'idempotencyKey','e1000000-0000-0000-0000-00000000000c','actorUserId',PREP,
    'intent', jsonb_build_object('kind','set_certification','entityId', v_anchor,
      'status','suspended')));
  SELECT certification_status::text INTO v_state FROM app.entity WHERE id = v_anchor;
  IF v_state <> 'suspended' THEN RAISE EXCEPTION 'FAIL: suspend left %', v_state; END IF;
  PERFORM ledger.post(jsonb_build_object(
    'idempotencyKey','e1000000-0000-0000-0000-00000000000d','actorUserId',PREP,
    'intent', jsonb_build_object('kind','set_certification','entityId', v_anchor,
      'status','certified')));
  SELECT certification_status::text INTO v_state FROM app.entity WHERE id = v_anchor;
  IF v_state <> 'certified' THEN RAISE EXCEPTION 'FAIL: recertify left %', v_state; END IF;
  RAISE NOTICE 'PASS  certification certified → suspended → certified';

  IF (SELECT count(*) FROM ledger.prove_books_balance()) <> 0 THEN
    RAISE EXCEPTION 'FAIL: the books drifted';
  END IF;
  RAISE NOTICE 'PASS  the books balance after the state walks';
  RAISE NOTICE '--- STATE MACHINES HOLD ---';
END $$;
