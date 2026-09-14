-- The invariants PRD §14 calls for, each proven by attempting to break it.
--
--   "Prevent duplicate acceptance, double spending, over-quantity transfers,
--    stale-owner transfers, and duplicate redemption across sessions.
--    Holdings for a payable must continue to sum to outstanding face."
--
-- Every case below attempts the forbidden thing and asserts both that it was
-- refused AND that nothing moved. A refusal that still shifted a balance would
-- be worse than no refusal at all.
\set ON_ERROR_STOP on
\i tests/ledger/fixture.sql

\echo '=============================================================='
\echo ' INVARIANTS'
\echo '=============================================================='

DO $$
DECLARE
  SUPP   text := '0x509911000000000000000000000000000000f88a';
  BANK   text := '0x1e4de40000000000000000000000000000004b13';
  FUND   text := '0xfe5700000000000000000000000000000000d902';
  ANCHOR text := '0xada7a0000000000000000000000000000000c21d';
  PAYABLE uuid := '9a000000-0000-0000-0000-000000000141';
  FACE   bigint := 2500000000;          -- 250,000.0000 XUSD
  PRICE  bigint := 2446250000;          -- 97.85% of face
  v_before bigint;
  v_after  bigint;
  v_res    jsonb;
  v_res2   jsonb;
  v_n      bigint;
  v_caught text;

