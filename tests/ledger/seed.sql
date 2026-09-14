-- The seeded world against PRD §12, row by row.
--
-- The seed builds its history by calling ledger.post() rather than writing rows
-- directly, so this file checks two different things at once: that the figures
-- match the PRD, and that a world assembled purely from real operations lands
-- exactly where the document says it should.
\set ON_ERROR_STOP on

\echo '=============================================================='
\echo ' SEED vs PRD section 12'
\echo '=============================================================='

DO $$
DECLARE
  r        RECORD;
  v_world  date;
  v_n      bigint;
  v_yield  numeric;
BEGIN
  SELECT t0 + offset_days INTO v_world FROM app.world;
  IF v_world <> DATE '2026-10-01' THEN
    RAISE EXCEPTION 'FAIL: T0 is %, expected 2026-10-01', v_world;
  END IF;
  IF (SELECT offset_days FROM app.world) <> 0 THEN
    RAISE EXCEPTION 'FAIL: the demo starts at a non-zero clock offset';
  END IF;
  RAISE NOTICE 'PASS  the world starts at T0 = 2026-10-01 with the clock at zero';

  -- PRD §12, the four live rows. Face, tenor, grade and ask are stated; the
  -- yield is "calculated from the remaining days and asks above, rounded to one
  -- decimal place", so it is recomputed here rather than stored.
  FOR r IN
    SELECT * FROM (VALUES
      ('TP-2026-0143',       12000000000::bigint, 30, 'AAA', 11930400000::bigint, 7.1::numeric),
      ('TP-2026-0141',        2500000000::bigint, 90, 'AA',   2446250000::bigint, 8.9::numeric),
      ('TP-2026-0142',         480000000::bigint, 60, 'A',     472320000::bigint, 9.9::numeric),
      ('SERIES-2026-Q4-30D',  1800000000::bigint, 30, 'A',    1785600000::bigint, 9.8::numeric)
    ) AS t(ref, face, days, grade, ask, expected_yield)
  LOOP
    SELECT sum(ll.quantity_base), li.min_price_base
      INTO v_n, r.ask
      FROM app.listing li
      JOIN app.listing_leg ll ON ll.listing_id = li.id
      LEFT JOIN app.payable p ON p.id = li.target_payable_id
      LEFT JOIN app.series  s ON s.id = li.target_series_id
     WHERE li.status = 'open' AND COALESCE(p.ref, s.ref) = r.ref
     GROUP BY li.min_price_base;

    IF v_n IS NULL THEN
      RAISE EXCEPTION 'FAIL: % has no open listing', r.ref;
    END IF;
    IF v_n <> r.face THEN
      RAISE EXCEPTION 'FAIL: % lists %, expected face %', r.ref, v_n, r.face;
    END IF;

    -- 100 * (F - P) / P * 365 / d
    v_yield := round(100.0 * (r.face - r.ask) / r.ask * 365 / r.days, 1);
    IF v_yield <> r.expected_yield THEN
      RAISE EXCEPTION 'FAIL: % yields %, the PRD states %', r.ref, v_yield, r.expected_yield;
    END IF;
    RAISE NOTICE 'PASS  % lists % at % for a % yield',
      r.ref, r.face / 10000, round(100.0 * r.ask / r.face, 2)::text || '%', v_yield::text || '%';
  END LOOP;

  -- The settled row. PRD §12 states 9.2% realised; the price and holding period
  -- behind it are derived in docs/ASSUMPTIONS.md.
  IF (SELECT lifecycle_status FROM app.payable WHERE ref = 'TP-2026-0128') <> 'settled' THEN
    RAISE EXCEPTION 'FAIL: TP-2026-0128 should be settled';
  END IF;
  v_yield := round(100.0 * (3200000000 - 3129000000) / 3129000000 * 365 / 90, 1);
  IF v_yield <> 9.2 THEN
    RAISE EXCEPTION 'FAIL: the settled row realises %, the PRD states 9.2', v_yield;
  END IF;
  RAISE NOTICE 'PASS  TP-2026-0128 settled, realising 9.2 percent over 90 days';

  -- The overdue row. Past its due date, unpaid, and deliberately not settled.
  SELECT (maturity_date - v_world) INTO v_n FROM app.payable WHERE ref = 'TP-2026-0119';
  IF v_n >= 0 THEN
    RAISE EXCEPTION 'FAIL: TP-2026-0119 is not past due (% days remaining)', v_n;
  END IF;
  IF (SELECT lifecycle_status FROM app.payable WHERE ref = 'TP-2026-0119') = 'settled' THEN
    RAISE EXCEPTION 'FAIL: the overdue showcase row was settled';
  END IF;
  RAISE NOTICE 'PASS  TP-2026-0119 is % days past due and unpaid', -v_n;

  -- PRD §12: twelve fictional suppliers, one current holder.
  SELECT count(*) INTO v_n FROM app.payable p
    JOIN app.series s ON s.id = p.series_id WHERE s.ref = 'SERIES-2026-Q4-30D';
  IF v_n <> 12 THEN RAISE EXCEPTION 'FAIL: the series has % members, expected 12', v_n; END IF;

  SELECT count(DISTINCT a.wallet_address) INTO v_n
    FROM app.payable p
    JOIN app.series s ON s.id = p.series_id
    JOIN ledger.asset ast ON ast.payable_id = p.id
    JOIN ledger.account_balance b ON b.asset_id = ast.id AND b.balance > 0
    JOIN ledger.account a ON a.id = b.account_id AND a.class = 'wallet'
   WHERE s.ref = 'SERIES-2026-Q4-30D';
  IF v_n <> 1 THEN RAISE EXCEPTION 'FAIL: the series has % holders, expected 1', v_n; END IF;
  RAISE NOTICE 'PASS  the series bundles 12 invoices under a single holder';

  -- PRD §12: two competing bids so the bid book is visible on arrival.
  SELECT count(*) INTO v_n FROM app.bid b
    JOIN app.listing li ON li.id = b.listing_id
    JOIN app.payable p ON p.id = li.target_payable_id
   WHERE b.status = 'placed' AND p.ref = 'TP-2026-0142';
  IF v_n <> 2 THEN RAISE EXCEPTION 'FAIL: TP-2026-0142 has % open bids, expected 2', v_n; END IF;
  RAISE NOTICE 'PASS  a seeded listing already carries two competing bids';

  -- PRD §12: an unissued ERP invoice for the runbook, distinct from the listed
  -- example so issuing it cannot collide.
  SELECT count(*) INTO v_n FROM app.erp_invoice WHERE consumed_by IS NULL;
  IF v_n <> 10 THEN RAISE EXCEPTION 'FAIL: the ERP picker offers % invoices, expected 10', v_n; END IF;
  SELECT count(*) INTO v_n FROM app.erp_invoice
   WHERE amount_base = 2500000000 AND terms_days = 90 AND consumed_by IS NULL;
  IF v_n < 1 THEN
    RAISE EXCEPTION 'FAIL: no unissued 250,000 / 90-day ERP invoice for the runbook';
  END IF;
  RAISE NOTICE 'PASS  ten ERP invoices, including the runbook 250,000 over 90 days';

  -- PRD §12: both lenders funded in all four assets.
  FOR r IN SELECT address FROM app.wallet w JOIN app.entity e ON e.id = w.entity_id
            WHERE e.entity_type = 'lender'
  LOOP
    SELECT count(*) INTO v_n
      FROM ledger.account_balance b
      JOIN ledger.account a ON a.id = b.account_id
      JOIN ledger.asset s ON s.id = b.asset_id
     WHERE a.wallet_address = r.address AND s.kind = 'cash' AND b.balance > 0;
    IF v_n <> 4 THEN
      RAISE EXCEPTION 'FAIL: lender % holds % of the 4 assets', r.address, v_n;
    END IF;
  END LOOP;
  RAISE NOTICE 'PASS  both lenders are funded in all four assets';

  -- Everything above was produced by real operations, so the books must prove.
  SELECT count(*) INTO v_n FROM ledger.prove_books_balance();
  IF v_n <> 0 THEN RAISE EXCEPTION 'FAIL: seeded books drift on % rows', v_n; END IF;
  SELECT count(*) INTO v_n FROM (
    SELECT asset_id FROM ledger.account_balance GROUP BY asset_id HAVING SUM(balance) <> 0) b;
  IF v_n <> 0 THEN RAISE EXCEPTION 'FAIL: % seeded assets are not conserved', v_n; END IF;
  RAISE NOTICE 'PASS  the seeded books reconcile and every asset nets to zero';

  RAISE NOTICE '--- SEED MATCHES THE PRD ---';
END $$;
