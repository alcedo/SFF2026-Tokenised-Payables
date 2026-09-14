-- The programme fixtures: what a database with no world row boots into.
--
-- db/seed.sql is Reset world's job and is already covered by tests/ledger/seed.sql.
-- This covers the other entry point, the one a freshly provisioned hosted
-- database actually takes: src/db/ensure.ts loads db/fixtures.sql on the first
-- request and nothing else. Whatever that file leaves behind is the demo a
-- visitor meets before anyone presses Reset.
--
-- The contract is that the demo is usable on arrival. A preparer must be able
-- to create a payable both ways without onboarding anyone first, which needs
-- suppliers holding live accounts and an ERP register with rows in it, and a
-- lender must be able to bid on what comes out, which needs funding. An empty
-- register and an empty supplier dropdown compile and render perfectly, so
-- only a test that counts them catches the regression.
--
-- Loaded twice on purpose. ensure.ts races across serverless cold starts under
-- an advisory lock, and a second pass must converge rather than duplicate.
\set ON_ERROR_STOP on

\echo '=============================================================='
\echo ' FIXTURES: the world a fresh database boots into'
\echo '=============================================================='

\i db/fixtures.sql

\i tests/ledger/helpers.sql

DO $$
DECLARE
  v_n      bigint;
  v_date   date;
  r        RECORD;
