-- ============================================================================
--  Seed world — PRD §12
-- ============================================================================
-- The demo runs on a public URL, indefinitely, and anyone can open it. Two
-- consequences shape this file.
--
-- FIRST, T0 IS THE DAY THE WORLD WAS SEEDED, not a date written down here. A
-- world anchored to a fixed calendar date looks stale the moment it is opened
-- months later: every tenor short, every maturity already passed. PRD §12
-- already says "Dates are relative to demo T0; fixed references are identifiers
-- rather than live dates", so the TP-2026-xxxx references stay exactly as the
-- PRD names them while every date is computed from `pg_temp.t0()`.
--
-- SECOND, THE PAST IS SEEDED BY LIVING THROUGH IT. The settled and overdue rows
-- need histories that already happened. Rather than writing ledger rows by hand
-- and hoping they reconcile, the clock starts 200 days back and every event is
-- a real `ledger.post()` call, exactly as the application would make it. The
-- books therefore prove themselves at the end rather than being made to agree.
--
-- Fictional throughout. ADATA is the intentional named-anchor exception.

-- No psql meta-commands anywhere in this file: the Reset world control
-- executes it through the driver, where a backslash directive is a syntax error.
SET client_min_messages TO warning;

-- T0: the demo present. Everything else is an offset from it.
CREATE OR REPLACE FUNCTION pg_temp.t0() RETURNS date LANGUAGE sql STABLE AS
$$ SELECT CURRENT_DATE $$;

-- A thin wrapper so the seed reads as a sequence of business events rather than
-- a wall of jsonb construction.
CREATE OR REPLACE FUNCTION pg_temp.act(p_key text, p_actor uuid, p_intent jsonb)
RETURNS jsonb LANGUAGE sql AS $$
  SELECT ledger.post(jsonb_build_object(
    'idempotencyKey', md5(p_key)::uuid, 'actorUserId', p_actor, 'intent', p_intent));
$$;

-- Start 200 days before the present so there is room for real history.
INSERT INTO app.world (t0, offset_days) VALUES (pg_temp.t0() - 200, 0);

-- ============================================================================
--  Parties
-- ============================================================================
INSERT INTO app.entity (id, name, entity_type, certification_status, programme_limit_base) VALUES
  ('e0000000-0000-0000-0000-00000000ada7', 'ADATA Technology Co., Ltd.', 'anchor',   'certified', 250000000000),
  ('e0000000-0000-0000-0000-000000005787', 'StraitsX',                   'platform', 'certified', NULL);

-- Suppliers with interactive accounts: Taiwanese component makers of the kind
-- that sit in an electronics anchor's payables book.
INSERT INTO app.entity (id, name, entity_type, certification_status) VALUES
  ('e0000000-0000-0000-0000-000000000c41', 'Chien Yu Precision',    'supplier', 'certified'),
  ('e0000000-0000-0000-0000-000000000c43', 'Ming Kuo Components',   'supplier', 'certified'),
  ('e0000000-0000-0000-0000-000000000c42', 'Hsin Ta Electronics',   'supplier', 'certified'),
  ('e0000000-0000-0000-0000-000000000c28', 'Yung Sheng Metals',     'supplier', 'certified'),
  ('e0000000-0000-0000-0000-000000000c19', 'Fu Hsing Plastics',     'supplier', 'certified'),
  ('e0000000-0000-0000-0000-000000000c44', 'Wei Chuan Tooling',     'supplier', 'certified'),
  ('e0000000-0000-0000-0000-000000000c45', 'Da An Circuit Systems', 'supplier', 'certified'),
  ('e0000000-0000-0000-0000-000000000c46', 'Heng Li Thermal',       'supplier', 'certified');

-- Institutional lenders. PRD §12 asks for one predominantly in USDC and one in
-- XUSD; two more give the marketplace a believable bid book.
INSERT INTO app.entity (id, name, entity_type, certification_status) VALUES
  ('e0000000-0000-0000-0000-00000000ba17', 'Meridian Trade Bank',     'lender', 'certified'),
  ('e0000000-0000-0000-0000-00000000fd21', 'Kestrel Credit Fund',     'lender', 'certified'),
  ('e0000000-0000-0000-0000-00000000ca93', 'Rakuyo Capital Partners', 'lender', 'certified'),
  ('e0000000-0000-0000-0000-00000000b755', 'Brightwater Treasury',    'lender', 'certified');

