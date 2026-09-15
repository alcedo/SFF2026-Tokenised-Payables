-- Programme fixtures. Not the PRD §12 demo catalogue.
--
-- A hosted database that has the schema but no seed still has to render Shell
-- and run create-payable. Onboarding cannot create the first user: ledger.post
-- requires actor_user_id to reference app.app_user. The anchor and the platform
-- cannot be onboarded (post.sql ADA29). These rows are those fixtures.
--
-- Keyed on natural predicates ("an anchor exists", "the platform has a wallet",
-- "an active checker exists at an anchor"), not on ids. A schema-only database
-- that a ledger test already populated with a differently-id'd ADATA would
-- otherwise collide on entity_name_unique. Canonical ids and the ADATA wallet
-- from db/seed.sql are used when a row is created, so Reset world and the
-- settlement screen's hardcoded anchor address stay consistent.
--
-- No psql meta-commands: the driver executes this file.

INSERT INTO app.world (t0, offset_days) VALUES (CURRENT_DATE, 0)
ON CONFLICT (only_row) DO NOTHING;

INSERT INTO app.entity (id, name, entity_type, certification_status, programme_limit_base)
SELECT 'e0000000-0000-0000-0000-00000000ada7',
       'ADATA Technology Co., Ltd.',
       'anchor',
       'certified',
       250000000000
 WHERE NOT EXISTS (SELECT 1 FROM app.entity WHERE entity_type = 'anchor');

INSERT INTO app.entity (id, name, entity_type, certification_status)
SELECT 'e0000000-0000-0000-0000-000000005787',
       'StraitsX',
       'platform',
       'certified'
 WHERE NOT EXISTS (SELECT 1 FROM app.entity WHERE entity_type = 'platform');

-- One wallet per fixture entity that has none. Prefer the canonical address;
-- mint one if that address is already attached to someone else.
INSERT INTO app.wallet (address, entity_id)
SELECT CASE
         WHEN EXISTS (
           SELECT 1 FROM app.wallet
            WHERE address = '0xada7a0000000000000000000000000000000c21d'
         )
         THEN '0x' || encode(gen_random_bytes(20), 'hex')
         ELSE '0xada7a0000000000000000000000000000000c21d'
       END,
       e.id
  FROM app.entity e
 WHERE e.entity_type = 'anchor'
   AND NOT EXISTS (SELECT 1 FROM app.wallet w WHERE w.entity_id = e.id)
 ORDER BY e.name
 LIMIT 1;

INSERT INTO app.wallet (address, entity_id)
SELECT CASE
         WHEN EXISTS (
           SELECT 1 FROM app.wallet
            WHERE address = '0x57a715000000000000000000000000000000a001'
         )
         THEN '0x' || encode(gen_random_bytes(20), 'hex')
         ELSE '0x57a715000000000000000000000000000000a001'
       END,
       e.id
  FROM app.entity e
 WHERE e.entity_type = 'platform'
   AND NOT EXISTS (SELECT 1 FROM app.wallet w WHERE w.entity_id = e.id)
 ORDER BY e.name
 LIMIT 1;

-- One account per (fixture entity type, role) that lacks an active holder.
-- Names and ids are seed.sql's, so the persona switcher still shows Wei-Ling
-- Chen and Nadia Rahman on a fresh programme.
INSERT INTO app.app_user (id, entity_id, name, role, mock_kyc_verified, institutional_eligible)
SELECT '11111111-0000-0000-0000-000000000001', e.id, 'Wei-Ling Chen', 'adata_preparer', true, false
  FROM app.entity e
 WHERE e.entity_type = 'anchor'
   AND NOT EXISTS (
     SELECT 1 FROM app.app_user u
     JOIN app.entity x ON x.id = u.entity_id
      WHERE x.entity_type = 'anchor'
        AND u.role = 'adata_preparer'
        AND u.deactivated_at IS NULL
   )
 ORDER BY e.name
 LIMIT 1
ON CONFLICT (id) DO NOTHING;