BEGIN
  ------------------------------------------------------------- the world --
  SELECT count(*) INTO v_n FROM app.world;
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'FAIL: expected one world row, found %', v_n;
  END IF;
  SELECT t0 + offset_days INTO v_date FROM app.world;
  IF v_date <> CURRENT_DATE THEN
    RAISE EXCEPTION 'FAIL: fresh world opens on %, expected today (%)', v_date, CURRENT_DATE;
  END IF;
  RAISE NOTICE 'PASS  a fresh database opens on today''s date';

  --------------------------------------------------------- the programme --
  SELECT count(*) INTO v_n FROM app.entity WHERE entity_type = 'anchor';
  IF v_n <> 1 THEN RAISE EXCEPTION 'FAIL: expected 1 anchor, found %', v_n; END IF;
  SELECT count(*) INTO v_n FROM app.entity WHERE entity_type = 'platform';
  IF v_n <> 1 THEN RAISE EXCEPTION 'FAIL: expected 1 platform, found %', v_n; END IF;

  ------------------------------------------------------------ the parties --
  -- Two of each, which is what makes a transfer, a second bid and the
  -- financing comparison demonstrable without onboarding anyone.
  SELECT count(*) INTO v_n FROM app.entity WHERE entity_type = 'supplier';
  IF v_n <> 2 THEN RAISE EXCEPTION 'FAIL: expected 2 suppliers, found %', v_n; END IF;
  SELECT count(*) INTO v_n FROM app.entity WHERE entity_type = 'lender';
  IF v_n <> 2 THEN RAISE EXCEPTION 'FAIL: expected 2 lenders, found %', v_n; END IF;
  RAISE NOTICE 'PASS  two suppliers and two lenders exist on arrival';

  -- Every organisation needs a custodial wallet and someone who can act as it.
  -- A party with neither is invisible to the persona switcher and cannot
  -- receive an issuance, so it is not a counterparty at all.
  FOR r IN SELECT id, name, entity_type FROM app.entity LOOP
    IF NOT EXISTS (SELECT 1 FROM app.wallet WHERE entity_id = r.id) THEN
      RAISE EXCEPTION 'FAIL: % (%) has no custodial wallet', r.name, r.entity_type;
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM app.app_user WHERE entity_id = r.id AND deactivated_at IS NULL
    ) THEN
      RAISE EXCEPTION 'FAIL: % (%) has no live account', r.name, r.entity_type;
    END IF;
  END LOOP;
  RAISE NOTICE 'PASS  every organisation has a wallet and a live account';

  -- PRD §11's switcher is how a presenter moves between personas. All five
  -- roles have to be reachable or the demo dead-ends at the first handover.
  SELECT count(DISTINCT role) INTO v_n FROM app.app_user WHERE deactivated_at IS NULL;
  IF v_n <> 5 THEN
    RAISE EXCEPTION 'FAIL: the persona switcher offers % of 5 roles', v_n;
  END IF;
  RAISE NOTICE 'PASS  all five personas are reachable from the switcher';

  -- Only an institutionally eligible account may bid or buy now (PRD §5), so a
  -- lender account without the flag can look at the marketplace and do nothing.
  SELECT count(*) INTO v_n
    FROM app.app_user u JOIN app.entity e ON e.id = u.entity_id
   WHERE e.entity_type = 'lender' AND u.deactivated_at IS NULL
     AND NOT u.institutional_eligible;
  IF v_n <> 0 THEN
    RAISE EXCEPTION 'FAIL: % lender accounts cannot bid', v_n;
  END IF;
  RAISE NOTICE 'PASS  every lender account may bid and buy now';

  ------------------------------------------------------------- the money --
  -- A lender with no balance cannot bid in any asset, which strands the demo
  -- one click after issuance. All four, because the funding-asset picker
  -- offers all four whichever lender is acting.
  FOR r IN
    SELECT e.name, w.address FROM app.entity e
      JOIN app.wallet w ON w.entity_id = e.id
     WHERE e.entity_type = 'lender'
  LOOP
    IF pg_temp.cash(r.address, 'XUSD') <= 0 THEN
      RAISE EXCEPTION 'FAIL: lender % holds no XUSD', r.name;
    END IF;
    IF pg_temp.cash(r.address, 'USDC') <= 0 THEN
      RAISE EXCEPTION 'FAIL: lender % holds no USDC', r.name;
    END IF;
    IF pg_temp.cash(r.address, 'USDT') <= 0 THEN
      RAISE EXCEPTION 'FAIL: lender % holds no USDT', r.name;
    END IF;
    IF pg_temp.cash(r.address, 'XSGD') <= 0 THEN
      RAISE EXCEPTION 'FAIL: lender % holds no XSGD', r.name;
    END IF;
  END LOOP;
  RAISE NOTICE 'PASS  both lenders are funded in all four assets';

  -- ADATA settles at maturity out of its own wallet. Unfunded, the last step of
  -- the runbook refuses with a shortfall the presenter has to top up by hand.
  SELECT w.address INTO r FROM app.entity e
    JOIN app.wallet w ON w.entity_id = e.id
   WHERE e.entity_type = 'anchor';
  IF pg_temp.cash(r.address, 'XUSD') <= 0 THEN
    RAISE EXCEPTION 'FAIL: the anchor holds no XUSD and cannot settle';
  END IF;
  IF pg_temp.cash(r.address, 'XSGD') <= 0 THEN
    RAISE EXCEPTION 'FAIL: the anchor holds no XSGD and cannot show a funded conversion';
  END IF;
  RAISE NOTICE 'PASS  the anchor can discharge a payable in XUSD or XSGD';

  ------------------------------------------------------- the ERP register --
  -- PRD §8 screen 2's import path. An empty register renders an empty table and
  -- the preparer has no way in but manual entry.
  SELECT count(*) INTO v_n FROM app.erp_invoice WHERE consumed_by IS NULL;
  IF v_n < 12 THEN
    RAISE EXCEPTION 'FAIL: the ERP register offers % invoices, expected at least 12', v_n;
  END IF;
  RAISE NOTICE 'PASS  the ERP register arrives with % approved invoices', v_n;

  -- An invoice whose supplier has no live account produces a payable that can
  -- never be accepted, so the register must only name suppliers who can act.
  SELECT count(*) INTO v_n
    FROM app.erp_invoice i
   WHERE NOT EXISTS (
     SELECT 1 FROM app.app_user u WHERE u.entity_id = i.supplier_id AND u.deactivated_at IS NULL
   );
  IF v_n <> 0 THEN
    RAISE EXCEPTION 'FAIL: % ERP invoices name a supplier with no live account', v_n;
  END IF;
  RAISE NOTICE 'PASS  every ERP invoice names a supplier who can take delivery';

  -- Both suppliers appear, or the register is really one supplier's ledger and
  -- the second party never comes up in the demo.
  SELECT count(DISTINCT supplier_id) INTO v_n FROM app.erp_invoice;
  IF v_n <> 2 THEN
    RAISE EXCEPTION 'FAIL: the ERP register covers % suppliers, expected 2', v_n;
  END IF;
  RAISE NOTICE 'PASS  the register covers both suppliers';

  ---------------------------------------------------------- a clean slate --
  -- The catalogue of 29 payables belongs to Reset world. A fresh database is a
  -- programme that has not issued anything yet.
  SELECT count(*) INTO v_n FROM app.payable;
  IF v_n <> 0 THEN
    RAISE EXCEPTION 'FAIL: a fresh database already holds % payables', v_n;
  END IF;
  RAISE NOTICE 'PASS  no payables exist until someone creates one';

  ----------------------------------------------------------- the proof --
  SELECT count(*) INTO v_n FROM ledger.prove_books_balance();
  IF v_n <> 0 THEN
    RAISE EXCEPTION 'FAIL: the fixture books do not reconcile on % rows', v_n;
  END IF;
  SELECT count(*) INTO v_n FROM (
    SELECT asset_id FROM ledger.account_balance GROUP BY asset_id HAVING SUM(balance) <> 0) b;
  IF v_n <> 0 THEN
    RAISE EXCEPTION 'FAIL: % fixture assets are not conserved', v_n;
  END IF;
  RAISE NOTICE 'PASS  the fixture books reconcile and every asset nets to zero';