INSERT INTO app.wallet (address, entity_id) VALUES
  ('0xada7a0000000000000000000000000000000c21d', 'e0000000-0000-0000-0000-00000000ada7'),
  ('0x57a715000000000000000000000000000000a001', 'e0000000-0000-0000-0000-000000005787'),
  ('0x509911000000000000000000000000000000f88a', 'e0000000-0000-0000-0000-000000000c41'),
  ('0x6d1470000000000000000000000000000000b43c', 'e0000000-0000-0000-0000-000000000c43'),
  ('0x4851ca000000000000000000000000000000e42d', 'e0000000-0000-0000-0000-000000000c42'),
  ('0x7009e5000000000000000000000000000000d128', 'e0000000-0000-0000-0000-000000000c28'),
  ('0x5f0451000000000000000000000000000000c119', 'e0000000-0000-0000-0000-000000000c19'),
  ('0x2b7744000000000000000000000000000000a144', 'e0000000-0000-0000-0000-000000000c44'),
  ('0x8c3390000000000000000000000000000000e145', 'e0000000-0000-0000-0000-000000000c45'),
  ('0x91da22000000000000000000000000000000b146', 'e0000000-0000-0000-0000-000000000c46'),
  ('0x1e4de40000000000000000000000000000004b13', 'e0000000-0000-0000-0000-00000000ba17'),
  ('0xfe5700000000000000000000000000000000d902', 'e0000000-0000-0000-0000-00000000fd21'),
  ('0x3ca967000000000000000000000000000000c093', 'e0000000-0000-0000-0000-00000000ca93'),
  ('0xb7e155000000000000000000000000000000f755', 'e0000000-0000-0000-0000-00000000b755');

INSERT INTO app.app_user (id, entity_id, name, role, mock_kyc_verified, institutional_eligible) VALUES
  ('11111111-0000-0000-0000-000000000001', 'e0000000-0000-0000-0000-00000000ada7', 'Wei-Ling Chen',      'adata_preparer', true,  false),
  ('11111111-0000-0000-0000-000000000002', 'e0000000-0000-0000-0000-00000000ada7', 'Hsu Po-Chun',        'adata_checker',  true,  false),
  ('11111111-0000-0000-0000-000000000003', 'e0000000-0000-0000-0000-000000000c41', 'Tang Mei-Hua',       'supplier',       true,  false),
  ('11111111-0000-0000-0000-000000000004', 'e0000000-0000-0000-0000-000000000c43', 'Kuo Shih-Chieh',     'supplier',       true,  false),
  ('11111111-0000-0000-0000-000000000005', 'e0000000-0000-0000-0000-000000000c42', 'Lin Ya-Ting',        'supplier',       true,  false),
  ('11111111-0000-0000-0000-000000000009', 'e0000000-0000-0000-0000-000000000c28', 'Chang Jui-Feng',     'supplier',       true,  false),
  ('11111111-0000-0000-0000-00000000000a', 'e0000000-0000-0000-0000-000000000c19', 'Hsieh Wan-Ju',       'supplier',       true,  false),
  ('11111111-0000-0000-0000-00000000000b', 'e0000000-0000-0000-0000-000000000c44', 'Peng Chia-Hao',      'supplier',       true,  false),
  ('11111111-0000-0000-0000-00000000000c', 'e0000000-0000-0000-0000-000000000c45', 'Su Yi-Chen',         'supplier',       true,  false),
  ('11111111-0000-0000-0000-00000000000d', 'e0000000-0000-0000-0000-000000000c46', 'Ho Ming-Te',         'supplier',       true,  false),
  ('11111111-0000-0000-0000-000000000006', 'e0000000-0000-0000-0000-00000000ba17', 'Rina Okafor',        'lender',         true,  true),
  ('11111111-0000-0000-0000-000000000007', 'e0000000-0000-0000-0000-00000000fd21', 'Sébastien Baptiste', 'lender',         true,  true),
  ('11111111-0000-0000-0000-00000000000e', 'e0000000-0000-0000-0000-00000000ca93', 'Aiko Tanabe',        'lender',         true,  true),
  ('11111111-0000-0000-0000-00000000000f', 'e0000000-0000-0000-0000-00000000b755', 'Dolores Marchetti',  'lender',         true,  true),
  ('11111111-0000-0000-0000-000000000008', 'e0000000-0000-0000-0000-000000005787', 'Nadia Rahman',       'straitsx_admin', true,  false),
  -- Second accounts at four organisations. A finance team is more than one
  -- person, and PRD §5 gives the admin the power to remove a user: without a
  -- company that has two, every row on the accounts screen would read "cannot
  -- remove", because removing the last account would strand that company's
  -- wallet. These make the control demonstrable on a fresh world.
  ('11111111-0000-0000-0000-000000000010', 'e0000000-0000-0000-0000-000000000c41', 'Chou Yi-Hsuan',      'supplier',       true,  false),
  ('11111111-0000-0000-0000-000000000011', 'e0000000-0000-0000-0000-000000000c43', 'Weng Pei-Shan',      'supplier',       true,  false),
  ('11111111-0000-0000-0000-000000000012', 'e0000000-0000-0000-0000-00000000ba17', 'Tomás Iglesias',     'lender',         true,  true),
  ('11111111-0000-0000-0000-000000000013', 'e0000000-0000-0000-0000-00000000ca93', 'Harumi Sato',        'lender',         true,  true);

