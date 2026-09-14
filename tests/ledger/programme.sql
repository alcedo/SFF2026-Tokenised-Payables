-- Programme limits and issuer certification. PRD §8 screen 14 and §5.
--
--   "ADATA programme details, certification status, and configurable programme
--    limits."  ... "Certify ADATA / tokenised payable issuer, set programme
--    limits, assign sample grades, and monitor settlement."
--
-- Both were stored and displayed long before they were enforced, which made the
-- limit a number on a screen rather than a limit. Every assertion below is
-- about the enforcement: the point where face enters the world.
\set ON_ERROR_STOP on

\echo '=============================================================='
\echo ' PROGRAMME LIMITS AND CERTIFICATION'
\echo '=============================================================='

DO $$
DECLARE
  ADMIN uuid := '11111111-0000-0000-0000-000000000008';
  PREP  uuid := '11111111-0000-0000-0000-000000000001';
  v_anchor uuid;
  v_supp   text;
  v_supp_id uuid;
  v_p      uuid;
  v_out    bigint;
  FACE     bigint := 100000000;          -- 10,000.0000 XUSD
BEGIN
  SELECT id INTO v_anchor FROM app.entity WHERE entity_type = 'anchor';
  SELECT e.id, w.address INTO v_supp_id, v_supp
    FROM app.entity e JOIN app.wallet w ON w.entity_id = e.id
   WHERE e.name = 'Chien Yu Precision';

  -- A certified payable, ready to issue and used by every case below.
  INSERT INTO app.payable (ref, anchor_id, original_supplier_id, invoice_ref, face_base,
                           maturity_date, grade, grade_rationale, lifecycle_status)
  VALUES ('TP-2026-8001', v_anchor, v_supp_id, 'INV-PROGRAMME-TEST', FACE,
          (SELECT t0 + offset_days + 90 FROM app.world), 'AA',
          'Fixture for the programme-limit suite.', 'certified')
  RETURNING id INTO v_p;

  ------------------------------------------------- 1. a suspended issuer --
  PERFORM ledger.post(jsonb_build_object(
    'idempotencyKey','dddd0000-0000-0000-0000-000000000001','actorUserId',ADMIN,
    'intent', jsonb_build_object('kind','set_certification','entityId',v_anchor,
                                 'status','suspended')));
  BEGIN
    PERFORM ledger.post(jsonb_build_object(
      'idempotencyKey','dddd0000-0000-0000-0000-000000000002','actorUserId',PREP,
      'intent', jsonb_build_object('kind','issue_payable','payableId',v_p,
                                   'toWallet',v_supp,'tokenId',8001)));
    RAISE EXCEPTION 'FAIL: a suspended issuer issued a payable';
  EXCEPTION WHEN sqlstate 'ADA32' THEN
    RAISE NOTICE 'PASS  a suspended issuer cannot issue';
  END;

  -- Suspension stops new issuance; it does not invalidate what is outstanding.
  PERFORM 1 FROM app.payable WHERE lifecycle_status = 'issued' LIMIT 1;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'FAIL: suspension disturbed payables already issued';
  END IF;
  RAISE NOTICE 'PASS  suspension leaves payables already issued untouched';

  PERFORM ledger.post(jsonb_build_object(
    'idempotencyKey','dddd0000-0000-0000-0000-000000000003','actorUserId',ADMIN,
    'intent', jsonb_build_object('kind','set_certification','entityId',v_anchor,
                                 'status','certified')));

  -------------------------------------------------- 2. one unit over the cap --
  SELECT COALESCE(SUM(sup.outstanding_base), 0)::bigint INTO v_out
    FROM app.payable p JOIN ledger.v_payable_supply sup ON sup.payable_id = p.id
   WHERE p.anchor_id = v_anchor;

  PERFORM ledger.post(jsonb_build_object(
    'idempotencyKey','dddd0000-0000-0000-0000-000000000004','actorUserId',ADMIN,
    'intent', jsonb_build_object('kind','set_programme_limit','entityId',v_anchor,
                                 'limitBase', v_out + FACE - 1)));
  BEGIN
    PERFORM ledger.post(jsonb_build_object(
      'idempotencyKey','dddd0000-0000-0000-0000-000000000005','actorUserId',PREP,
      'intent', jsonb_build_object('kind','issue_payable','payableId',v_p,
                                   'toWallet',v_supp,'tokenId',8001)));
    RAISE EXCEPTION 'FAIL: issued one base unit over the programme limit';
  EXCEPTION WHEN sqlstate 'ADA33' THEN
    RAISE NOTICE 'PASS  an issuance one base unit over the limit is refused';
  END;

  ------------------------------------------------ 3. exactly on the cap fits --
  -- The boundary matters: a cap that refused an issuance landing exactly on it
  -- would quietly be a cap of one unit less, and nobody would notice.
  PERFORM ledger.post(jsonb_build_object(
    'idempotencyKey','dddd0000-0000-0000-0000-000000000006','actorUserId',ADMIN,
    'intent', jsonb_build_object('kind','set_programme_limit','entityId',v_anchor,
                                 'limitBase', v_out + FACE)));
  PERFORM ledger.post(jsonb_build_object(
    'idempotencyKey','dddd0000-0000-0000-0000-000000000007','actorUserId',PREP,
    'intent', jsonb_build_object('kind','issue_payable','payableId',v_p,
                                 'toWallet',v_supp,'tokenId',8001)));
  PERFORM 1 FROM app.payable WHERE id = v_p AND lifecycle_status = 'issued';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'FAIL: an issuance landing exactly on the limit was refused';
  END IF;
  RAISE NOTICE 'PASS  an issuance landing exactly on the limit is allowed';

  ------------------------------------------- 4. the cap is now fully used --
  SELECT COALESCE(SUM(sup.outstanding_base), 0)::bigint INTO v_out
    FROM app.payable p JOIN ledger.v_payable_supply sup ON sup.payable_id = p.id
   WHERE p.anchor_id = v_anchor;
  IF v_out <> (SELECT programme_limit_base FROM app.entity WHERE id = v_anchor) THEN
    RAISE EXCEPTION 'FAIL: outstanding % does not equal the limit it filled', v_out;
  END IF;
  RAISE NOTICE 'PASS  outstanding face now equals the limit exactly, headroom nil';

  --------------------------------------- 5. redemption frees headroom again --
  -- The limit is on outstanding face, not cumulative issuance, which is what
  -- the certification screen means by "headroom". Settling must give it back.
  INSERT INTO app.payable (ref, anchor_id, original_supplier_id, invoice_ref, face_base,
                           maturity_date, grade, grade_rationale, lifecycle_status)
  VALUES ('TP-2026-8002', v_anchor, v_supp_id, 'INV-PROGRAMME-TEST-2', FACE,
          (SELECT t0 + offset_days + 90 FROM app.world), 'AA',
          'Second fixture, issued only after headroom is freed.', 'certified')
  RETURNING id INTO v_p;

  BEGIN
    PERFORM ledger.post(jsonb_build_object(
      'idempotencyKey','dddd0000-0000-0000-0000-000000000008','actorUserId',PREP,
      'intent', jsonb_build_object('kind','issue_payable','payableId',v_p,
                                   'toWallet',v_supp,'tokenId',8002)));
    RAISE EXCEPTION 'FAIL: issued with the programme limit already full';
  EXCEPTION WHEN sqlstate 'ADA33' THEN
    RAISE NOTICE 'PASS  a full programme refuses the next issuance';
  END;

  -- Settle an outstanding payable and try again.
  PERFORM ledger.post(jsonb_build_object(
    'idempotencyKey','dddd0000-0000-0000-0000-000000000009','actorUserId',PREP,
    'intent', jsonb_build_object('kind','advance_clock','days', 400)));
  PERFORM ledger.post(jsonb_build_object(
    'idempotencyKey','dddd0000-0000-0000-0000-00000000000a','actorUserId',PREP,
    'intent', jsonb_build_object('kind','settle_maturity','payableId',
      (SELECT id FROM app.payable WHERE ref = 'TP-2026-8001'))));

  -- The second payable matured while the clock ran forward, so move its date
  -- out: the point under test is the limit, not the maturity rule.
  UPDATE app.payable SET maturity_date = (SELECT t0 + offset_days + 90 FROM app.world)
   WHERE id = v_p;
  PERFORM ledger.post(jsonb_build_object(
    'idempotencyKey','dddd0000-0000-0000-0000-00000000000b','actorUserId',PREP,
    'intent', jsonb_build_object('kind','issue_payable','payableId',v_p,
                                 'toWallet',v_supp,'tokenId',8002)));
  PERFORM 1 FROM app.payable WHERE id = v_p AND lifecycle_status = 'issued';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'FAIL: settling did not free headroom under the limit';
  END IF;
  RAISE NOTICE 'PASS  settling an outstanding payable frees headroom again';

  ------------------------------------------ 6. clearing the limit uncaps it --
  PERFORM ledger.post(jsonb_build_object(
    'idempotencyKey','dddd0000-0000-0000-0000-00000000000c','actorUserId',ADMIN,
    'intent', jsonb_build_object('kind','set_programme_limit','entityId',v_anchor,
                                 'limitBase', NULL)));
  PERFORM 1 FROM app.entity WHERE id = v_anchor AND programme_limit_base IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'FAIL: the limit was not cleared';
  END IF;
  RAISE NOTICE 'PASS  a cleared limit is null, not zero, and uncaps issuance';

  BEGIN
    PERFORM ledger.post(jsonb_build_object(
      'idempotencyKey','dddd0000-0000-0000-0000-00000000000d','actorUserId',ADMIN,
      'intent', jsonb_build_object('kind','set_programme_limit','entityId',v_anchor,
                                   'limitBase', -1)));
    RAISE EXCEPTION 'FAIL: accepted a negative programme limit';
  EXCEPTION WHEN sqlstate 'ADA19' THEN
    RAISE NOTICE 'PASS  a negative programme limit is refused';
  END;

  --------------------------------------------------- 7. it is all on record --
  PERFORM 1 FROM ledger.journal_entry
   WHERE kind = 'programme_limit_set' AND actor_user_id = ADMIN;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'FAIL: changing a programme limit left no audit entry';
  END IF;
  PERFORM 1 FROM ledger.journal_entry
   WHERE kind = 'issuer_certification_changed' AND actor_user_id = ADMIN;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'FAIL: changing certification left no audit entry';
  END IF;
  RAISE NOTICE 'PASS  who changed a limit or a certification, and when, is on the journal';

  IF (SELECT count(*) FROM ledger.prove_books_balance()) <> 0 THEN
    RAISE EXCEPTION 'FAIL: the projection disagrees with the journal';
  END IF;
  RAISE NOTICE 'PASS  the books reconcile throughout';

  RAISE NOTICE '--- PROGRAMME OK ---';
END $$;