END $$;

-- ---------------------------------------------------------- idempotency --
-- Two serverless instances can cold-start on the same empty database. The
-- advisory lock in ensure.ts serialises them, but the loser still runs its
-- classify pass, and any future caller may replay the file. Converging rather
-- than duplicating is a property of this file, so it is asserted rather than
-- assumed.
CREATE TEMP TABLE before_replay AS
SELECT
  (SELECT count(*) FROM app.entity)                 AS entities,
  (SELECT count(*) FROM app.app_user)               AS users,
  (SELECT count(*) FROM app.wallet)                 AS wallets,
  (SELECT count(*) FROM app.erp_invoice)            AS erp,
  (SELECT count(*) FROM ledger.journal_entry)       AS entries,
  (SELECT COALESCE(SUM(abs(balance)), 0) FROM ledger.account_balance) AS gross;

\i db/fixtures.sql

DO $$
DECLARE b RECORD; v_n bigint;
BEGIN
  SELECT * INTO b FROM before_replay;

  SELECT count(*) INTO v_n FROM app.entity;
  IF v_n <> b.entities THEN
    RAISE EXCEPTION 'FAIL: replay changed the organisation count from % to %', b.entities, v_n;
  END IF;
  SELECT count(*) INTO v_n FROM app.app_user;
  IF v_n <> b.users THEN
    RAISE EXCEPTION 'FAIL: replay changed the account count from % to %', b.users, v_n;
  END IF;
  SELECT count(*) INTO v_n FROM app.wallet;
  IF v_n <> b.wallets THEN
    RAISE EXCEPTION 'FAIL: replay changed the wallet count from % to %', b.wallets, v_n;
  END IF;
  SELECT count(*) INTO v_n FROM app.erp_invoice;
  IF v_n <> b.erp THEN
    RAISE EXCEPTION 'FAIL: replay changed the ERP register from % to % invoices', b.erp, v_n;
  END IF;

  -- The funding goes through ledger.post(), which collapses a replayed
  -- idempotency key into the original entry. A second journal entry here means
  -- a key was minted fresh on each pass and the lenders were paid twice.
  SELECT count(*) INTO v_n FROM ledger.journal_entry;
  IF v_n <> b.entries THEN
    RAISE EXCEPTION 'FAIL: replay wrote % journal entries on top of %', v_n - b.entries, b.entries;
  END IF;

  SELECT COALESCE(SUM(abs(balance)), 0) INTO v_n FROM ledger.account_balance;
  IF v_n <> b.gross THEN
    RAISE EXCEPTION 'FAIL: replay moved money: gross balance % became %', b.gross, v_n;
  END IF;

  SELECT count(*) INTO v_n FROM ledger.prove_books_balance();
  IF v_n <> 0 THEN
    RAISE EXCEPTION 'FAIL: the books do not reconcile after a replay';
  END IF;

  RAISE NOTICE 'PASS  loading the fixtures twice converges and pays once';
END $$;

DROP TABLE before_replay;