-- ============================================================================
--  Funding
-- ============================================================================
-- PRD §12: "Pre-fund both lenders in all four assets, with one predominantly
-- funded in USDC and the other in XUSD." Four lenders, each with a house style,
-- so the funding-asset picker has something to show whichever one is acting.
DO $$
DECLARE r RECORD;
BEGIN
  FOR r IN
    SELECT * FROM (VALUES
      ('0x1e4de40000000000000000000000000000004b13', '11111111-0000-0000-0000-000000000006',
        62000000000::bigint, 184000000000::bigint, 21000000000::bigint, 14000000000::bigint),
      ('0xfe5700000000000000000000000000000000d902', '11111111-0000-0000-0000-000000000007',
        213000000000, 26000000000, 12000000000, 38000000000),
      ('0x3ca967000000000000000000000000000000c093', '11111111-0000-0000-0000-00000000000e',
        31000000000, 18000000000,  9000000000, 96000000000),
      ('0xb7e155000000000000000000000000000000f755', '11111111-0000-0000-0000-00000000000f',
        45000000000, 33000000000, 71000000000,  8000000000)
    ) AS t(wallet, actor, xusd, usdc, usdt, xsgd)
  LOOP
    PERFORM pg_temp.act('fund-' || r.wallet || '-XUSD', r.actor::uuid,
      jsonb_build_object('kind','top_up','wallet',r.wallet,'cashCode','XUSD','amountBase',r.xusd));
    PERFORM pg_temp.act('fund-' || r.wallet || '-USDC', r.actor::uuid,
      jsonb_build_object('kind','top_up','wallet',r.wallet,'cashCode','USDC','amountBase',r.usdc));
    PERFORM pg_temp.act('fund-' || r.wallet || '-USDT', r.actor::uuid,
      jsonb_build_object('kind','top_up','wallet',r.wallet,'cashCode','USDT','amountBase',r.usdt));
    PERFORM pg_temp.act('fund-' || r.wallet || '-XSGD', r.actor::uuid,
      jsonb_build_object('kind','top_up','wallet',r.wallet,'cashCode','XSGD','amountBase',r.xsgd));
  END LOOP;
END $$;

-- ADATA must be able to discharge everything outstanding at maturity.
SELECT pg_temp.act('fund-anchor', '11111111-0000-0000-0000-000000000001',
  jsonb_build_object('kind','top_up','wallet','0xada7a0000000000000000000000000000000c21d',
                     'cashCode','XUSD','amountBase', 400000000000));

