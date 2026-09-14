-- The five-minute runbook, driven entirely through ledger.post().
--
-- This is the executable form of the PRD's headline acceptance criterion:
-- issue -> list -> bid -> accept -> advance time -> settle. Every assertion
-- compares against a figure taken from the PRD, not from a previous run.
--
-- Run with: scripts/db.sh reset && psql "$(scripts/db.sh url)" -v ON_ERROR_STOP=1 -f tests/ledger/runbook.sql
\set ON_ERROR_STOP on
\timing off
\set QUIET on

-- ---------------------------------------------------------------- fixtures --
INSERT INTO app.world (t0, offset_days) VALUES ('2026-10-01', 0);

INSERT INTO app.entity (id, name, entity_type, certification_status) VALUES
  ('e0000000-0000-0000-0000-0000000000a1', 'ADATA Technology Co., Ltd.', 'anchor',   'certified'),
  ('e0000000-0000-0000-0000-0000000000a2', 'Chien Yu Precision',         'supplier', 'certified'),
  ('e0000000-0000-0000-0000-0000000000a3', 'Meridian Trade Bank',        'lender',   'certified');

INSERT INTO app.wallet (address, entity_id) VALUES
  ('0xada7a0000000000000000000000000000000c21d', 'e0000000-0000-0000-0000-0000000000a1'),
  ('0x509911000000000000000000000000000000f88a', 'e0000000-0000-0000-0000-0000000000a2'),
  ('0x1e4de40000000000000000000000000000004b13', 'e0000000-0000-0000-0000-0000000000a3');

INSERT INTO app.app_user (id, entity_id, name, role, mock_kyc_verified, institutional_eligible) VALUES
  ('11111111-0000-0000-0000-000000000001', 'e0000000-0000-0000-0000-0000000000a1', 'Wei Chen',   'adata_preparer', true, false),
  ('11111111-0000-0000-0000-000000000002', 'e0000000-0000-0000-0000-0000000000a1', 'Lin Hsu',    'adata_checker',  true, false),
  ('11111111-0000-0000-0000-000000000003', 'e0000000-0000-0000-0000-0000000000a2', 'Mei Tang',   'supplier',       true, false),
  ('11111111-0000-0000-0000-000000000004', 'e0000000-0000-0000-0000-0000000000a3', 'R. Okafor',  'lender',         true, true);

-- TP-2026-0141 from PRD §12: 250,000 XUSD face, 90 days, grade AA.
INSERT INTO app.payable (id, ref, anchor_id, original_supplier_id, invoice_ref,
                         face_base, maturity_date, grade, grade_rationale, lifecycle_status)
VALUES ('9a000000-0000-0000-0000-000000000141', 'TP-2026-0141',
        'e0000000-0000-0000-0000-0000000000a1', 'e0000000-0000-0000-0000-0000000000a2',
        'INV-TW-88213', 2500000000, '2026-12-30', 'AA',
        'Anchor obligor investment grade. Sample value, not an external rating.', 'certified');

\set QUIET off
\echo '=============================================================='
\echo ' RUNBOOK: issue -> list -> bid -> accept -> advance -> settle'
\echo '=============================================================='

-- ------------------------------------------------------------- 0. pre-fund --
-- PRD §12 pre-funds both lenders. The bank is funded predominantly in USDC.
SELECT ledger.post(jsonb_build_object(
  'idempotencyKey', '00000000-0000-0000-0000-00000000f001',
  'actorUserId',    '11111111-0000-0000-0000-000000000004',
  'intent', jsonb_build_object('kind','top_up','wallet','0x1e4de40000000000000000000000000000004b13',
                               'cashCode','USDC','amountBase', 3000000000)
)) -> 'kind' AS top_up_lender;

-- ADATA must be able to fund redemption at maturity.
SELECT ledger.post(jsonb_build_object(
  'idempotencyKey', '00000000-0000-0000-0000-00000000f002',
  'actorUserId',    '11111111-0000-0000-0000-000000000001',
  'intent', jsonb_build_object('kind','top_up','wallet','0xada7a0000000000000000000000000000000c21d',
                               'cashCode','XUSD','amountBase', 5000000000)
)) -> 'kind' AS top_up_anchor;

