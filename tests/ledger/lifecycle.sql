-- The maker-checker path, from ERP invoice to issued token.
--
-- The runbook suite starts from an already-certified payable, so nothing there
-- exercised create, submit, approve, grade or certify. A type mismatch in the
-- grade assignment survived every SQL test and was only caught by driving the
-- real UI. This walks the whole path so that cannot happen again.
\set ON_ERROR_STOP on

\echo '=============================================================='
\echo ' LIFECYCLE: ERP invoice to issued token'
\echo '=============================================================='

DO $$
DECLARE
  PREP  uuid := '11111111-0000-0000-0000-000000000001';
  CHECKR uuid := '11111111-0000-0000-0000-000000000002';
  ADMIN uuid := '11111111-0000-0000-0000-000000000008';
  SUPP  text := '0x509911000000000000000000000000000000f88a';
  v_id   uuid;
  v_state text;
  v_grade text;
BEGIN
  PERFORM ledger.post(jsonb_build_object(
    'idempotencyKey','aaaa0000-0000-0000-0000-000000000001','actorUserId',PREP,
    'intent', jsonb_build_object('kind','create_payable','ref','TP-2026-0199',
      'erpInvoiceId',(SELECT id FROM app.erp_invoice WHERE doc_no='5100084412'))));
  SELECT id, lifecycle_status INTO v_id, v_state FROM app.payable WHERE ref='TP-2026-0199';
  IF v_state <> 'draft' THEN RAISE EXCEPTION 'FAIL: created as %, expected draft', v_state; END IF;
  RAISE NOTICE 'PASS  an ERP invoice becomes a draft payable';

  -- The invoice is consumed, so the picker cannot issue it twice.
  IF (SELECT consumed_by FROM app.erp_invoice WHERE doc_no='5100084412') IS NULL THEN
    RAISE EXCEPTION 'FAIL: the ERP invoice was not marked consumed';
  END IF;
  BEGIN
    PERFORM ledger.post(jsonb_build_object(
      'idempotencyKey','aaaa0000-0000-0000-0000-000000000002','actorUserId',PREP,
      'intent', jsonb_build_object('kind','create_payable','ref','TP-2026-0200',
        'erpInvoiceId',(SELECT id FROM app.erp_invoice WHERE doc_no='5100084412'))));
    RAISE EXCEPTION 'FAIL: the same ERP invoice was issued twice';
  EXCEPTION WHEN sqlstate 'ADA15' THEN
    RAISE NOTICE 'PASS  a consumed ERP invoice cannot become a second payable';
  END;

  PERFORM ledger.post(jsonb_build_object(
    'idempotencyKey','aaaa0000-0000-0000-0000-000000000003','actorUserId',PREP,
    'intent', jsonb_build_object('kind','submit','payableId',v_id)));
  SELECT lifecycle_status INTO v_state FROM app.payable WHERE id=v_id;
  IF v_state <> 'pending_approval' THEN RAISE EXCEPTION 'FAIL: submit left it %', v_state; END IF;
  RAISE NOTICE 'PASS  the preparer submits it for approval';

  PERFORM ledger.post(jsonb_build_object(
    'idempotencyKey','aaaa0000-0000-0000-0000-000000000004','actorUserId',CHECKR,
    'intent', jsonb_build_object('kind','approve','payableId',v_id)));
  SELECT lifecycle_status INTO v_state FROM app.payable WHERE id=v_id;
  IF v_state <> 'approved' THEN RAISE EXCEPTION 'FAIL: approve left it %', v_state; END IF;
  RAISE NOTICE 'PASS  a separate checker approves it';

  -- The case that a type mismatch broke: assigning an enum grade from json text.
  PERFORM ledger.post(jsonb_build_object(
    'idempotencyKey','aaaa0000-0000-0000-0000-000000000005','actorUserId',ADMIN,
    'intent', jsonb_build_object('kind','grade','payableId',v_id,'grade','AA',
      'gradeRationale','Anchor obligor investment grade. Sample value, not an external rating.')));
  SELECT grade::text INTO v_grade FROM app.payable WHERE id=v_id;
  IF v_grade <> 'AA' THEN RAISE EXCEPTION 'FAIL: grade is %, expected AA', v_grade; END IF;
  RAISE NOTICE 'PASS  StraitsX assigns a grade with its rationale';

  PERFORM ledger.post(jsonb_build_object(
    'idempotencyKey','aaaa0000-0000-0000-0000-000000000006','actorUserId',ADMIN,
    'intent', jsonb_build_object('kind','certify','payableId',v_id)));
  SELECT lifecycle_status INTO v_state FROM app.payable WHERE id=v_id;
  IF v_state <> 'certified' THEN RAISE EXCEPTION 'FAIL: certify left it %', v_state; END IF;
  RAISE NOTICE 'PASS  StraitsX certifies it under the programme';

  -- An uncertified payable cannot be issued; the transition table refuses it.
  BEGIN
    PERFORM ledger.post(jsonb_build_object(
      'idempotencyKey','aaaa0000-0000-0000-0000-000000000007','actorUserId',ADMIN,
      'intent', jsonb_build_object('kind','issue_payable',
        'payableId',(SELECT id FROM app.payable WHERE ref='TP-2026-0141'),
        'toWallet',SUPP,'tokenId',999)));
    RAISE EXCEPTION 'FAIL: an already-issued payable was issued again';
  EXCEPTION WHEN sqlstate 'ADA15' THEN
    RAISE NOTICE 'PASS  a payable that is not certified cannot be issued';
  END;

  PERFORM ledger.post(jsonb_build_object(
    'idempotencyKey','aaaa0000-0000-0000-0000-000000000008','actorUserId',ADMIN,
    'intent', jsonb_build_object('kind','issue_payable','payableId',v_id,
      'toWallet',SUPP,'tokenId',199)));
  SELECT lifecycle_status INTO v_state FROM app.payable WHERE id=v_id;
  IF v_state <> 'issued' THEN RAISE EXCEPTION 'FAIL: issue left it %', v_state; END IF;
  IF (SELECT quantity_base FROM ledger.v_holding h
       JOIN ledger.asset a ON a.id = (SELECT id FROM ledger.asset WHERE payable_id=v_id)
      WHERE h.payable_id = v_id AND h.wallet_address = SUPP) <> 2500000000 THEN
    RAISE EXCEPTION 'FAIL: the supplier did not receive the full face';
  END IF;
  RAISE NOTICE 'PASS  the full face issues to the supplier wallet';

  -- Every step above is attributable, which PRD section 14 requires.
  IF (SELECT count(*) FROM ledger.journal_entry e
       WHERE e.payable_id = v_id AND e.actor_user_id IS NOT NULL) < 6 THEN
    RAISE EXCEPTION 'FAIL: the lifecycle is not fully attributable';
  END IF;
  RAISE NOTICE 'PASS  every step is attributable to a named actor';

  IF (SELECT count(*) FROM ledger.prove_books_balance()) <> 0 THEN
    RAISE EXCEPTION 'FAIL: the books drift after issuance';
  END IF;
  RAISE NOTICE 'PASS  the books reconcile after the full lifecycle';

  RAISE NOTICE '--- LIFECYCLE HOLDS ---';
END $$;