-- ============================================================================
--  History: payables that have already run their course
-- ============================================================================
-- Each is issued, accepted, financed and (except the overdue one) settled, by
-- walking the clock forward. They give the portfolio, explorer and programme
-- oversight screens something real to show on arrival.
CREATE TEMP TABLE seed_history (
  ref text, supplier_id uuid, supplier_wallet text, supplier_user uuid,
  face bigint, mat_offset int, grade text, ask_bps int,
  buyer_wallet text, buyer_user uuid, funding text, settle boolean
);
INSERT INTO seed_history VALUES
  -- PRD §12's settled row. 312,900 over 90 days against 320,000 face realises
  -- the 9.2% the PRD states; derived in docs/ASSUMPTIONS.md.
  ('TP-2026-0128','e0000000-0000-0000-0000-000000000c28','0x7009e5000000000000000000000000000000d128','11111111-0000-0000-0000-000000000009',
    3200000000, -16, 'AA', 9778, '0x1e4de40000000000000000000000000000004b13','11111111-0000-0000-0000-000000000006','USDC', true),
  ('TP-2026-0104','e0000000-0000-0000-0000-000000000c41','0x509911000000000000000000000000000000f88a','11111111-0000-0000-0000-000000000003',
    1850000000, -120, 'AAA', 9931, '0xfe5700000000000000000000000000000000d902','11111111-0000-0000-0000-000000000007','XUSD', true),
  ('TP-2026-0111','e0000000-0000-0000-0000-000000000c43','0x6d1470000000000000000000000000000000b43c','11111111-0000-0000-0000-000000000004',
    7400000000, -60, 'AA', 9812, '0x3ca967000000000000000000000000000000c093','11111111-0000-0000-0000-00000000000e','XSGD', true),
  ('TP-2026-0117','e0000000-0000-0000-0000-000000000c45','0x8c3390000000000000000000000000000000e145','11111111-0000-0000-0000-00000000000c',
    980000000, -35, 'A', 9765, '0xb7e155000000000000000000000000000000f755','11111111-0000-0000-0000-00000000000f','USDT', true),
  -- PRD §12's overdue showcase. Never settled; passes its date unpaid.
  ('TP-2026-0119','e0000000-0000-0000-0000-000000000c19','0x5f0451000000000000000000000000000000c119','11111111-0000-0000-0000-00000000000a',
    750000000, -45, 'A', 0, NULL, NULL, NULL, false);

DO $$
DECLARE h RECORD; v_id uuid; v_list uuid; v_tok int := 100;
BEGIN
  FOR h IN SELECT * FROM seed_history ORDER BY mat_offset LOOP
    v_tok := v_tok + 1;
    v_id := gen_random_uuid();
    INSERT INTO app.payable (id, ref, anchor_id, original_supplier_id, invoice_ref,
                             face_base, maturity_date, grade, grade_rationale, lifecycle_status)
    VALUES (v_id, h.ref, 'e0000000-0000-0000-0000-00000000ada7', h.supplier_id,
            'INV-TW-' || (60000 + v_tok)::text, h.face, pg_temp.t0() + h.mat_offset,
            h.grade::app.credit_grade,
            CASE h.grade
              WHEN 'AAA' THEN 'Anchor obligor prime grade. Sample value assigned by StraitsX, not an external rating.'
              WHEN 'AA'  THEN 'Anchor obligor investment grade. Sample value assigned by StraitsX, not an external rating.'
              ELSE 'Anchor obligor upper-medium grade. Sample value assigned by StraitsX, not an external rating.'
            END, 'certified');

    PERFORM pg_temp.act('h-issue-' || h.ref, '11111111-0000-0000-0000-000000000008',
      jsonb_build_object('kind','issue_payable','payableId',v_id,'toWallet',h.supplier_wallet,'tokenId',v_tok));
    PERFORM pg_temp.act('h-receipt-' || h.ref, h.supplier_user,
      jsonb_build_object('kind','accept_receipt','payableId',v_id));

    IF h.buyer_wallet IS NOT NULL THEN
      PERFORM pg_temp.act('h-list-' || h.ref, h.supplier_user,
        jsonb_build_object('kind','publish_listing','payableId',v_id,'sellerWallet',h.supplier_wallet,
                           'quantityBase',h.face,'minPriceBase',(h.face * h.ask_bps) / 10000));
      SELECT id INTO v_list FROM app.listing WHERE target_payable_id = v_id AND status = 'open';
      PERFORM pg_temp.act('h-bid-' || h.ref, h.buyer_user,
        jsonb_build_object('kind','place_bid','listingId',v_list,'bidderWallet',h.buyer_wallet,
                           'priceBase',(h.face * h.ask_bps) / 10000,'fundingCode',h.funding));
      PERFORM pg_temp.act('h-accept-' || h.ref, h.supplier_user,
        jsonb_build_object('kind','accept_bid','listingId',v_list,
          'bidId',(SELECT id FROM app.bid WHERE listing_id = v_list AND status = 'placed' LIMIT 1)));
    END IF;
  END LOOP;
END $$;