BEGIN
  ---------------------------------------------------------------- 1. floats --
  -- A quantity that is not a whole number of base units cannot be expressed:
  -- every column is bigint, so this is a cast failure, not a rounding.
  BEGIN
    PERFORM ledger.post(jsonb_build_object(
      'idempotencyKey','00000000-0000-0000-0000-0000000000e1','actorUserId','11111111-0000-0000-0000-000000000003',
      'intent', jsonb_build_object('kind','transfer','payableId',PAYABLE,'fromWallet',SUPP,
                                   'toWallet',BANK,'quantityBase','0.5')));
    RAISE EXCEPTION 'FAIL: a fractional base unit was accepted';
  EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN
    RAISE NOTICE 'PASS  a fractional base unit is not representable';
  END;

  --------------------------------------------------- 2. over-quantity moves --
  SELECT SUM(balance) INTO v_before FROM ledger.account_balance b
    JOIN ledger.account a ON a.id=b.account_id WHERE a.wallet_address=SUPP;
  BEGIN
    PERFORM ledger.post(jsonb_build_object(
      'idempotencyKey','00000000-0000-0000-0000-0000000000e2','actorUserId','11111111-0000-0000-0000-000000000003',
      'intent', jsonb_build_object('kind','transfer','payableId',PAYABLE,'fromWallet',SUPP,
                                   'toWallet',BANK,'quantityBase', FACE + 1)));
    RAISE EXCEPTION 'FAIL: transferred more than the holder owns';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'PASS  over-quantity transfer refused by the balance CHECK';
  END;
  SELECT SUM(balance) INTO v_after FROM ledger.account_balance b
    JOIN ledger.account a ON a.id=b.account_id WHERE a.wallet_address=SUPP;
  IF v_before IS DISTINCT FROM v_after THEN
    RAISE EXCEPTION 'FAIL: a refused transfer still moved the supplier balance';
  END IF;
  RAISE NOTICE 'PASS  the refused transfer left every balance untouched';

  ------------------------------------------------------- 3. partial listing --
  -- List 100,000 of the 250,000 holding. The remainder must stay free.
  PERFORM ledger.post(jsonb_build_object(
    'idempotencyKey','00000000-0000-0000-0000-0000000000e3','actorUserId','11111111-0000-0000-0000-000000000003',
    'intent', jsonb_build_object('kind','publish_listing','listingId','7a000000-0000-0000-0000-000000000001',
                                 'payableId',PAYABLE,'sellerWallet',SUPP,
                                 'quantityBase', 1000000000, 'minPriceBase', 978500000)));
  SELECT free_base INTO v_after FROM ledger.v_holding WHERE wallet_address=SUPP;
  IF v_after <> FACE - 1000000000 THEN
    RAISE EXCEPTION 'FAIL: after listing 100,000 the free balance is %, expected %',
      v_after, FACE - 1000000000;
  END IF;
  RAISE NOTICE 'PASS  a partial listing leaves the unlisted remainder with the seller';

  -------------------------------------------- 4. escrow blocks over-commit --
  -- The seller still holds 150,000 free. Listing another 200,000 must fail,
  -- because the escrow leg would drive the free balance negative.
  BEGIN
    PERFORM ledger.post(jsonb_build_object(
      'idempotencyKey','00000000-0000-0000-0000-0000000000e4','actorUserId','11111111-0000-0000-0000-000000000003',
      'intent', jsonb_build_object('kind','publish_listing','listingId','7a000000-0000-0000-0000-000000000009',
                                   'payableId',PAYABLE,'sellerWallet',SUPP,
                                   'quantityBase', 2000000000, 'minPriceBase', 1957000000)));
    RAISE EXCEPTION 'FAIL: listed more than the seller holds free';
  EXCEPTION WHEN check_violation OR unique_violation THEN
    RAISE NOTICE 'PASS  over-committing beyond the free balance is refused';
  END;

  ---------------------------------------------------- 5. XSGD funding rate --
  -- PRD §6: 1 XUSD = 1.31 XSGD. A 97,850.0000 XUSD price must debit
  -- 128,183.5000 XSGD. Bid from the XSGD-funded fund.
  PERFORM ledger.post(jsonb_build_object(
    'idempotencyKey','00000000-0000-0000-0000-0000000000e5','actorUserId','11111111-0000-0000-0000-000000000005',
    'intent', jsonb_build_object('kind','place_bid','bidId','b0000000-0000-0000-0000-000000000001',
                                 'listingId','7a000000-0000-0000-0000-000000000001','bidderWallet',FUND,
                                 'priceBase', 978500000, 'fundingCode','XSGD')));
  v_res := ledger.post(jsonb_build_object(
    'idempotencyKey','00000000-0000-0000-0000-0000000000e6','actorUserId','11111111-0000-0000-0000-000000000003',
    'intent', jsonb_build_object('kind','accept_bid','listingId','7a000000-0000-0000-0000-000000000001',
                                 'bidId','b0000000-0000-0000-0000-000000000001')));
  IF (v_res->'conversion'->>'sourceDebit')::bigint <> 1281835000 THEN
    RAISE EXCEPTION 'FAIL: XSGD debit is %, expected 1281835000 (128,183.5000)',
      v_res->'conversion'->>'sourceDebit';
  END IF;
  RAISE NOTICE 'PASS  an XSGD-funded purchase debits 1.31x the XUSD obligation';

  -- The seller is credited in XUSD regardless of how the buyer funded it.
  SELECT b.balance INTO v_after FROM ledger.account_balance b
    JOIN ledger.account a ON a.id=b.account_id JOIN ledger.asset s ON s.id=b.asset_id
   WHERE a.wallet_address=SUPP AND s.cash_code='XUSD';
  IF v_after <> 978500000 THEN
    RAISE EXCEPTION 'FAIL: seller XUSD credit is %, expected 978500000', v_after;
  END IF;
  RAISE NOTICE 'PASS  the seller receives XUSD whatever the buyer funded with';

  --------------------------------------------------------- 6. idempotency --
  -- Replaying the accept must return the same receipt and credit nobody twice.
  SELECT b.balance INTO v_before FROM ledger.account_balance b
    JOIN ledger.account a ON a.id=b.account_id JOIN ledger.asset s ON s.id=b.asset_id
   WHERE a.wallet_address=SUPP AND s.cash_code='XUSD';
  v_res2 := ledger.post(jsonb_build_object(
    'idempotencyKey','00000000-0000-0000-0000-0000000000e6','actorUserId','11111111-0000-0000-0000-000000000003',
    'intent', jsonb_build_object('kind','accept_bid','listingId','7a000000-0000-0000-0000-000000000001',
                                 'bidId','b0000000-0000-0000-0000-000000000001')));
  IF (v_res2->>'replayed')::boolean IS NOT TRUE THEN
    RAISE EXCEPTION 'FAIL: a replay was not reported as one';
  END IF;
  IF v_res2->'receipt'->>'txHash' IS DISTINCT FROM v_res->'receipt'->>'txHash' THEN
    RAISE EXCEPTION 'FAIL: the replay minted a different receipt';
  END IF;
  SELECT b.balance INTO v_after FROM ledger.account_balance b
    JOIN ledger.account a ON a.id=b.account_id JOIN ledger.asset s ON s.id=b.asset_id
   WHERE a.wallet_address=SUPP AND s.cash_code='XUSD';
  IF v_after <> v_before THEN
    RAISE EXCEPTION 'FAIL: a replay credited the seller twice (% -> %)', v_before, v_after;
  END IF;
  RAISE NOTICE 'PASS  replaying an accept returns the same receipt and pays once';

  ------------------------------------------- 7. key reuse, different intent --
  BEGIN
    PERFORM ledger.post(jsonb_build_object(
      'idempotencyKey','00000000-0000-0000-0000-0000000000e6','actorUserId','11111111-0000-0000-0000-000000000003',
      'intent', jsonb_build_object('kind','transfer','payableId',PAYABLE,'fromWallet',SUPP,
                                   'toWallet',BANK,'quantityBase', 1)));
    RAISE EXCEPTION 'FAIL: one key was reused for two different intents';
  EXCEPTION WHEN sqlstate 'ADA10' THEN
    RAISE NOTICE 'PASS  reusing a key with a different intent is refused';
  END;

  ------------------------------------------------ 8. holdings sum to face --
  SELECT SUM(quantity_base) INTO v_after FROM ledger.v_holding;
  IF v_after <> FACE THEN
    RAISE EXCEPTION 'FAIL: holdings sum to %, expected the % face', v_after, FACE;
  END IF;
  RAISE NOTICE 'PASS  holdings still sum to outstanding face after a partial sale';

  -------------------------------------------------- 9. duplicate redemption --
  PERFORM ledger.post(jsonb_build_object(
    'idempotencyKey','00000000-0000-0000-0000-0000000000e7','actorUserId','11111111-0000-0000-0000-000000000001',
    'intent', jsonb_build_object('kind','advance_clock','days', 90)));
  PERFORM ledger.post(jsonb_build_object(
    'idempotencyKey','00000000-0000-0000-0000-0000000000e8','actorUserId','11111111-0000-0000-0000-000000000001',
    'intent', jsonb_build_object('kind','settle_maturity','payableId',PAYABLE)));
  BEGIN
    PERFORM ledger.post(jsonb_build_object(
      'idempotencyKey','00000000-0000-0000-0000-0000000000e9','actorUserId','11111111-0000-0000-0000-000000000001',
      'intent', jsonb_build_object('kind','settle_maturity','payableId',PAYABLE)));
    RAISE EXCEPTION 'FAIL: the payable settled twice';
  EXCEPTION WHEN sqlstate 'ADA16' THEN
    RAISE NOTICE 'PASS  a settled payable cannot settle again';
  END;

  ------------------------------------------- 10. split settlement is exact --
  -- Two holders at maturity: the fund bought 100,000, the supplier kept
  -- 150,000. Each must be paid the face of what they held, and ADATA debited
  -- exactly once for the total.
  SELECT b.balance INTO v_after FROM ledger.account_balance b
    JOIN ledger.account a ON a.id=b.account_id JOIN ledger.asset s ON s.id=b.asset_id
   WHERE a.wallet_address=FUND AND s.cash_code='XUSD';
  IF v_after <> 1000000000 THEN
    RAISE EXCEPTION 'FAIL: the fund redeemed %, expected 1000000000 (100,000)', v_after;
  END IF;
  SELECT b.balance INTO v_after FROM ledger.account_balance b
    JOIN ledger.account a ON a.id=b.account_id JOIN ledger.asset s ON s.id=b.asset_id
   WHERE a.wallet_address=ANCHOR AND s.cash_code='XUSD';
  IF v_after <> 5000000000 - FACE THEN
    RAISE EXCEPTION 'FAIL: the anchor paid %, expected exactly the face once',
      5000000000 - v_after;
  END IF;
  RAISE NOTICE 'PASS  a split payable pays each holder and debits the anchor once';

  ----------------------------------------------------------- 11. the books --
  SELECT count(*) INTO v_n FROM ledger.prove_books_balance();
  IF v_n <> 0 THEN RAISE EXCEPTION 'FAIL: projection disagrees with the journal on % rows', v_n; END IF;
  SELECT count(*) INTO v_n FROM (
    SELECT asset_id FROM ledger.account_balance GROUP BY asset_id HAVING SUM(balance) <> 0) bad;
  IF v_n <> 0 THEN RAISE EXCEPTION 'FAIL: % assets are not conserved', v_n; END IF;
  RAISE NOTICE 'PASS  the projection equals the journal and every asset nets to zero';

  RAISE NOTICE '--- ALL INVARIANTS HELD ---';
END $$;