INSERT INTO app.app_user (id, entity_id, name, role, mock_kyc_verified, institutional_eligible)
SELECT '11111111-0000-0000-0000-000000000002', e.id, 'Hsu Po-Chun', 'adata_checker', true, false
  FROM app.entity e
 WHERE e.entity_type = 'anchor'
   AND NOT EXISTS (
     SELECT 1 FROM app.app_user u
     JOIN app.entity x ON x.id = u.entity_id
      WHERE x.entity_type = 'anchor'
        AND u.role = 'adata_checker'
        AND u.deactivated_at IS NULL
   )
 ORDER BY e.name
 LIMIT 1
ON CONFLICT (id) DO NOTHING;

INSERT INTO app.app_user (id, entity_id, name, role, mock_kyc_verified, institutional_eligible)
SELECT '11111111-0000-0000-0000-000000000008', e.id, 'Nadia Rahman', 'straitsx_admin', true, false
  FROM app.entity e
 WHERE e.entity_type = 'platform'
   AND NOT EXISTS (
     SELECT 1 FROM app.app_user
      WHERE role = 'straitsx_admin' AND deactivated_at IS NULL
   )
 ORDER BY e.name
 LIMIT 1
ON CONFLICT (id) DO NOTHING;

-- ----------------------------------------------------------------------------
-- Counterparties
-- ----------------------------------------------------------------------------
-- The rows above are the minimum ledger.post() will accept a command with. They
-- are not a demo: with no supplier holding a live account the manual-entry
-- dropdown is empty and the create-payable screen has no way in, and with no
-- lender there is nobody to finance what does get issued.
--
-- Two of each, the smallest world in which every screen has something to show
-- and every handover has a second party: one supplier can transfer to the
-- other, one lender can outbid the other, and the accounts screen can
-- demonstrate removal without stranding an organisation's wallet.
--
-- Onboarded through ledger.post() rather than written into app.entity directly,
-- because that intent already creates the organisation, mints its custodial
-- wallet, creates its first user and derives institutional eligibility from the
-- role (post.sql ADA29). The rows above cannot use it: the anchor and the
-- platform are refused by that branch on purpose, and until an actor exists
-- there is nobody to post as. From here on the ordinary write surface works,
-- and so this file stops being a second way to create a counterparty.
--
-- Guarded on the natural predicate, an organisation of this name exists, for
-- the same reason the rows above are: a ledger test may already have put one
-- here, and entity_name_unique would collide.
SELECT ledger.post(jsonb_build_object(
         'idempotencyKey', md5('fixtures-onboard-' || v.name)::uuid,
         'actorUserId',    admin.id,
         'intent', jsonb_build_object(
           'kind',       'onboard_entity',
           'name',       v.name,
           'entityType', v.entity_type,
           'userName',   v.user_name,
           -- A persona is a role inside an organisation and the two have to
           -- agree, so for a counterparty the role is the entity type.
           'role',       v.entity_type)))
  FROM (VALUES
    ('Chien Yu Precision',  'supplier', 'Tang Mei-Hua'),
    ('Ming Kuo Components', 'supplier', 'Kuo Shih-Chieh'),
    ('Meridian Trade Bank', 'lender',   'Rina Okafor'),
    ('Kestrel Credit Fund', 'lender',   'Sébastien Baptiste')
  ) AS v(name, entity_type, user_name)
 CROSS JOIN LATERAL (
   SELECT id FROM app.app_user
    WHERE role = 'straitsx_admin' AND deactivated_at IS NULL
    LIMIT 1
 ) AS admin
 WHERE NOT EXISTS (SELECT 1 FROM app.entity e WHERE lower(e.name) = lower(v.name));