-- Walk the clock to the present, settling each on its due date. The overdue one
-- is deliberately skipped and passes its date unpaid.
DO $$
DECLARE h RECORD; v_here int := -200;
BEGIN
  FOR h IN SELECT * FROM seed_history WHERE settle ORDER BY mat_offset LOOP
    PERFORM pg_temp.act('h-clock-' || h.ref, '11111111-0000-0000-0000-000000000008',
      jsonb_build_object('kind','advance_clock','days', h.mat_offset - v_here));
    v_here := h.mat_offset;
    PERFORM pg_temp.act('h-settle-' || h.ref, '11111111-0000-0000-0000-000000000001',
      jsonb_build_object('kind','settle_maturity','payableId',
                         (SELECT id FROM app.payable WHERE ref = h.ref)));
  END LOOP;
  PERFORM pg_temp.act('clock-to-t0', '11111111-0000-0000-0000-000000000008',
    jsonb_build_object('kind','advance_clock','days', -v_here));
END $$;

-- ============================================================================
--  The present: live payables
-- ============================================================================
-- The three PRD §12 rows keep their exact figures. The rest give the
-- marketplace and supplier screens enough depth to read as a programme rather
-- than a fixture: a spread of grades, tenors from 30 to 180 days, tickets from
-- 26,000 to 1,560,000, some held rather than listed, and two sold in part so a
-- split holding exists on arrival.
CREATE TEMP TABLE seed_live (
  ref text, supplier_id uuid, supplier_wallet text, supplier_user uuid,
  face bigint, tenor int, grade text, ask_bps int, list boolean, sell_bps int,
  -- Buy-now must be at or above the minimum ask: it is what a lender pays to
  -- take the lot immediately rather than bid and wait for the seller.
  buy_bps int
);
INSERT INTO seed_live VALUES
  ('TP-2026-0143','e0000000-0000-0000-0000-000000000c43','0x6d1470000000000000000000000000000000b43c','11111111-0000-0000-0000-000000000004',
    12000000000, 30, 'AAA', 9942, true, NULL, 9955),
  ('TP-2026-0141','e0000000-0000-0000-0000-000000000c41','0x509911000000000000000000000000000000f88a','11111111-0000-0000-0000-000000000003',
    2500000000, 90, 'AA', 9785, true, NULL, 9805),
  ('TP-2026-0142','e0000000-0000-0000-0000-000000000c42','0x4851ca000000000000000000000000000000e42d','11111111-0000-0000-0000-000000000005',
    480000000, 60, 'A', 9840, true, NULL, NULL),
  ('TP-2026-0145','e0000000-0000-0000-0000-000000000c44','0x2b7744000000000000000000000000000000a144','11111111-0000-0000-0000-00000000000b',
    3400000000, 45, 'AA', 9880, true, NULL, 9895),
  ('TP-2026-0146','e0000000-0000-0000-0000-000000000c45','0x8c3390000000000000000000000000000000e145','11111111-0000-0000-0000-00000000000c',
    15600000000, 120, 'AAA', 9705, true, NULL, 9730),
  ('TP-2026-0147','e0000000-0000-0000-0000-000000000c46','0x91da22000000000000000000000000000000b146','11111111-0000-0000-0000-00000000000d',
    260000000, 30, 'A', 9915, true, NULL, NULL),
  ('TP-2026-0148','e0000000-0000-0000-0000-000000000c28','0x7009e5000000000000000000000000000000d128','11111111-0000-0000-0000-000000000009',
    5900000000, 180, 'AA', 9520, true, NULL, 9560),
  ('TP-2026-0149','e0000000-0000-0000-0000-000000000c42','0x4851ca000000000000000000000000000000e42d','11111111-0000-0000-0000-000000000005',
    880000000, 75, 'A', 9795, true, NULL, 9815),
  -- Held, not listed: a supplier choosing to keep the receivable.
  ('TP-2026-0150','e0000000-0000-0000-0000-000000000c44','0x2b7744000000000000000000000000000000a144','11111111-0000-0000-0000-00000000000b',
    1250000000, 60, 'AA', 0, false, NULL, NULL),
  ('TP-2026-0151','e0000000-0000-0000-0000-000000000c46','0x91da22000000000000000000000000000000b146','11111111-0000-0000-0000-00000000000d',
    720000000, 90, 'A', 0, false, NULL, NULL),
  -- Partially sold, so a payable with two current holders exists on arrival.
  ('TP-2026-0152','e0000000-0000-0000-0000-000000000c41','0x509911000000000000000000000000000000f88a','11111111-0000-0000-0000-000000000003',
    4000000000, 100, 'AA', 0, false, 9750, NULL),
  ('TP-2026-0153','e0000000-0000-0000-0000-000000000c43','0x6d1470000000000000000000000000000000b43c','11111111-0000-0000-0000-000000000004',
    9200000000, 150, 'AAA', 0, false, 9610, NULL);

