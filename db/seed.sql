-- ============================================================================
--  Seed world — PRD §12
-- ============================================================================
-- Every figure here comes from the PRD's seed table. The two rows it leaves to
-- be derived (the settled row's purchase price and holding period, and the
-- overdue row's due date) are derived in docs/ASSUMPTIONS.md and asserted in
-- src/core/__tests__/pricing.test.ts.
--
-- HOW THE PAST IS SEEDED. The settled and overdue rows need histories that
-- already happened. Rather than writing ledger rows by hand and hoping they
-- reconcile, this seed starts the world in June, lives through those events by
-- calling ledger.post() exactly as the application would, advances the clock to
-- 1 October, and only then declares that date to be T0. Every historical
-- balance, receipt and audit entry is therefore real, and the books prove
-- themselves at the end.
--
-- Fictional throughout. ADATA is the intentional named-anchor exception.

\set QUIET on
SET client_min_messages TO warning;

-- A thin wrapper so the seed reads as a sequence of business events rather than
-- a wall of jsonb construction.
CREATE OR REPLACE FUNCTION pg_temp.act(p_key text, p_actor uuid, p_intent jsonb)
RETURNS jsonb LANGUAGE sql AS $$
  SELECT ledger.post(jsonb_build_object(
    'idempotencyKey', md5(p_key)::uuid, 'actorUserId', p_actor, 'intent', p_intent));
$$;

-- ---------------------------------------------------------------- the world --
INSERT INTO app.world (t0, offset_days) VALUES ('2026-06-01', 0);

-- -------------------------------------------------------------- the parties --
INSERT INTO app.entity (id, name, entity_type, certification_status, programme_limit_base) VALUES
  ('e0000000-0000-0000-0000-00000000ada7', 'ADATA Technology Co., Ltd.', 'anchor',   'certified',   50000000000),
  ('e0000000-0000-0000-0000-000000005787', 'StraitsX',                   'platform', 'certified',   NULL),
  -- Interactive suppliers
  ('e0000000-0000-0000-0000-000000000c41', 'Chien Yu Precision',         'supplier', 'certified',   NULL),
  ('e0000000-0000-0000-0000-000000000c43', 'Ming Kuo Components',        'supplier', 'certified',   NULL),
  ('e0000000-0000-0000-0000-000000000c42', 'Hsin Ta Electronics',        'supplier', 'certified',   NULL),
  -- Originators of the historical rows
  ('e0000000-0000-0000-0000-000000000c28', 'Yung Sheng Metals',          'supplier', 'certified',   NULL),
  ('e0000000-0000-0000-0000-000000000c19', 'Fu Hsing Plastics',          'supplier', 'certified',   NULL),
  -- Institutional lenders
  ('e0000000-0000-0000-0000-00000000ba17', 'Meridian Trade Bank',        'lender',   'certified',   NULL),
  ('e0000000-0000-0000-0000-00000000fd21', 'Kestrel Credit Fund',        'lender',   'certified',   NULL);

INSERT INTO app.wallet (address, entity_id) VALUES
  ('0xada7a0000000000000000000000000000000c21d', 'e0000000-0000-0000-0000-00000000ada7'),
  ('0x57a715000000000000000000000000000000a001', 'e0000000-0000-0000-0000-000000005787'),
  ('0x509911000000000000000000000000000000f88a', 'e0000000-0000-0000-0000-000000000c41'),
  ('0x6d1470000000000000000000000000000000b43c', 'e0000000-0000-0000-0000-000000000c43'),
  ('0x4851ca000000000000000000000000000000e42d', 'e0000000-0000-0000-0000-000000000c42'),
  ('0x7009e5000000000000000000000000000000d128', 'e0000000-0000-0000-0000-000000000c28'),
  ('0x5f0451000000000000000000000000000000c119', 'e0000000-0000-0000-0000-000000000c19'),
  ('0x1e4de40000000000000000000000000000004b13', 'e0000000-0000-0000-0000-00000000ba17'),
  ('0xfe5700000000000000000000000000000000d902', 'e0000000-0000-0000-0000-00000000fd21');

INSERT INTO app.app_user (id, entity_id, name, role, mock_kyc_verified, institutional_eligible) VALUES
  ('11111111-0000-0000-0000-000000000001', 'e0000000-0000-0000-0000-00000000ada7', 'Wei-Ling Chen',  'adata_preparer', true,  false),
  ('11111111-0000-0000-0000-000000000002', 'e0000000-0000-0000-0000-00000000ada7', 'Hsu Po-Chun',    'adata_checker',  true,  false),
  ('11111111-0000-0000-0000-000000000003', 'e0000000-0000-0000-0000-000000000c41', 'Tang Mei-Hua',   'supplier',       true,  false),
  ('11111111-0000-0000-0000-000000000004', 'e0000000-0000-0000-0000-000000000c43', 'Kuo Shih-Chieh', 'supplier',       true,  false),
  ('11111111-0000-0000-0000-000000000005', 'e0000000-0000-0000-0000-000000000c42', 'Lin Ya-Ting',    'supplier',       true,  false),
  ('11111111-0000-0000-0000-000000000006', 'e0000000-0000-0000-0000-00000000ba17', 'Rina Okafor',    'lender',         true,  true),
  ('11111111-0000-0000-0000-000000000007', 'e0000000-0000-0000-0000-00000000fd21', 'Sébastien Baptiste', 'lender',     true,  true),
  ('11111111-0000-0000-0000-000000000008', 'e0000000-0000-0000-0000-000000005787', 'Nadia Rahman',   'straitsx_admin', true,  false);

-- --------------------------------------------------- wallets, pre-funded ----
-- PRD §12: "Pre-fund both lenders in all four assets, with one predominantly
-- funded in USDC and the other in XUSD."
SELECT pg_temp.act('fund-bank-usdc', '11111111-0000-0000-0000-000000000006',
  jsonb_build_object('kind','top_up','wallet','0x1e4de40000000000000000000000000000004b13','cashCode','USDC','amountBase', 45000000000));
SELECT pg_temp.act('fund-bank-xusd', '11111111-0000-0000-0000-000000000006',
  jsonb_build_object('kind','top_up','wallet','0x1e4de40000000000000000000000000000004b13','cashCode','XUSD','amountBase', 6000000000));
SELECT pg_temp.act('fund-bank-usdt', '11111111-0000-0000-0000-000000000006',
  jsonb_build_object('kind','top_up','wallet','0x1e4de40000000000000000000000000000004b13','cashCode','USDT','amountBase', 2500000000));
SELECT pg_temp.act('fund-bank-xsgd', '11111111-0000-0000-0000-000000000006',
  jsonb_build_object('kind','top_up','wallet','0x1e4de40000000000000000000000000000004b13','cashCode','XSGD','amountBase', 1800000000));

SELECT pg_temp.act('fund-fund-xusd', '11111111-0000-0000-0000-000000000007',
  jsonb_build_object('kind','top_up','wallet','0xfe5700000000000000000000000000000000d902','cashCode','XUSD','amountBase', 38000000000));
SELECT pg_temp.act('fund-fund-usdc', '11111111-0000-0000-0000-000000000007',
  jsonb_build_object('kind','top_up','wallet','0xfe5700000000000000000000000000000000d902','cashCode','USDC','amountBase', 4000000000));
SELECT pg_temp.act('fund-fund-usdt', '11111111-0000-0000-0000-000000000007',
  jsonb_build_object('kind','top_up','wallet','0xfe5700000000000000000000000000000000d902','cashCode','USDT','amountBase', 1500000000));
SELECT pg_temp.act('fund-fund-xsgd', '11111111-0000-0000-0000-000000000007',
  jsonb_build_object('kind','top_up','wallet','0xfe5700000000000000000000000000000000d902','cashCode','XSGD','amountBase', 9000000000));

-- ADATA must be able to discharge everything outstanding at maturity.
SELECT pg_temp.act('fund-anchor', '11111111-0000-0000-0000-000000000001',
  jsonb_build_object('kind','top_up','wallet','0xada7a0000000000000000000000000000000c21d','cashCode','XUSD','amountBase', 40000000000));

-- ============================================================================
--  June: the two rows with a past
-- ============================================================================
INSERT INTO app.payable (id, ref, anchor_id, original_supplier_id, invoice_ref,
                         face_base, maturity_date, grade, grade_rationale, lifecycle_status) VALUES
  ('9a000000-0000-0000-0000-000000000128', 'TP-2026-0128', 'e0000000-0000-0000-0000-00000000ada7',
   'e0000000-0000-0000-0000-000000000c28', 'INV-TW-71904', 3200000000, '2026-09-15', 'AA',
   'Anchor obligor investment grade. Sample value assigned by StraitsX, not an external rating.', 'certified'),
  ('9a000000-0000-0000-0000-000000000119', 'TP-2026-0119', 'e0000000-0000-0000-0000-00000000ada7',
   'e0000000-0000-0000-0000-000000000c19', 'INV-TW-66120', 750000000, '2026-08-17', 'A',
   'Anchor obligor upper-medium grade. Sample value assigned by StraitsX, not an external rating.', 'certified');

SELECT pg_temp.act('issue-0128', '11111111-0000-0000-0000-000000000008',
  jsonb_build_object('kind','issue_payable','payableId','9a000000-0000-0000-0000-000000000128',
                     'toWallet','0x7009e5000000000000000000000000000000d128','tokenId', 128));
SELECT pg_temp.act('issue-0119', '11111111-0000-0000-0000-000000000008',
  jsonb_build_object('kind','issue_payable','payableId','9a000000-0000-0000-0000-000000000119',
                     'toWallet','0x5f0451000000000000000000000000000000c119','tokenId', 119));

-- 17 June: Yung Sheng finances TP-2026-0128, 90 days out, at 97.78% of face.
-- 312,900 against 320,000 face over 90 days is a 9.2% realised yield, which is
-- the figure PRD §12 states for this row.
SELECT pg_temp.act('clock-to-jun17', '11111111-0000-0000-0000-000000000008',
  jsonb_build_object('kind','advance_clock','days', 16));
SELECT pg_temp.act('list-0128', '11111111-0000-0000-0000-000000000004',
  jsonb_build_object('kind','publish_listing','listingId','7a000000-0000-0000-0000-000000000128',
                     'payableId','9a000000-0000-0000-0000-000000000128',
                     'sellerWallet','0x7009e5000000000000000000000000000000d128',
                     'quantityBase', 3200000000, 'minPriceBase', 3129000000));
SELECT pg_temp.act('bid-0128', '11111111-0000-0000-0000-000000000006',
  jsonb_build_object('kind','place_bid','bidId','b0000000-0000-0000-0000-000000000128',
                     'listingId','7a000000-0000-0000-0000-000000000128',
                     'bidderWallet','0x1e4de40000000000000000000000000000004b13',
                     'priceBase', 3129000000, 'fundingCode','USDC'));
SELECT pg_temp.act('accept-0128', '11111111-0000-0000-0000-000000000004',
  jsonb_build_object('kind','accept_bid','listingId','7a000000-0000-0000-0000-000000000128',
                     'bidId','b0000000-0000-0000-0000-000000000128'));

-- 15 September: TP-2026-0128 matures and ADATA settles it.
SELECT pg_temp.act('clock-to-sep15', '11111111-0000-0000-0000-000000000008',
  jsonb_build_object('kind','advance_clock','days', 90));
SELECT pg_temp.act('settle-0128', '11111111-0000-0000-0000-000000000001',
  jsonb_build_object('kind','settle_maturity','payableId','9a000000-0000-0000-0000-000000000128'));

-- TP-2026-0119 passed its 17 August due date unpaid and is deliberately left
-- that way. PRD §7: "Recovery is a read-only scenario, not an operational
-- workflow." Nothing settles it; the screens derive Overdue from the clock.

-- ============================================================================
--  1 October: the demo present
-- ============================================================================
SELECT pg_temp.act('clock-to-t0', '11111111-0000-0000-0000-000000000008',
  jsonb_build_object('kind','advance_clock','days', 16));

-- The three live payables, issued today with the tenors PRD §12 states.
INSERT INTO app.payable (id, ref, anchor_id, original_supplier_id, invoice_ref,
                         face_base, maturity_date, grade, grade_rationale, lifecycle_status) VALUES
  ('9a000000-0000-0000-0000-000000000143', 'TP-2026-0143', 'e0000000-0000-0000-0000-00000000ada7',
   'e0000000-0000-0000-0000-000000000c43', 'INV-TW-90412', 12000000000, '2026-10-31', 'AAA',
   'Anchor obligor prime grade, shortest tenor in the programme. Sample value assigned by StraitsX, not an external rating.', 'certified'),
  ('9a000000-0000-0000-0000-000000000141', 'TP-2026-0141', 'e0000000-0000-0000-0000-00000000ada7',
   'e0000000-0000-0000-0000-000000000c41', 'INV-TW-88213', 2500000000, '2026-12-30', 'AA',
   'Anchor obligor investment grade. Sample value assigned by StraitsX, not an external rating.', 'certified'),
  ('9a000000-0000-0000-0000-000000000142', 'TP-2026-0142', 'e0000000-0000-0000-0000-00000000ada7',
   'e0000000-0000-0000-0000-000000000c42', 'INV-TW-88977', 480000000, '2026-11-30', 'A',
   'Anchor obligor upper-medium grade, smallest ticket. Sample value assigned by StraitsX, not an external rating.', 'certified');

SELECT pg_temp.act('issue-0143', '11111111-0000-0000-0000-000000000008',
  jsonb_build_object('kind','issue_payable','payableId','9a000000-0000-0000-0000-000000000143',
                     'toWallet','0x6d1470000000000000000000000000000000b43c','tokenId', 143));
SELECT pg_temp.act('issue-0141', '11111111-0000-0000-0000-000000000008',
  jsonb_build_object('kind','issue_payable','payableId','9a000000-0000-0000-0000-000000000141',
                     'toWallet','0x509911000000000000000000000000000000f88a','tokenId', 141));
SELECT pg_temp.act('issue-0142', '11111111-0000-0000-0000-000000000008',
  jsonb_build_object('kind','issue_payable','payableId','9a000000-0000-0000-0000-000000000142',
                     'toWallet','0x4851ca000000000000000000000000000000e42d','tokenId', 142));

-- The seeded asks from PRD §12. Yields follow from the remaining days.
SELECT pg_temp.act('list-0143', '11111111-0000-0000-0000-000000000004',
  jsonb_build_object('kind','publish_listing','listingId','7a000000-0000-0000-0000-000000000143',
                     'payableId','9a000000-0000-0000-0000-000000000143',
                     'sellerWallet','0x6d1470000000000000000000000000000000b43c',
                     'quantityBase', 12000000000, 'minPriceBase', 11930400000));  -- 99.42%
SELECT pg_temp.act('list-0141', '11111111-0000-0000-0000-000000000003',
  jsonb_build_object('kind','publish_listing','listingId','7a000000-0000-0000-0000-000000000141',
                     'payableId','9a000000-0000-0000-0000-000000000141',
                     'sellerWallet','0x509911000000000000000000000000000000f88a',
                     'quantityBase', 2500000000, 'minPriceBase', 2446250000));    -- 97.85%
SELECT pg_temp.act('list-0142', '11111111-0000-0000-0000-000000000005',
  jsonb_build_object('kind','publish_listing','listingId','7a000000-0000-0000-0000-000000000142',
                     'payableId','9a000000-0000-0000-0000-000000000142',
                     'sellerWallet','0x4851ca000000000000000000000000000000e42d',
                     'quantityBase', 480000000, 'minPriceBase', 472320000));      -- 98.40%

-- PRD §12: "Include a suggested 97.85% price and two competing bids on another
-- seeded listing to make the bid book immediately visible."
SELECT pg_temp.act('bid-0142-bank', '11111111-0000-0000-0000-000000000006',
  jsonb_build_object('kind','place_bid','bidId','b0000000-0000-0000-0000-000000000142',
                     'listingId','7a000000-0000-0000-0000-000000000142',
                     'bidderWallet','0x1e4de40000000000000000000000000000004b13',
                     'priceBase', 472320000, 'fundingCode','USDC'));
SELECT pg_temp.act('bid-0142-fund', '11111111-0000-0000-0000-000000000007',
  jsonb_build_object('kind','place_bid','bidId','b0000000-0000-0000-0000-000000000242',
                     'listingId','7a000000-0000-0000-0000-000000000142',
                     'bidderWallet','0xfe5700000000000000000000000000000000d902',
                     'priceBase', 470880000, 'fundingCode','XSGD'));              -- 98.10%, a shade lower

-- ============================================================================
--  The Series — PRD §6 and §12
-- ============================================================================
-- Twelve small invoices with the same anchor, currency and maturity, bundled
-- into one lot worth a bank's time. 180,000 XUSD across twelve 15,000 tickets.
INSERT INTO app.series (id, ref, anchor_id, maturity_date, grade, grade_rationale)
VALUES ('5e000000-0000-0000-0000-000000000430', 'SERIES-2026-Q4-30D',
        'e0000000-0000-0000-0000-00000000ada7', '2026-10-31', 'A',
        'Aggregate of twelve tier-2 suppliers against one anchor obligation. Grade assigned to the lot, not to its members. Sample value.')
ON CONFLICT DO NOTHING;

DO $$
DECLARE
  v_names text[] := ARRAY[
    'Cheng Hui Fasteners','Tai Yuan Coatings','Bao Sheng Tooling','Jin Li Connectors',
    'He Feng Castings','Wan Ho Bearings','Shun Da Seals','Li Chuan Wiring',
    'Guo Xin Enclosures','Pei Yu Optics','Zhong An Springs','Mao Chi Laminates'];
  v_series uuid := '5e000000-0000-0000-0000-000000000430';
  v_holder text := '0x6d1470000000000000000000000000000000b43c';
  v_entity uuid;
  v_payable uuid;
  i int;
BEGIN
  FOR i IN 1..12 LOOP
    v_entity  := ('e0000000-0000-0000-0000-0000000005' || lpad(i::text, 2, '0'))::uuid;
    v_payable := ('9a000000-0000-0000-0000-0000000005' || lpad(i::text, 2, '0'))::uuid;

    INSERT INTO app.entity (id, name, entity_type, certification_status)
    VALUES (v_entity, v_names[i], 'supplier', 'certified');
    INSERT INTO app.wallet (address, entity_id)
    VALUES ('0x' || lpad(to_hex(3000000 + i), 8, '0') || repeat('0', 28) || lpad(to_hex(i), 4, '0'), v_entity);

    INSERT INTO app.payable (id, ref, anchor_id, original_supplier_id, invoice_ref,
                             face_base, maturity_date, grade, grade_rationale, lifecycle_status, series_id)
    VALUES (v_payable, 'TP-2026-05' || lpad(i::text, 2, '0'),
            'e0000000-0000-0000-0000-00000000ada7', v_entity,
            'INV-TW-7' || lpad((3000 + i)::text, 4, '0'),
            150000000, '2026-10-31', 'A',
            'Series member. The lot carries the grade; see SERIES-2026-Q4-30D. Sample value.',
            'certified', v_series);

    -- Every member issues to the same wallet, because PRD §6 requires a series
    -- to be wholly held by one seller before it can move as a lot.
    PERFORM pg_temp.act('issue-series-' || i, '11111111-0000-0000-0000-000000000008',
      jsonb_build_object('kind','issue_payable','payableId', v_payable,
                         'toWallet', v_holder, 'tokenId', 500 + i));
  END LOOP;
END $$;

SELECT pg_temp.act('list-series', '11111111-0000-0000-0000-000000000004',
  jsonb_build_object('kind','publish_listing','listingId','7a000000-0000-0000-0000-000000000430',
                     'seriesId','5e000000-0000-0000-0000-000000000430',
                     'sellerWallet','0x6d1470000000000000000000000000000000b43c',
                     'minPriceBase', 1785600000));   -- 99.20% of 180,000

-- ============================================================================
--  The ERP inbox — PRD §8 screen 2
-- ============================================================================
-- Ten approved invoices the preparer can import. The first is the one the
-- runbook uses: 250,000 XUSD on 90-day terms to the active supplier, with its
-- own reference so issuing it does not collide with TP-2026-0141.
INSERT INTO app.erp_invoice (doc_no, supplier_id, invoice_ref, amount_base, terms_days, approved_on, cost_centre) VALUES
  ('5100084412', 'e0000000-0000-0000-0000-000000000c41', 'INV-TW-88Q4A', 2500000000,  90, '2026-09-28', 'TW-PROC-01'),
  ('5100084413', 'e0000000-0000-0000-0000-000000000c43', 'INV-TW-90551',  8750000000,  60, '2026-09-28', 'TW-PROC-01'),
  ('5100084414', 'e0000000-0000-0000-0000-000000000c42', 'INV-TW-89004',   620000000,  30, '2026-09-29', 'TW-PROC-02'),
  ('5100084415', 'e0000000-0000-0000-0000-000000000c41', 'INV-TW-88301',  1440000000, 120, '2026-09-29', 'TW-PROC-01'),
  ('5100084416', 'e0000000-0000-0000-0000-000000000c28', 'INV-TW-72118',  2980000000,  90, '2026-09-30', 'TW-PROC-03'),
  ('5100084417', 'e0000000-0000-0000-0000-000000000c43', 'INV-TW-90588',   410000000,  45, '2026-09-30', 'TW-PROC-02'),
  ('5100084418', 'e0000000-0000-0000-0000-000000000c19', 'INV-TW-66401',   890000000, 180, '2026-09-30', 'TW-PROC-03'),
  ('5100084419', 'e0000000-0000-0000-0000-000000000c42', 'INV-TW-89112',  1130000000,  60, '2026-10-01', 'TW-PROC-02'),
  ('5100084420', 'e0000000-0000-0000-0000-000000000c41', 'INV-TW-88460',  3360000000,  90, '2026-10-01', 'TW-PROC-01'),
  ('5100084421', 'e0000000-0000-0000-0000-000000000c43', 'INV-TW-90613',   275000000,  30, '2026-10-01', 'TW-PROC-02');

-- ============================================================================
--  Declare the present to be T0
-- ============================================================================
-- The clock has walked from 1 June to 1 October to produce the histories above.
-- Re-anchoring T0 here makes 1 October the zero point the demo controls reset
-- to, while every journal entry keeps the world_date it actually happened on.
-- This is the one direct write to app.world in the system; ledger.post() owns
-- the clock everywhere else.
UPDATE app.world SET t0 = t0 + offset_days, offset_days = 0 WHERE only_row;

-- ---------------------------------------------------------------- the proof --
DO $$
DECLARE v_n bigint; v_date date;
BEGIN
  SELECT t0 + offset_days INTO v_date FROM app.world;
  IF v_date <> DATE '2026-10-01' THEN
    RAISE EXCEPTION 'seed finished at %, expected 2026-10-01', v_date;
  END IF;

  SELECT count(*) INTO v_n FROM ledger.prove_books_balance();
  IF v_n <> 0 THEN RAISE EXCEPTION 'seeded books do not reconcile on % rows', v_n; END IF;

  SELECT count(*) INTO v_n FROM (
    SELECT asset_id FROM ledger.account_balance GROUP BY asset_id HAVING SUM(balance) <> 0) b;
  IF v_n <> 0 THEN RAISE EXCEPTION '% seeded assets are not conserved', v_n; END IF;

  RAISE NOTICE 'seeded: world at %, books reconcile', v_date;
END $$;
\set QUIET off