-- ---------------------------------------------------------------- 1. issue --
SELECT ledger.post(jsonb_build_object(
  'idempotencyKey', '00000000-0000-0000-0000-000000000001',
  'actorUserId',    '11111111-0000-0000-0000-000000000001',
  'intent', jsonb_build_object('kind','issue_payable',
                               'payableId','9a000000-0000-0000-0000-000000000141',
                               'toWallet','0x509911000000000000000000000000000000f88a',
                               'tokenId', 141)
)) -> 'receipt' -> 'simulated' AS issue_has_simulated_receipt;

\echo '-- supplier holds the full face --'
SELECT wallet_address, quantity_base, free_base, listed_base FROM ledger.v_holding;

-- ----------------------------------------------------------------- 2. list --
SELECT ledger.post(jsonb_build_object(
  'idempotencyKey', '00000000-0000-0000-0000-000000000002',
  'actorUserId',    '11111111-0000-0000-0000-000000000003',
  'intent', jsonb_build_object('kind','publish_listing',
                               'listingId','7a000000-0000-0000-0000-000000000001',
                               'payableId','9a000000-0000-0000-0000-000000000141',
                               'sellerWallet','0x509911000000000000000000000000000000f88a',
                               'quantityBase', 2500000000,
                               'minPriceBase', 2446250000)
)) -> 'kind' AS listed;

\echo '-- the listed quantity has moved into escrow; free is now zero --'
SELECT wallet_address, quantity_base, free_base, listed_base FROM ledger.v_holding;

-- ------------------------------------------------------------------ 3. bid --
-- 97.85% of 250,000 face = 244,625.0000 XUSD, funded in USDC.
SELECT ledger.post(jsonb_build_object(
  'idempotencyKey', '00000000-0000-0000-0000-000000000003',
  'actorUserId',    '11111111-0000-0000-0000-000000000004',
  'intent', jsonb_build_object('kind','place_bid',
                               'bidId','b0000000-0000-0000-0000-000000000001',
                               'listingId','7a000000-0000-0000-0000-000000000001',
                               'bidderWallet','0x1e4de40000000000000000000000000000004b13',
                               'priceBase', 2446250000,
                               'fundingCode','USDC')
)) -> 'kind' AS bid_placed;

-- --------------------------------------------------------------- 4. accept --
SELECT ledger.post(jsonb_build_object(
  'idempotencyKey', '00000000-0000-0000-0000-000000000004',
  'actorUserId',    '11111111-0000-0000-0000-000000000003',
  'intent', jsonb_build_object('kind','accept_bid',
                               'listingId','7a000000-0000-0000-0000-000000000001',
                               'bidId','b0000000-0000-0000-0000-000000000001')
)) -> 'conversion' AS trade_conversion;

\echo '-- ownership moved to the lender; supplier holds nothing --'
SELECT wallet_address, quantity_base, free_base, listed_base FROM ledger.v_holding;
\echo '-- cash: supplier +244,625 XUSD, lender -244,625 USDC --'
SELECT a.wallet_address, ast.cash_code, b.balance
  FROM ledger.account_balance b
  JOIN ledger.account a   ON a.id = b.account_id
  JOIN ledger.asset   ast ON ast.id = b.asset_id
 WHERE a.class = 'wallet' AND ast.kind = 'cash' AND b.balance <> 0
 ORDER BY a.wallet_address, ast.cash_code;

-- --------------------------------------------------------- 5. advance time --
SELECT ledger.post(jsonb_build_object(
  'idempotencyKey', '00000000-0000-0000-0000-000000000005',
  'actorUserId',    '11111111-0000-0000-0000-000000000001',
  'intent', jsonb_build_object('kind','advance_clock','days', 90)
)) -> 'kind' AS clock_advanced;

SELECT t0 + offset_days AS world_date FROM app.world;