DO $$
DECLARE l RECORD; v_id uuid; v_tok int := 140; v_list uuid; v_half bigint;
BEGIN
  FOR l IN SELECT * FROM seed_live LOOP
    v_tok := v_tok + 1;
    v_id := gen_random_uuid();
    INSERT INTO app.payable (id, ref, anchor_id, original_supplier_id, invoice_ref,
                             face_base, maturity_date, grade, grade_rationale, lifecycle_status)
    VALUES (v_id, l.ref, 'e0000000-0000-0000-0000-00000000ada7', l.supplier_id,
            'INV-TW-' || (88000 + v_tok)::text, l.face, pg_temp.t0() + l.tenor,
            l.grade::app.credit_grade,
            CASE l.grade
              WHEN 'AAA' THEN 'Anchor obligor prime grade. Sample value assigned by StraitsX, not an external rating.'
              WHEN 'AA'  THEN 'Anchor obligor investment grade. Sample value assigned by StraitsX, not an external rating.'
              ELSE 'Anchor obligor upper-medium grade. Sample value assigned by StraitsX, not an external rating.'
            END, 'certified');

    PERFORM pg_temp.act('l-issue-' || l.ref, '11111111-0000-0000-0000-000000000008',
      jsonb_build_object('kind','issue_payable','payableId',v_id,'toWallet',l.supplier_wallet,'tokenId',v_tok));
    PERFORM pg_temp.act('l-receipt-' || l.ref, l.supplier_user,
      jsonb_build_object('kind','accept_receipt','payableId',v_id));

    IF l.list THEN
      PERFORM pg_temp.act('l-list-' || l.ref, l.supplier_user,
        jsonb_build_object('kind','publish_listing','payableId',v_id,'sellerWallet',l.supplier_wallet,
                           'quantityBase',l.face,'minPriceBase',(l.face * l.ask_bps) / 10000)
        || CASE WHEN l.buy_bps IS NULL THEN '{}'::jsonb
                ELSE jsonb_build_object('buyNowPriceBase',(l.face * l.buy_bps) / 10000) END);
    END IF;

    -- A partial sale: list half, sell it, keep the rest.
    IF l.sell_bps IS NOT NULL THEN
      v_half := (l.face / 20000) * 10000;   -- half, rounded to a whole base unit
      PERFORM pg_temp.act('l-plist-' || l.ref, l.supplier_user,
        jsonb_build_object('kind','publish_listing','payableId',v_id,'sellerWallet',l.supplier_wallet,
                           'quantityBase',v_half,'minPriceBase',(v_half * l.sell_bps) / 10000));
      SELECT id INTO v_list FROM app.listing WHERE target_payable_id = v_id AND status = 'open';
      PERFORM pg_temp.act('l-pbid-' || l.ref, '11111111-0000-0000-0000-000000000007',
        jsonb_build_object('kind','place_bid','listingId',v_list,
                           'bidderWallet','0xfe5700000000000000000000000000000000d902',
                           'priceBase',(v_half * l.sell_bps) / 10000,'fundingCode','XUSD'));
      PERFORM pg_temp.act('l-paccept-' || l.ref, l.supplier_user,
        jsonb_build_object('kind','accept_bid','listingId',v_list,
          'bidId',(SELECT id FROM app.bid WHERE listing_id = v_list AND status = 'placed' LIMIT 1)));
    END IF;
  END LOOP;
END $$;