-- ----------------------------------------------------------------------------
-- Funding
-- ----------------------------------------------------------------------------
-- A lender with an empty wallet reaches the bid form and is refused there, one
-- click after the issuance the demo just showed. PRD §12 asks for one lender
-- predominantly in USDC and one in XUSD; all four assets are funded either way,
-- because the funding-asset picker offers all four whichever lender is acting.
--
-- The idempotency key is derived from the wallet and the asset rather than
-- minted fresh, so replaying this file on a cold start collapses into the
-- original journal entry instead of paying a second time. That is the same
-- guarantee the application's buttons rely on, exercised here.
WITH party AS (
  -- The anchor is resolved by type rather than by name, because the rows above
  -- adopt whatever anchor is already present and a ledger test may have created
  -- it under a different one.
  SELECT 'anchor'::text AS who, id FROM app.entity WHERE entity_type = 'anchor'
  UNION ALL
  SELECT name, id FROM app.entity WHERE entity_type = 'lender'
),
funding (who, code, amount) AS (VALUES
  ('anchor',              'XUSD', 400000000000::bigint),
  ('anchor',              'XSGD',  50000000000),
  ('Meridian Trade Bank', 'XUSD',  62000000000),
  ('Meridian Trade Bank', 'USDC', 184000000000),
  ('Meridian Trade Bank', 'USDT',  21000000000),
  ('Meridian Trade Bank', 'XSGD',  14000000000),
  ('Kestrel Credit Fund', 'XUSD', 213000000000),
  ('Kestrel Credit Fund', 'USDC',  26000000000),
  ('Kestrel Credit Fund', 'USDT',  12000000000),
  ('Kestrel Credit Fund', 'XSGD',  38000000000)
)
SELECT ledger.post(jsonb_build_object(
         'idempotencyKey', md5('fixtures-fund-' || w.address || '-' || f.code)::uuid,
         'actorUserId',    u.id,
         'intent', jsonb_build_object('kind', 'top_up', 'wallet', w.address,
                                      'cashCode', f.code, 'amountBase', f.amount)))
  FROM funding f
  JOIN party p ON p.who = f.who
  JOIN app.wallet w ON w.entity_id = p.id
  JOIN LATERAL (
    SELECT id FROM app.app_user
     WHERE entity_id = p.id AND deactivated_at IS NULL
     ORDER BY id LIMIT 1
  ) u ON true;

-- ----------------------------------------------------------------------------
-- The ERP inbox — PRD §8 screen 2
-- ----------------------------------------------------------------------------
-- "Import from ERP" reads app.erp_invoice and renders whatever is there, so an
-- empty table is an empty register and the headline path into the product does
-- not work. Twenty-four rather than the PRD's ten for the reason db/seed.sql
-- gives: on a public URL every visitor who issues a payable consumes one, and a
-- register that empties partway through the day is a worse demo than one that
-- does not.
--
-- Document 5100084412 is the invoice docs/RUNBOOK.md opens on: 250,000 XUSD on
-- 90-day terms. Keeping it first here means the presenter's script reads the
-- same on a fresh database as on a Reset one.
INSERT INTO app.erp_invoice (doc_no, supplier_id, invoice_ref, amount_base,
                             terms_days, approved_on, cost_centre)
