-- Shared test fixture: one anchor, one supplier, two lenders, one payable.
-- Figures are TP-2026-0141 from PRD §12: 250,000 XUSD face, 90 days, grade AA.
\set QUIET on

INSERT INTO app.world (t0, offset_days) VALUES ('2026-10-01', 0);

INSERT INTO app.entity (id, name, entity_type, certification_status) VALUES
  ('e0000000-0000-0000-0000-0000000000a1', 'ADATA Technology Co., Ltd.', 'anchor',   'certified'),
  ('e0000000-0000-0000-0000-0000000000a2', 'Chien Yu Precision',         'supplier', 'certified'),
  ('e0000000-0000-0000-0000-0000000000a3', 'Meridian Trade Bank',        'lender',   'certified'),
  ('e0000000-0000-0000-0000-0000000000a4', 'Kestrel Credit Fund',        'lender',   'certified');

INSERT INTO app.wallet (address, entity_id) VALUES
  ('0xada7a0000000000000000000000000000000c21d', 'e0000000-0000-0000-0000-0000000000a1'),
  ('0x509911000000000000000000000000000000f88a', 'e0000000-0000-0000-0000-0000000000a2'),
  ('0x1e4de40000000000000000000000000000004b13', 'e0000000-0000-0000-0000-0000000000a3'),
  ('0xfe5700000000000000000000000000000000d902', 'e0000000-0000-0000-0000-0000000000a4');

INSERT INTO app.app_user (id, entity_id, name, role, mock_kyc_verified, institutional_eligible) VALUES
  ('11111111-0000-0000-0000-000000000001', 'e0000000-0000-0000-0000-0000000000a1', 'Wei Chen',  'adata_preparer', true, false),
  ('11111111-0000-0000-0000-000000000002', 'e0000000-0000-0000-0000-0000000000a1', 'Lin Hsu',   'adata_checker',  true, false),
  ('11111111-0000-0000-0000-000000000003', 'e0000000-0000-0000-0000-0000000000a2', 'Mei Tang',  'supplier',       true, false),
  ('11111111-0000-0000-0000-000000000004', 'e0000000-0000-0000-0000-0000000000a3', 'R. Okafor', 'lender',         true, true),
  ('11111111-0000-0000-0000-000000000005', 'e0000000-0000-0000-0000-0000000000a4', 'S. Baptiste','lender',        true, true);

INSERT INTO app.payable (id, ref, anchor_id, original_supplier_id, invoice_ref,
                         face_base, maturity_date, grade, grade_rationale, lifecycle_status)
VALUES ('9a000000-0000-0000-0000-000000000141', 'TP-2026-0141',
        'e0000000-0000-0000-0000-0000000000a1', 'e0000000-0000-0000-0000-0000000000a2',
        'INV-TW-88213', 2500000000, '2026-12-30', 'AA',
        'Anchor obligor investment grade. Sample value, not an external rating.', 'certified');

-- Fund the two lenders, and the anchor in XUSD plus the XSGD and USDC the
-- funded-settlement cases pay with, then issue the payable to the supplier.
SELECT ledger.post(jsonb_build_object(
  'idempotencyKey','00000000-0000-0000-0000-00000000f001','actorUserId','11111111-0000-0000-0000-000000000004',
  'intent', jsonb_build_object('kind','top_up','wallet','0x1e4de40000000000000000000000000000004b13',
                               'cashCode','USDC','amountBase', 3000000000)));
SELECT ledger.post(jsonb_build_object(
  'idempotencyKey','00000000-0000-0000-0000-00000000f003','actorUserId','11111111-0000-0000-0000-000000000005',
  'intent', jsonb_build_object('kind','top_up','wallet','0xfe5700000000000000000000000000000000d902',
                               'cashCode','XSGD','amountBase', 4000000000)));
SELECT ledger.post(jsonb_build_object(
  'idempotencyKey','00000000-0000-0000-0000-00000000f002','actorUserId','11111111-0000-0000-0000-000000000001',
  'intent', jsonb_build_object('kind','top_up','wallet','0xada7a0000000000000000000000000000000c21d',
                               'cashCode','XUSD','amountBase', 5000000000)));
SELECT ledger.post(jsonb_build_object(
  'idempotencyKey','00000000-0000-0000-0000-00000000f004','actorUserId','11111111-0000-0000-0000-000000000001',
  'intent', jsonb_build_object('kind','top_up','wallet','0xada7a0000000000000000000000000000000c21d',
                               'cashCode','XSGD','amountBase', 5000000000)));
SELECT ledger.post(jsonb_build_object(
  'idempotencyKey','00000000-0000-0000-0000-00000000f005','actorUserId','11111111-0000-0000-0000-000000000001',
  'intent', jsonb_build_object('kind','top_up','wallet','0xada7a0000000000000000000000000000000c21d',
                               'cashCode','USDC','amountBase', 1000000000)));
SELECT ledger.post(jsonb_build_object(
  'idempotencyKey','00000000-0000-0000-0000-000000000001','actorUserId','11111111-0000-0000-0000-000000000001',
  'intent', jsonb_build_object('kind','issue_payable','payableId','9a000000-0000-0000-0000-000000000141',
                               'toWallet','0x509911000000000000000000000000000000f88a','tokenId', 141)));
-- PRD section 3 question 7: the supplier takes delivery from the inbox.
SELECT ledger.post(jsonb_build_object(
  'idempotencyKey','00000000-0000-0000-0000-0000000000ac','actorUserId','11111111-0000-0000-0000-000000000003',
  'intent', jsonb_build_object('kind','accept_receipt','payableId','9a000000-0000-0000-0000-000000000141')));
\set QUIET off