-- PRD §12: "two competing bids on another seeded listing to make the bid book
-- immediately visible." Three lenders bid on the 48,000 ticket, at a spread, so
-- the Offers screen has a real choice on it.
DO $$
DECLARE v_list uuid; v_face bigint := 480000000;
BEGIN
  SELECT l.id INTO v_list FROM app.listing l JOIN app.payable p ON p.id = l.target_payable_id
   WHERE p.ref = 'TP-2026-0142' AND l.status = 'open';
  PERFORM pg_temp.act('bidbook-a', '11111111-0000-0000-0000-000000000006',
    jsonb_build_object('kind','place_bid','listingId',v_list,
      'bidderWallet','0x1e4de40000000000000000000000000000004b13',
      'priceBase',(v_face * 9840) / 10000,'fundingCode','USDC'));
  PERFORM pg_temp.act('bidbook-b', '11111111-0000-0000-0000-000000000007',
    jsonb_build_object('kind','place_bid','listingId',v_list,
      'bidderWallet','0xfe5700000000000000000000000000000000d902',
      'priceBase',(v_face * 9810) / 10000,'fundingCode','XSGD'));
  PERFORM pg_temp.act('bidbook-c', '11111111-0000-0000-0000-00000000000f',
    jsonb_build_object('kind','place_bid','listingId',v_list,
      'bidderWallet','0xb7e155000000000000000000000000000000f755',
      'priceBase',(v_face * 9785) / 10000,'fundingCode','USDT'));

  SELECT l.id INTO v_list FROM app.listing l JOIN app.payable p ON p.id = l.target_payable_id
   WHERE p.ref = 'TP-2026-0143' AND l.status = 'open';
  PERFORM pg_temp.act('bidbook-d', '11111111-0000-0000-0000-00000000000e',
    jsonb_build_object('kind','place_bid','listingId',v_list,
      'bidderWallet','0x3ca967000000000000000000000000000000c093',
      'priceBase',(12000000000 * 9938) / 10000,'fundingCode','XSGD'));
END $$;

-- ============================================================================
--  The Series — PRD §6 and §12
-- ============================================================================
-- Twelve small invoices with the same anchor, currency and maturity, bundled
-- into one lot worth a bank's time. 180,000 XUSD across twelve 15,000 tickets.
INSERT INTO app.series (id, ref, anchor_id, maturity_date, grade, grade_rationale)
VALUES ('5e000000-0000-0000-0000-000000000430', 'SERIES-2026-Q4-30D',
        'e0000000-0000-0000-0000-00000000ada7', pg_temp.t0() + 30, 'A',
        'Aggregate of twelve tier-2 suppliers against one anchor obligation. The grade is assigned to the lot, not to its members. Sample value assigned by StraitsX, not an external rating.');