SELECT v.doc_no, e.id, v.invoice_ref, v.amount, v.terms,
       CURRENT_DATE - v.age, v.cost_centre
  FROM (VALUES
    ('5100084412', 'Chien Yu Precision',  'INV-TW-88Q4A', 2500000000::bigint,  90, 0, 'TW-PROC-01'),
    ('5100084413', 'Ming Kuo Components', 'INV-TW-90551', 8750000000,  60, 1, 'TW-PROC-01'),
    ('5100084414', 'Chien Yu Precision',  'INV-TW-88301', 1440000000, 120, 2, 'TW-PROC-01'),
    ('5100084415', 'Ming Kuo Components', 'INV-TW-90613',  275000000,  30, 3, 'TW-PROC-02'),
    ('5100084416', 'Chien Yu Precision',  'INV-TW-88460', 3360000000,  90, 4, 'TW-PROC-01'),
    ('5100084417', 'Ming Kuo Components', 'INV-TW-90588',  410000000,  45, 5, 'TW-PROC-02'),
    ('5100084418', 'Chien Yu Precision',  'INV-TW-88802', 9400000000, 180, 6, 'TW-PROC-01'),
    ('5100084419', 'Ming Kuo Components', 'INV-TW-90944', 2640000000,  75, 0, 'TW-PROC-01'),
    ('5100084420', 'Chien Yu Precision',  'INV-TW-88115', 1850000000,  60, 1, 'TW-PROC-02'),
    ('5100084421', 'Ming Kuo Components', 'INV-TW-90107', 3290000000,  90, 2, 'TW-PROC-03'),
    ('5100084422', 'Chien Yu Precision',  'INV-TW-88227',  720000000,  30, 3, 'TW-PROC-02'),
    ('5100084423', 'Ming Kuo Components', 'INV-TW-90244',  540000000,  30, 4, 'TW-PROC-03'),
    ('5100084424', 'Chien Yu Precision',  'INV-TW-88394', 4120000000, 150, 5, 'TW-PROC-01'),
    ('5100084425', 'Ming Kuo Components', 'INV-TW-90372', 7150000000, 180, 6, 'TW-PROC-03'),
    ('5100084426', 'Chien Yu Precision',  'INV-TW-88508',  965000000,  45, 0, 'TW-PROC-02'),
    ('5100084427', 'Ming Kuo Components', 'INV-TW-90466', 1120000000,  45, 1, 'TW-PROC-04'),
    ('5100084428', 'Chien Yu Precision',  'INV-TW-88661', 2340000000,  90, 2, 'TW-PROC-01'),
    ('5100084429', 'Ming Kuo Components', 'INV-TW-90725', 2880000000,  75, 3, 'TW-PROC-04'),
    ('5100084430', 'Chien Yu Precision',  'INV-TW-88719', 5580000000, 120, 4, 'TW-PROC-03'),
    ('5100084431', 'Ming Kuo Components', 'INV-TW-90810',  640000000,  30, 5, 'TW-PROC-04'),
    ('5100084432', 'Chien Yu Precision',  'INV-TW-88874',  310000000,  30, 6, 'TW-PROC-02'),
    ('5100084433', 'Ming Kuo Components', 'INV-TW-90877', 4460000000, 120, 0, 'TW-PROC-04'),
    ('5100084434', 'Chien Yu Precision',  'INV-TW-88950', 1675000000,  60, 1, 'TW-PROC-03'),
    ('5100084435', 'Ming Kuo Components', 'INV-TW-91020', 1395000000,  60, 2, 'TW-PROC-04')
  ) AS v(doc_no, supplier_name, invoice_ref, amount, terms, age, cost_centre)
  JOIN app.entity e ON lower(e.name) = lower(v.supplier_name)
                   AND e.entity_type = 'supplier'
ON CONFLICT (doc_no) DO NOTHING;

-- ----------------------------------------------------------------------------
-- The demo has to be usable when this file finishes
-- ----------------------------------------------------------------------------
-- Every insert above is guarded on state it expects to find, which is what
-- makes the file safe to replay. A guard that matches nothing skips silently,
-- though: an admin lookup that resolves to no rows would leave the
-- counterparties and the whole register unwritten, and the transaction would
-- still commit. The result is the empty supplier dropdown and empty ERP table
-- this file exists to prevent, with nothing in the log to say so.
--
-- Failing the first request loudly is better than serving that. The screens are
-- unusable either way; only one of the two says why.
DO $$
DECLARE v_suppliers bigint; v_lenders bigint; v_invoices bigint;
BEGIN
  SELECT count(*) INTO v_suppliers
    FROM app.entity e
   WHERE e.entity_type = 'supplier'
     AND EXISTS (SELECT 1 FROM app.app_user u
                  WHERE u.entity_id = e.id AND u.deactivated_at IS NULL);

  SELECT count(*) INTO v_lenders
    FROM app.entity e
   WHERE e.entity_type = 'lender'
     AND EXISTS (SELECT 1 FROM app.app_user u
                  WHERE u.entity_id = e.id AND u.deactivated_at IS NULL);

  SELECT count(*) INTO v_invoices FROM app.erp_invoice WHERE consumed_by IS NULL;

  IF v_suppliers = 0 OR v_lenders = 0 OR v_invoices = 0 THEN
    RAISE EXCEPTION
      'fixtures left an unusable world: % supplier(s) with an account, % lender(s), % free ERP invoice(s)',
      v_suppliers, v_lenders, v_invoices;
  END IF;
END $$;