-- --------------------------------------------------------------- 6. settle --
SELECT ledger.post(jsonb_build_object(
  'idempotencyKey', '00000000-0000-0000-0000-000000000006',
  'actorUserId',    '11111111-0000-0000-0000-000000000001',
  'intent', jsonb_build_object('kind','settle_maturity',
                               'payableId','9a000000-0000-0000-0000-000000000141')
)) -> 'kind' AS settled;

\echo '-- final cash. lender should hold 250,000 XUSD against 244,625 USDC paid --'
SELECT a.wallet_address, ast.cash_code, b.balance
  FROM ledger.account_balance b
  JOIN ledger.account a   ON a.id = b.account_id
  JOIN ledger.asset   ast ON ast.id = b.asset_id
 WHERE a.class = 'wallet' AND ast.kind = 'cash' AND b.balance <> 0
 ORDER BY a.wallet_address, ast.cash_code;

\echo '-- no token holdings remain; the payable is settled --'
SELECT count(*) AS remaining_holdings FROM ledger.v_holding;
SELECT ref, lifecycle_status FROM app.payable;

\echo '=============================================================='
\echo ' ASSERTIONS'
\echo '=============================================================='
DO $$
DECLARE
  v_lender  text := '0x1e4de40000000000000000000000000000004b13';
  v_supp    text := '0x509911000000000000000000000000000000f88a';
  v_anchor  text := '0xada7a0000000000000000000000000000000c21d';
  v_n       bigint;
  v_bal     bigint;
BEGIN
  -- The lender paid 244,625 USDC out of 300,000 and received 250,000 XUSD.
  SELECT b.balance INTO v_bal FROM ledger.account_balance b
    JOIN ledger.account a ON a.id=b.account_id JOIN ledger.asset s ON s.id=b.asset_id
   WHERE a.wallet_address=v_lender AND s.cash_code='USDC';
  IF v_bal <> 3000000000 - 2446250000 THEN
    RAISE EXCEPTION 'lender USDC is %, expected %', v_bal, 3000000000-2446250000;
  END IF;

  SELECT b.balance INTO v_bal FROM ledger.account_balance b
    JOIN ledger.account a ON a.id=b.account_id JOIN ledger.asset s ON s.id=b.asset_id
   WHERE a.wallet_address=v_lender AND s.cash_code='XUSD';
  IF v_bal <> 2500000000 THEN
    RAISE EXCEPTION 'lender XUSD is %, expected 2500000000 (face)', v_bal;
  END IF;

  -- The supplier received the discounted proceeds and nothing else.
  SELECT b.balance INTO v_bal FROM ledger.account_balance b
    JOIN ledger.account a ON a.id=b.account_id JOIN ledger.asset s ON s.id=b.asset_id
   WHERE a.wallet_address=v_supp AND s.cash_code='XUSD';
  IF v_bal <> 2446250000 THEN
    RAISE EXCEPTION 'supplier XUSD is %, expected 2446250000 (244,625)', v_bal;
  END IF;

  -- ADATA funded the full face once.
  SELECT b.balance INTO v_bal FROM ledger.account_balance b
    JOIN ledger.account a ON a.id=b.account_id JOIN ledger.asset s ON s.id=b.asset_id
   WHERE a.wallet_address=v_anchor AND s.cash_code='XUSD';
  IF v_bal <> 5000000000 - 2500000000 THEN
    RAISE EXCEPTION 'anchor XUSD is %, expected %', v_bal, 5000000000-2500000000;
  END IF;

  -- The projection agrees with the journal, row for row.
  SELECT count(*) INTO v_n FROM ledger.prove_books_balance();
  IF v_n <> 0 THEN
    RAISE EXCEPTION 'projection disagrees with the journal on % rows', v_n;
  END IF;

  -- Every asset nets to zero across all accounts.
  SELECT count(*) INTO v_n FROM (
    SELECT asset_id FROM ledger.account_balance GROUP BY asset_id HAVING SUM(balance) <> 0
  ) bad;
  IF v_n <> 0 THEN
    RAISE EXCEPTION '% assets are not conserved', v_n;
  END IF;

  RAISE NOTICE 'ALL ASSERTIONS PASSED';
END $$;