DO $$
DECLARE
  v_names text[] := ARRAY[
    'Cheng Hui Fasteners','Tai Yuan Coatings','Bao Sheng Tooling','Jin Li Connectors',
    'He Feng Castings','Wan Ho Bearings','Shun Da Seals','Li Chuan Wiring',
    'Guo Xin Enclosures','Pei Yu Optics','Zhong An Springs','Mao Chi Laminates'];
  v_series uuid := '5e000000-0000-0000-0000-000000000430';
  v_holder text := '0x6d1470000000000000000000000000000000b43c';
  v_entity uuid; v_payable uuid; i int;
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
            150000000, pg_temp.t0() + 30, 'A',
            'Series member. The lot carries the grade; see SERIES-2026-Q4-30D. Sample value.',
            'certified', v_series);

    -- Every member issues to the same wallet, because PRD §6 requires a series
    -- to be wholly held by one seller before it can move as a lot.
    PERFORM pg_temp.act('issue-series-' || i, '11111111-0000-0000-0000-000000000008',
      jsonb_build_object('kind','issue_payable','payableId', v_payable,
                         'toWallet', v_holder, 'tokenId', 500 + i));
    PERFORM pg_temp.act('receipt-series-' || i, '11111111-0000-0000-0000-000000000004',
      jsonb_build_object('kind','accept_receipt','payableId', v_payable));
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
-- The PRD asks for ten. This seeds twenty-four, because the demo runs on a
-- public URL where every visitor who issues a payable consumes one, and a
-- picker that empties after ten visitors is a worse demo than one that does not.
--
-- The first row is the one docs/RUNBOOK.md uses: 250,000 XUSD on 90-day terms
-- to the active supplier, with its own invoice reference so issuing it cannot
-- collide with the seeded TP-2026-0141.
DO $$
DECLARE r RECORD; i int := 0;
BEGIN
  FOR r IN
    SELECT * FROM (VALUES
      ('e0000000-0000-0000-0000-000000000c41','INV-TW-88Q4A', 2500000000::bigint,  90,'TW-PROC-01'),
      ('e0000000-0000-0000-0000-000000000c43','INV-TW-90551', 8750000000,  60,'TW-PROC-01'),
      ('e0000000-0000-0000-0000-000000000c42','INV-TW-89004',  620000000,  30,'TW-PROC-02'),
      ('e0000000-0000-0000-0000-000000000c41','INV-TW-88301', 1440000000, 120,'TW-PROC-01'),
      ('e0000000-0000-0000-0000-000000000c28','INV-TW-72118', 2980000000,  90,'TW-PROC-03'),
      ('e0000000-0000-0000-0000-000000000c43','INV-TW-90588',  410000000,  45,'TW-PROC-02'),
      ('e0000000-0000-0000-0000-000000000c19','INV-TW-66401',  890000000, 180,'TW-PROC-03'),
      ('e0000000-0000-0000-0000-000000000c42','INV-TW-89112', 1130000000,  60,'TW-PROC-02'),
      ('e0000000-0000-0000-0000-000000000c41','INV-TW-88460', 3360000000,  90,'TW-PROC-01'),
      ('e0000000-0000-0000-0000-000000000c43','INV-TW-90613',  275000000,  30,'TW-PROC-02'),
      ('e0000000-0000-0000-0000-000000000c44','INV-TW-91002', 5120000000, 150,'TW-PROC-04'),
      ('e0000000-0000-0000-0000-000000000c45','INV-TW-91144',  735000000,  60,'TW-PROC-04'),
      ('e0000000-0000-0000-0000-000000000c46','INV-TW-91290', 1980000000,  90,'TW-PROC-01'),
      ('e0000000-0000-0000-0000-000000000c44','INV-TW-91355',  340000000,  30,'TW-PROC-04'),
      ('e0000000-0000-0000-0000-000000000c45','INV-TW-91401', 6700000000, 120,'TW-PROC-03'),
      ('e0000000-0000-0000-0000-000000000c46','INV-TW-91478',  512000000,  45,'TW-PROC-02'),
      ('e0000000-0000-0000-0000-000000000c28','INV-TW-72455', 4250000000,  90,'TW-PROC-03'),
      ('e0000000-0000-0000-0000-000000000c19','INV-TW-66790', 1070000000,  60,'TW-PROC-03'),
      ('e0000000-0000-0000-0000-000000000c41','INV-TW-88802', 9400000000, 180,'TW-PROC-01'),
      ('e0000000-0000-0000-0000-000000000c42','INV-TW-89330',  198000000,  30,'TW-PROC-02'),
      ('e0000000-0000-0000-0000-000000000c43','INV-TW-90944', 2640000000,  75,'TW-PROC-01'),
      ('e0000000-0000-0000-0000-000000000c45','INV-TW-91566', 1360000000,  45,'TW-PROC-04'),
      ('e0000000-0000-0000-0000-000000000c46','INV-TW-91633', 3820000000, 120,'TW-PROC-02'),
      ('e0000000-0000-0000-0000-000000000c44','INV-TW-91710',  655000000,  60,'TW-PROC-04')
    ) AS t(supplier, invoice_ref, amount, terms, cost_centre)
  LOOP
    i := i + 1;
    INSERT INTO app.erp_invoice (doc_no, supplier_id, invoice_ref, amount_base,
                                 terms_days, approved_on, cost_centre)
    VALUES ((5100084411 + i)::text, r.supplier::uuid, r.invoice_ref, r.amount, r.terms,
            pg_temp.t0() - (i % 7), r.cost_centre);
  END LOOP;
END $$;

-- ============================================================================
--  Declare the present to be T0
-- ============================================================================
-- The clock has walked 200 days to produce the histories above. Re-anchoring
-- here makes today the zero point that Reset world returns to, while every
-- journal entry keeps the world_date it actually happened on. This is the one
-- direct write to app.world in the system; ledger.post() owns the clock
-- everywhere else.
UPDATE app.world SET t0 = t0 + offset_days, offset_days = 0 WHERE only_row;

DROP TABLE seed_history;
DROP TABLE seed_live;

-- ---------------------------------------------------------------- the proof --
DO $$
DECLARE v_n bigint; v_date date;
BEGIN
  SELECT t0 + offset_days INTO v_date FROM app.world;
  IF v_date <> CURRENT_DATE THEN
    RAISE EXCEPTION 'seed finished at %, expected today (%)', v_date, CURRENT_DATE;
  END IF;

  SELECT count(*) INTO v_n FROM ledger.prove_books_balance();
  IF v_n <> 0 THEN RAISE EXCEPTION 'seeded books do not reconcile on % rows', v_n; END IF;

  SELECT count(*) INTO v_n FROM (
    SELECT asset_id FROM ledger.account_balance GROUP BY asset_id HAVING SUM(balance) <> 0) b;
  IF v_n <> 0 THEN RAISE EXCEPTION '% seeded assets are not conserved', v_n; END IF;

  RAISE NOTICE 'seeded: T0 = %, books reconcile', v_date;
END $$;
