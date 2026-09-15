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

\i tests/ledger/helpers.sql

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
  ANCHOR_ID uuid := 'e0000000-0000-0000-0000-0000000000a1';
  SUPP_ID   uuid := 'e0000000-0000-0000-0000-0000000000a2';
  PAY_XSGD  uuid := '9a000000-0000-0000-0000-000000000161';
  PAY_USDC  uuid := '9a000000-0000-0000-0000-000000000162';
  PAY_SPLIT uuid := '9a000000-0000-0000-0000-000000000163';
  PAY_SHORT uuid := '9a000000-0000-0000-0000-000000000164';
  FACE_XSGD  bigint := 2000000000;      -- 200,000.0000 XUSD, 262,000.0000 XSGD at 1.31
  FACE_USDC  bigint := 600000000;       -- 60,000.0000 XUSD
  FACE_SPLIT bigint := 1500000150;      -- 150,000.0150 XUSD, held as three lots of 50,000.0050
  FACE_SHORT bigint := 400000000;       -- 40,000.0000 XUSD, 52,400 XSGD: more than ADATA has left
  v_before bigint;
  v_after  bigint;
  v_res    jsonb;
  v_res2   jsonb;
  v_n      bigint;
  v_other  bigint;
  v_caught text;
  v_was    RECORD;
  v_entry  RECORD;
  v_p      RECORD;

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
  EXCEPTION WHEN sqlstate 'ADA21' OR check_violation THEN
    RAISE NOTICE 'PASS  over-quantity transfer refused, naming the shortfall';
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
  EXCEPTION WHEN sqlstate 'ADA21' OR check_violation OR unique_violation THEN
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

  --------------------------------------------------------------- 9. buy now --
  -- PRD §8 screen 11. Buy-now is an acceptance the buyer performs against a
  -- price the seller published in advance, so it must settle exactly like an
  -- accepted bid and must be refused everywhere an acceptance would be.
  --
  -- One listing at a time: a seller may hold only one open listing per target,
  -- so the no-buy-now case below waits until this one is filled.
  PERFORM ledger.post(jsonb_build_object(
    'idempotencyKey','00000000-0000-0000-0000-0000000000f1','actorUserId','11111111-0000-0000-0000-000000000003',
    'intent', jsonb_build_object('kind','publish_listing','listingId','7a000000-0000-0000-0000-000000000002',
                                 'payableId',PAYABLE,'sellerWallet',SUPP,
                                 'quantityBase', 500000000, 'minPriceBase', 480000000,
                                 'buyNowPriceBase', 492500000)));

  -- The seller cannot take their own offer.
  BEGIN
    PERFORM ledger.post(jsonb_build_object(
      'idempotencyKey','00000000-0000-0000-0000-0000000000f4','actorUserId','11111111-0000-0000-0000-000000000003',
      'intent', jsonb_build_object('kind','buy_now','listingId','7a000000-0000-0000-0000-000000000002',
                                   'buyerWallet',SUPP,'fundingCode','XUSD')));
    RAISE EXCEPTION 'FAIL: the seller bought their own listing';
  EXCEPTION WHEN sqlstate 'ADA11' THEN
    RAISE NOTICE 'PASS  a seller cannot buy their own listing';
  END;

  -- The real purchase, funded in USDC at 1:1.
  SELECT b.balance INTO v_before FROM ledger.account_balance b
    JOIN ledger.account a ON a.id=b.account_id JOIN ledger.asset s ON s.id=b.asset_id
   WHERE a.wallet_address=SUPP AND s.cash_code='XUSD';
  v_res := ledger.post(jsonb_build_object(
    'idempotencyKey','00000000-0000-0000-0000-0000000000f5','actorUserId','11111111-0000-0000-0000-000000000004',
    'intent', jsonb_build_object('kind','buy_now','listingId','7a000000-0000-0000-0000-000000000002',
                                 'buyerWallet',BANK,'fundingCode','USDC')));
  IF v_res->>'kind' <> 'trade_settlement' THEN
    RAISE EXCEPTION 'FAIL: a buy-now recorded as %, expected a trade settlement', v_res->>'kind';
  END IF;
  IF v_res->'receipt'->>'txHash' IS NULL THEN
    RAISE EXCEPTION 'FAIL: a buy-now settled without a chain receipt';
  END IF;
  IF (v_res->'conversion'->>'sourceDebit')::bigint <> 492500000 THEN
    RAISE EXCEPTION 'FAIL: USDC debit is %, expected 492500000 at par',
      v_res->'conversion'->>'sourceDebit';
  END IF;

  -- Paid at the published price, in XUSD, to the seller.
  SELECT b.balance INTO v_after FROM ledger.account_balance b
    JOIN ledger.account a ON a.id=b.account_id JOIN ledger.asset s ON s.id=b.asset_id
   WHERE a.wallet_address=SUPP AND s.cash_code='XUSD';
  IF v_after - v_before <> 492500000 THEN
    RAISE EXCEPTION 'FAIL: the seller was credited %, expected the 492500000 buy-now price',
      v_after - v_before;
  END IF;

  -- The quantity left escrow and landed free with the buyer.
  SELECT free_base INTO v_after FROM ledger.v_holding WHERE wallet_address=BANK;
  IF v_after <> 500000000 THEN
    RAISE EXCEPTION 'FAIL: the buyer holds % free, expected 500000000', v_after;
  END IF;
  SELECT listed_base INTO v_after FROM ledger.v_holding WHERE wallet_address=SUPP;
  IF v_after <> 0 THEN
    RAISE EXCEPTION 'FAIL: the seller still has % in escrow after the sale', v_after;
  END IF;
  RAISE NOTICE 'PASS  a buy-now settles at the published price and moves the lot';

  -- The bid it created is recorded as accepted, so the buyer has a cost basis.
  SELECT count(*) INTO v_n FROM app.bid
   WHERE listing_id='7a000000-0000-0000-0000-000000000002'
     AND bidder_wallet=BANK AND price_base=492500000 AND status='accepted';
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'FAIL: a buy-now left % accepted bids, expected exactly one', v_n;
  END IF;
  RAISE NOTICE 'PASS  a buy-now leaves the same accepted-bid trail as an accepted bid';

  -- A filled listing cannot be bought twice.
  BEGIN
    PERFORM ledger.post(jsonb_build_object(
      'idempotencyKey','00000000-0000-0000-0000-0000000000f6','actorUserId','11111111-0000-0000-0000-000000000005',
      'intent', jsonb_build_object('kind','buy_now','listingId','7a000000-0000-0000-0000-000000000002',
                                   'buyerWallet',FUND,'fundingCode','XSGD')));
    RAISE EXCEPTION 'FAIL: a filled listing was bought a second time';
  EXCEPTION WHEN sqlstate 'ADA11' THEN
    RAISE NOTICE 'PASS  a filled listing refuses a second buy-now';
  END;

  -- A replay returns the same receipt and pays the seller once.
  SELECT b.balance INTO v_before FROM ledger.account_balance b
    JOIN ledger.account a ON a.id=b.account_id JOIN ledger.asset s ON s.id=b.asset_id
   WHERE a.wallet_address=SUPP AND s.cash_code='XUSD';
  v_res2 := ledger.post(jsonb_build_object(
    'idempotencyKey','00000000-0000-0000-0000-0000000000f5','actorUserId','11111111-0000-0000-0000-000000000004',
    'intent', jsonb_build_object('kind','buy_now','listingId','7a000000-0000-0000-0000-000000000002',
                                 'buyerWallet',BANK,'fundingCode','USDC')));
  IF (v_res2->>'replayed')::boolean IS NOT TRUE THEN
    RAISE EXCEPTION 'FAIL: a replayed buy-now was not reported as one';
  END IF;
  IF v_res2->'receipt'->>'txHash' IS DISTINCT FROM v_res->'receipt'->>'txHash' THEN
    RAISE EXCEPTION 'FAIL: the replayed buy-now minted a different receipt';
  END IF;
  SELECT b.balance INTO v_after FROM ledger.account_balance b
    JOIN ledger.account a ON a.id=b.account_id JOIN ledger.asset s ON s.id=b.asset_id
   WHERE a.wallet_address=SUPP AND s.cash_code='XUSD';
  IF v_after <> v_before THEN
    RAISE EXCEPTION 'FAIL: a replayed buy-now paid the seller twice';
  END IF;
  RAISE NOTICE 'PASS  replaying a buy-now returns the same receipt and pays once';

  -- A listing with no buy-now price cannot be bought at one. Published now
  -- that the first listing is filled and the seller is free to list again.
  PERFORM ledger.post(jsonb_build_object(
    'idempotencyKey','00000000-0000-0000-0000-0000000000f2','actorUserId','11111111-0000-0000-0000-000000000003',
    'intent', jsonb_build_object('kind','publish_listing','listingId','7a000000-0000-0000-0000-000000000003',
                                 'payableId',PAYABLE,'sellerWallet',SUPP,
                                 'quantityBase', 100000000, 'minPriceBase', 96000000)));
  BEGIN
    PERFORM ledger.post(jsonb_build_object(
      'idempotencyKey','00000000-0000-0000-0000-0000000000f3','actorUserId','11111111-0000-0000-0000-000000000004',
      'intent', jsonb_build_object('kind','buy_now','listingId','7a000000-0000-0000-0000-000000000003',
                                   'buyerWallet',BANK,'fundingCode','USDC')));
    RAISE EXCEPTION 'FAIL: bought at a buy-now price the seller never published';
  EXCEPTION WHEN sqlstate 'ADA11' THEN
    RAISE NOTICE 'PASS  a listing with no buy-now price refuses a buy-now';
  END;

  -- Release it, so the escrow does not outlive the case that needed it.
  PERFORM ledger.post(jsonb_build_object(
    'idempotencyKey','00000000-0000-0000-0000-0000000000f7','actorUserId','11111111-0000-0000-0000-000000000003',
    'intent', jsonb_build_object('kind','cancel_listing','listingId','7a000000-0000-0000-0000-000000000003')));

  ------------------------------------------- 9b. institutional access only --
  -- PRD §9: "Only institutional lender accounts can bid or buy." The bid panel
  -- says so, but a rule only the UI knows holds for people who use the screens
  -- and for nobody else.
  PERFORM ledger.post(jsonb_build_object(
    'idempotencyKey','00000000-0000-0000-0000-0000000000f8','actorUserId','11111111-0000-0000-0000-000000000003',
    'intent', jsonb_build_object('kind','publish_listing','listingId','7a000000-0000-0000-0000-000000000004',
                                 'payableId',PAYABLE,'sellerWallet',SUPP,
                                 'quantityBase', 100000000, 'minPriceBase', 96000000,
                                 'buyNowPriceBase', 97000000)));
  BEGIN
    PERFORM ledger.post(jsonb_build_object(
      'idempotencyKey','00000000-0000-0000-0000-0000000000f9','actorUserId','11111111-0000-0000-0000-000000000003',
      'intent', jsonb_build_object('kind','place_bid','listingId','7a000000-0000-0000-0000-000000000004',
                                   'bidderWallet',SUPP,'priceBase', 96000000,'fundingCode','XUSD')));
    RAISE EXCEPTION 'FAIL: a supplier account placed a bid';
  EXCEPTION WHEN sqlstate 'ADA34' THEN
    RAISE NOTICE 'PASS  a non-institutional account cannot bid';
  END;

  BEGIN
    PERFORM ledger.post(jsonb_build_object(
      'idempotencyKey','00000000-0000-0000-0000-0000000000fa','actorUserId','11111111-0000-0000-0000-000000000001',
      'intent', jsonb_build_object('kind','buy_now','listingId','7a000000-0000-0000-0000-000000000004',
                                   'buyerWallet',ANCHOR,'fundingCode','XUSD')));
    RAISE EXCEPTION 'FAIL: the anchor bought its own obligation';
  EXCEPTION WHEN sqlstate 'ADA34' THEN
    RAISE NOTICE 'PASS  a non-institutional account cannot buy now';
  END;

  -- And the rule does not accidentally lock out the accounts it is meant for.
  PERFORM ledger.post(jsonb_build_object(
    'idempotencyKey','00000000-0000-0000-0000-0000000000fb','actorUserId','11111111-0000-0000-0000-000000000004',
    'intent', jsonb_build_object('kind','buy_now','listingId','7a000000-0000-0000-0000-000000000004',
                                 'buyerWallet',BANK,'fundingCode','USDC')));
  RAISE NOTICE 'PASS  an institutional lender still buys';

  ------------------------------------------------- 10. duplicate redemption --
  PERFORM ledger.post(jsonb_build_object(
    'idempotencyKey','00000000-0000-0000-0000-0000000000e7','actorUserId','11111111-0000-0000-0000-000000000001',
    'intent', jsonb_build_object('kind','advance_clock','days', 90)));
  PERFORM ledger.post(jsonb_build_object(
    'idempotencyKey','00000000-0000-0000-0000-0000000000e8','actorUserId','11111111-0000-0000-0000-000000000001',
    'intent', jsonb_build_object('kind','settle_maturity','payableId',PAYABLE,'fundingCode','XUSD')));
  BEGIN
    PERFORM ledger.post(jsonb_build_object(
      'idempotencyKey','00000000-0000-0000-0000-0000000000e9','actorUserId','11111111-0000-0000-0000-000000000001',
      'intent', jsonb_build_object('kind','settle_maturity','payableId',PAYABLE,'fundingCode','XUSD')));
    RAISE EXCEPTION 'FAIL: the payable settled twice';
  EXCEPTION WHEN sqlstate 'ADA16' THEN
    RAISE NOTICE 'PASS  a settled payable cannot settle again';
  END;

  ------------------------------------------- 11. split settlement is exact --
  -- Three holders at maturity: the fund bought 100,000 on a bid, the bank
  -- bought 50,000 and then a further 10,000 at buy-now prices, and the supplier
  -- kept the rest. Each must be paid the face of what they held, and ADATA
  -- debited exactly once for the total.
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
  SELECT b.balance INTO v_after FROM ledger.account_balance b
    JOIN ledger.account a ON a.id=b.account_id JOIN ledger.asset s ON s.id=b.asset_id
   WHERE a.wallet_address=BANK AND s.cash_code='XUSD';
  IF v_after <> 600000000 THEN
    RAISE EXCEPTION 'FAIL: the buy-now buyer redeemed %, expected 600000000 (50,000 + 10,000)',
      v_after;
  END IF;
  RAISE NOTICE 'PASS  a split payable pays each holder and debits the anchor once';

  ------------------------------------ 11b. settlement funded in another asset --
  -- PRD §8 screen 4 and §3 q13: redemption is denominated in XUSD and the
  -- funding asset is chosen only for payment. Four fresh payables, issued to
  -- the supplier, one of them split three ways, then matured together.
  INSERT INTO app.payable (id, ref, anchor_id, original_supplier_id, invoice_ref,
                           face_base, maturity_date, grade, grade_rationale, lifecycle_status)
  VALUES
    (PAY_XSGD,  'TP-2026-0161', ANCHOR_ID, SUPP_ID, 'INV-TW-88261', FACE_XSGD,  '2027-01-29', 'AA', 'Sample value.', 'certified'),
    (PAY_USDC,  'TP-2026-0162', ANCHOR_ID, SUPP_ID, 'INV-TW-88262', FACE_USDC,  '2027-01-29', 'AA', 'Sample value.', 'certified'),
    (PAY_SPLIT, 'TP-2026-0163', ANCHOR_ID, SUPP_ID, 'INV-TW-88263', FACE_SPLIT, '2027-01-29', 'AA', 'Sample value.', 'certified'),
    (PAY_SHORT, 'TP-2026-0164', ANCHOR_ID, SUPP_ID, 'INV-TW-88264', FACE_SHORT, '2027-01-29', 'AA', 'Sample value.', 'certified');
  FOR v_p IN
    SELECT id, n FROM unnest(ARRAY[PAY_XSGD, PAY_USDC, PAY_SPLIT, PAY_SHORT]) WITH ORDINALITY AS t(id, n)
  LOOP
    PERFORM ledger.post(jsonb_build_object(
      'idempotencyKey',('00000000-0000-0000-0000-0000000001' || lpad(v_p.n::text, 2, '0'))::uuid,
      'actorUserId','11111111-0000-0000-0000-000000000008',
      'intent', jsonb_build_object('kind','issue_payable','payableId',v_p.id,'toWallet',SUPP,'tokenId',160 + v_p.n)));
    PERFORM ledger.post(jsonb_build_object(
      'idempotencyKey',('00000000-0000-0000-0000-0000000002' || lpad(v_p.n::text, 2, '0'))::uuid,
      'actorUserId','11111111-0000-0000-0000-000000000003',
      'intent', jsonb_build_object('kind','accept_receipt','payableId',v_p.id)));
  END LOOP;
  PERFORM ledger.post(jsonb_build_object(
    'idempotencyKey','00000000-0000-0000-0000-000000000301','actorUserId','11111111-0000-0000-0000-000000000003',
    'intent', jsonb_build_object('kind','transfer','payableId',PAY_SPLIT,'fromWallet',SUPP,
                                 'toWallet',BANK,'quantityBase', FACE_SPLIT / 3)));
  PERFORM ledger.post(jsonb_build_object(
    'idempotencyKey','00000000-0000-0000-0000-000000000302','actorUserId','11111111-0000-0000-0000-000000000003',
    'intent', jsonb_build_object('kind','transfer','payableId',PAY_SPLIT,'fromWallet',SUPP,
                                 'toWallet',FUND,'quantityBase', FACE_SPLIT / 3)));
  PERFORM ledger.post(jsonb_build_object(
    'idempotencyKey','00000000-0000-0000-0000-000000000303','actorUserId','11111111-0000-0000-0000-000000000001',
    'intent', jsonb_build_object('kind','advance_clock','days', 30)));

  -- Whole-held, paid in XSGD. PRD §6: 1 XUSD = 1.31 XSGD, so 200,000 XUSD of
  -- face costs 262,000.0000 XSGD. The holder is credited XUSD, ADATA's XUSD
  -- does not move, and system_fx carries the conversion.
  SELECT pg_temp.cash(SUPP, 'XUSD') AS holder_xusd, pg_temp.cash(ANCHOR, 'XUSD') AS anchor_xusd,
         pg_temp.cash(ANCHOR, 'XSGD') AS anchor_xsgd,
         pg_temp.fx('XSGD') AS fx_xsgd, pg_temp.fx('XUSD') AS fx_xusd
    INTO v_was;
  v_res := ledger.post(jsonb_build_object(
    'idempotencyKey','00000000-0000-0000-0000-000000000401','actorUserId','11111111-0000-0000-0000-000000000001',
    'intent', jsonb_build_object('kind','settle_maturity','payableId',PAY_XSGD,'fundingCode','XSGD')));
  IF v_was.anchor_xsgd - pg_temp.cash(ANCHOR, 'XSGD') <> 2620000000 THEN
    RAISE EXCEPTION 'FAIL: settling 200,000 XUSD in XSGD debited % XSGD, expected 2620000000 (262,000.0000)',
      v_was.anchor_xsgd - pg_temp.cash(ANCHOR, 'XSGD');
  END IF;
  IF pg_temp.cash(ANCHOR, 'XUSD') <> v_was.anchor_xusd THEN
    RAISE EXCEPTION 'FAIL: an XSGD-funded settlement moved ADATA''s XUSD by %',
      pg_temp.cash(ANCHOR, 'XUSD') - v_was.anchor_xusd;
  END IF;
  IF pg_temp.cash(SUPP, 'XUSD') - v_was.holder_xusd <> FACE_XSGD THEN
    RAISE EXCEPTION 'FAIL: the holder was credited % XUSD, expected the % face',
      pg_temp.cash(SUPP, 'XUSD') - v_was.holder_xusd, FACE_XSGD;
  END IF;
  IF pg_temp.fx('XSGD') - v_was.fx_xsgd <> 2620000000 OR pg_temp.fx('XUSD') - v_was.fx_xusd <> -FACE_XSGD THEN
    RAISE EXCEPTION 'FAIL: system_fx moved % XSGD and % XUSD, expected +2620000000 and -%',
      pg_temp.fx('XSGD') - v_was.fx_xsgd, pg_temp.fx('XUSD') - v_was.fx_xusd, FACE_XSGD;
  END IF;
  SELECT funding_code::text AS funding, source_amount_base AS source, fx_rate_e6 AS rate INTO v_entry
    FROM ledger.journal_entry WHERE id = (v_res->>'entryId')::uuid;
  IF (v_entry.funding, v_entry.source, v_entry.rate) IS DISTINCT FROM ('XSGD', 2620000000::bigint, 1310000::bigint) THEN
    RAISE EXCEPTION 'FAIL: the redemption entry records (%, %, %), expected (XSGD, 2620000000, 1310000)',
      v_entry.funding, v_entry.source, v_entry.rate;
  END IF;
  IF (v_res->'conversion'->>'sourceDebit')::bigint IS DISTINCT FROM 2620000000 THEN
    RAISE EXCEPTION 'FAIL: the receipt shows a source debit of %, expected 2620000000',
      v_res->'conversion'->>'sourceDebit';
  END IF;
  RAISE NOTICE 'PASS  an XSGD-funded settlement debits ADATA 1.31x the face and credits the holder XUSD';

  -- Whole-held, paid in USDC: 1:1, so the debit is the face and the rate
  -- recorded is exactly one.
  SELECT pg_temp.cash(SUPP, 'XUSD') AS holder_xusd, pg_temp.cash(ANCHOR, 'USDC') AS anchor_usdc INTO v_was;
  v_res := ledger.post(jsonb_build_object(
    'idempotencyKey','00000000-0000-0000-0000-000000000402','actorUserId','11111111-0000-0000-0000-000000000001',
    'intent', jsonb_build_object('kind','settle_maturity','payableId',PAY_USDC,'fundingCode','USDC')));
  IF v_was.anchor_usdc - pg_temp.cash(ANCHOR, 'USDC') <> FACE_USDC
     OR pg_temp.cash(SUPP, 'XUSD') - v_was.holder_xusd <> FACE_USDC THEN
    RAISE EXCEPTION 'FAIL: a USDC-funded settlement debited % USDC and credited % XUSD, expected % of each',
      v_was.anchor_usdc - pg_temp.cash(ANCHOR, 'USDC'), pg_temp.cash(SUPP, 'XUSD') - v_was.holder_xusd, FACE_USDC;
  END IF;
  SELECT funding_code::text AS funding, source_amount_base AS source, fx_rate_e6 AS rate INTO v_entry
    FROM ledger.journal_entry WHERE id = (v_res->>'entryId')::uuid;
  IF (v_entry.funding, v_entry.source, v_entry.rate) IS DISTINCT FROM ('USDC', FACE_USDC, 1000000::bigint) THEN
    RAISE EXCEPTION 'FAIL: the redemption entry records (%, %, %), expected (USDC, %, 1000000)',
      v_entry.funding, v_entry.source, v_entry.rate, FACE_USDC;
  END IF;
  RAISE NOTICE 'PASS  a USDC-funded settlement debits the face at par and records a rate of one';

  -- Split three ways, paid in XSGD. Each lot of 50,000.0050 XUSD is
  -- 65,500.00655 XSGD, which rounds up: converting the three shares
  -- separately would charge 1965000198, converting the total charges
  -- 1965000197. ADATA is debited once, for the total.
  SELECT pg_temp.cash(SUPP, 'XUSD') AS supp, pg_temp.cash(BANK, 'XUSD') AS bank, pg_temp.cash(FUND, 'XUSD') AS fund,
         pg_temp.cash(ANCHOR, 'XSGD') AS anchor_xsgd
    INTO v_was;
  v_res := ledger.post(jsonb_build_object(
    'idempotencyKey','00000000-0000-0000-0000-000000000403','actorUserId','11111111-0000-0000-0000-000000000001',
    'intent', jsonb_build_object('kind','settle_maturity','payableId',PAY_SPLIT,'fundingCode','XSGD')));
  IF pg_temp.cash(SUPP, 'XUSD') - v_was.supp <> FACE_SPLIT / 3
     OR pg_temp.cash(BANK, 'XUSD') - v_was.bank <> FACE_SPLIT / 3
     OR pg_temp.cash(FUND, 'XUSD') - v_was.fund <> FACE_SPLIT / 3 THEN
    RAISE EXCEPTION 'FAIL: the three holders were credited %, % and % XUSD, expected % each',
      pg_temp.cash(SUPP, 'XUSD') - v_was.supp, pg_temp.cash(BANK, 'XUSD') - v_was.bank,
      pg_temp.cash(FUND, 'XUSD') - v_was.fund, FACE_SPLIT / 3;
  END IF;
  IF v_was.anchor_xsgd - pg_temp.cash(ANCHOR, 'XSGD') <> 1965000197 THEN
    RAISE EXCEPTION 'FAIL: ADATA paid % XSGD for the split payable, expected 1965000197 (the total converted once; three rounded shares would be 1965000198)',
      v_was.anchor_xsgd - pg_temp.cash(ANCHOR, 'XSGD');
  END IF;
  SELECT count(*) FILTER (WHERE s.cash_code = 'XSGD'), count(*) FILTER (WHERE s.cash_code IS DISTINCT FROM 'XSGD')
    INTO v_n, v_other
    FROM ledger.journal_leg l
    JOIN ledger.account a ON a.id = l.account_id
    JOIN ledger.asset   s ON s.id = l.asset_id
   WHERE l.entry_id = (v_res->>'entryId')::uuid AND a.wallet_address = ANCHOR;
  IF v_n <> 1 OR v_other <> 0 THEN
    RAISE EXCEPTION 'FAIL: the anchor carries % XSGD legs and % in other assets on the split redemption, expected one and none', v_n, v_other;
  END IF;
  IF (v_res->'conversion'->>'sourceDebit')::bigint IS DISTINCT FROM 1965000197 THEN
    RAISE EXCEPTION 'FAIL: the receipt shows a source debit of %, expected 1965000197',
      v_res->'conversion'->>'sourceDebit';
  END IF;
  RAISE NOTICE 'PASS  a split payable paid in XSGD converts the total once and debits ADATA once';

  -- A settlement names its funding asset.
  SELECT pg_temp.cash(SUPP, 'XUSD') AS holder_xusd,
         pg_temp.cash(ANCHOR, 'XUSD') + pg_temp.cash(ANCHOR, 'USDC')
           + pg_temp.cash(ANCHOR, 'USDT') + pg_temp.cash(ANCHOR, 'XSGD') AS anchor_cash
    INTO v_was;
  BEGIN
    PERFORM ledger.post(jsonb_build_object(
      'idempotencyKey','00000000-0000-0000-0000-000000000404','actorUserId','11111111-0000-0000-0000-000000000001',
      'intent', jsonb_build_object('kind','settle_maturity','payableId',PAY_SHORT)));
    RAISE EXCEPTION 'FAIL: a settlement with no funding asset was accepted';
  EXCEPTION WHEN sqlstate 'ADA17' THEN
    RAISE NOTICE 'PASS  a settlement without a funding asset is refused as malformed';
  END;

  -- Short of the asset chosen: 52,400 XSGD against the 41,499.9803 left of
  -- the fixture's 500,000, refused by the shortfall check.
  BEGIN
    PERFORM ledger.post(jsonb_build_object(
      'idempotencyKey','00000000-0000-0000-0000-000000000405','actorUserId','11111111-0000-0000-0000-000000000001',
      'intent', jsonb_build_object('kind','settle_maturity','payableId',PAY_SHORT,'fundingCode','XSGD')));
    RAISE EXCEPTION 'FAIL: ADATA settled in XSGD it does not hold';
  EXCEPTION WHEN sqlstate 'ADA20' THEN
    RAISE NOTICE 'PASS  a settlement in an asset ADATA is short of is refused, naming the shortfall';
  END;

  IF pg_temp.cash(SUPP, 'XUSD') <> v_was.holder_xusd
     OR pg_temp.cash(ANCHOR, 'XUSD') + pg_temp.cash(ANCHOR, 'USDC')
        + pg_temp.cash(ANCHOR, 'USDT') + pg_temp.cash(ANCHOR, 'XSGD') <> v_was.anchor_cash THEN
    RAISE EXCEPTION 'FAIL: a refused settlement still moved a balance';
  END IF;
  PERFORM 1 FROM app.payable WHERE id = PAY_SHORT AND lifecycle_status = 'issued';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'FAIL: a refused settlement changed the payable''s status';
  END IF;
  SELECT count(*) INTO v_n FROM ledger.journal_entry
   WHERE idempotency_key IN ('00000000-0000-0000-0000-000000000404', '00000000-0000-0000-0000-000000000405');
  IF v_n <> 0 THEN
    RAISE EXCEPTION 'FAIL: % refused settlements left journal entries behind', v_n;
  END IF;
  RAISE NOTICE 'PASS  both refusals left every balance, the payable and the journal untouched';

  -- Refused is not stuck: the same payable settles in an asset ADATA holds.
  PERFORM ledger.post(jsonb_build_object(
    'idempotencyKey','00000000-0000-0000-0000-000000000406','actorUserId','11111111-0000-0000-0000-000000000001',
    'intent', jsonb_build_object('kind','settle_maturity','payableId',PAY_SHORT,'fundingCode','USDC')));
  PERFORM 1 FROM app.payable WHERE id = PAY_SHORT AND lifecycle_status = 'settled';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'FAIL: the payable did not settle in USDC after the XSGD refusal';
  END IF;
  RAISE NOTICE 'PASS  after a refusal the same payable settles in an asset ADATA holds';

  ----------------------------------------------------------- 12. the books --
  SELECT count(*) INTO v_n FROM ledger.prove_books_balance();
  IF v_n <> 0 THEN RAISE EXCEPTION 'FAIL: projection disagrees with the journal on % rows', v_n; END IF;
  SELECT count(*) INTO v_n FROM (
    SELECT asset_id FROM ledger.account_balance GROUP BY asset_id HAVING SUM(balance) <> 0) bad;
  IF v_n <> 0 THEN RAISE EXCEPTION 'FAIL: % assets are not conserved', v_n; END IF;
  RAISE NOTICE 'PASS  the projection equals the journal and every asset nets to zero';

  RAISE NOTICE '--- ALL INVARIANTS HELD ---';
END $$;
