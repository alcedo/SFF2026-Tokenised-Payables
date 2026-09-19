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
  SUPPLIER_ENTITY uuid := 'e0000000-0000-0000-0000-000000000c41';  -- Chien Yu Precision
  v_id   uuid;
  v_state text;
  v_grade text;
  v_face bigint;
  v_maturity date;
  v_supplier uuid;
BEGIN
  ---------------------------------------------------------- manual entry --
  -- PRD §8 screen 2 offers manual entry alongside the ERP import. It has to
  -- produce the same kind of draft, and it has to refuse the four things a
  -- typed form can get wrong that a picked ERP row cannot.
  PERFORM ledger.post(jsonb_build_object(
    'idempotencyKey','bbbb0000-0000-0000-0000-000000000001','actorUserId',PREP,
    'intent', jsonb_build_object('kind','create_payable','ref','TP-2026-0198',
      'supplierId', SUPPLIER_ENTITY, 'invoiceRef','INV-TW-HANDTYPED',
      'faceBase', 1234500000, 'termsDays', 60)));
  SELECT lifecycle_status, face_base, maturity_date, original_supplier_id
    INTO v_state, v_face, v_maturity, v_supplier
    FROM app.payable WHERE ref='TP-2026-0198';
  IF v_state <> 'draft' THEN
    RAISE EXCEPTION 'FAIL: manual entry created as %, expected draft', v_state;
  END IF;
  IF v_face <> 1234500000 THEN
    RAISE EXCEPTION 'FAIL: face is %, expected the 1234500000 typed', v_face;
  END IF;
  IF v_maturity <> (SELECT t0 + offset_days + 60 FROM app.world) THEN
    RAISE EXCEPTION 'FAIL: maturity is %, expected today plus the 60-day terms', v_maturity;
  END IF;
  IF v_supplier <> SUPPLIER_ENTITY THEN
    RAISE EXCEPTION 'FAIL: manual entry named the wrong supplier';
  END IF;
  RAISE NOTICE 'PASS  a hand-typed invoice becomes a draft with derived maturity';

  BEGIN
    PERFORM ledger.post(jsonb_build_object(
      'idempotencyKey','bbbb0000-0000-0000-0000-000000000002','actorUserId',PREP,
      'intent', jsonb_build_object('kind','create_payable','ref','TP-2026-0197',
        'supplierId', SUPPLIER_ENTITY, 'invoiceRef','INV-TW-HANDTYPED',
        'faceBase', 5000000, 'termsDays', 30)));
    RAISE EXCEPTION 'FAIL: the same invoice was financed twice';
  EXCEPTION WHEN sqlstate 'ADA22' THEN
    RAISE NOTICE 'PASS  one supplier invoice cannot be financed twice, under its own code';
  END;

  BEGIN
    PERFORM ledger.post(jsonb_build_object(
      'idempotencyKey','bbbb0000-0000-0000-0000-000000000003','actorUserId',PREP,
      'intent', jsonb_build_object('kind','create_payable','ref','TP-2026-0196',
        'supplierId', SUPPLIER_ENTITY, 'invoiceRef','INV-TW-ZERODAY',
        'faceBase', 5000000, 'termsDays', 0)));
    RAISE EXCEPTION 'FAIL: accepted terms that mature on the issue date';
  EXCEPTION WHEN sqlstate 'ADA23' THEN
    RAISE NOTICE 'PASS  zero-day terms are refused at creation, not at issuance';
  END;

  BEGIN
    PERFORM ledger.post(jsonb_build_object(
      'idempotencyKey','bbbb0000-0000-0000-0000-000000000004','actorUserId',PREP,
      'intent', jsonb_build_object('kind','create_payable','ref','TP-2026-0195',
        'supplierId', SUPPLIER_ENTITY, 'invoiceRef','   ',
        'faceBase', 5000000, 'termsDays', 30)));
    RAISE EXCEPTION 'FAIL: accepted a blank invoice reference';
  EXCEPTION WHEN sqlstate 'ADA25' THEN
    RAISE NOTICE 'PASS  a blank invoice reference is refused';
  END;

  BEGIN
    PERFORM ledger.post(jsonb_build_object(
      'idempotencyKey','bbbb0000-0000-0000-0000-000000000005','actorUserId',PREP,
      'intent', jsonb_build_object('kind','create_payable','ref','TP-2026-0194',
        'supplierId', (SELECT id FROM app.entity WHERE entity_type='lender' LIMIT 1),
        'invoiceRef','INV-TW-WRONGPARTY', 'faceBase', 5000000, 'termsDays', 30)));
    RAISE EXCEPTION 'FAIL: created a payable owed to a lender';
  EXCEPTION WHEN sqlstate 'ADA24' THEN
    RAISE NOTICE 'PASS  only a supplier can be the original supplier';
  END;

  ------------------------------------------------------------ ERP import --
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

  BEGIN
    PERFORM ledger.post(jsonb_build_object(
      'idempotencyKey','aaaa0000-0000-0000-0000-00000000000f','actorUserId',ADMIN,
      'intent', jsonb_build_object('kind','certify','payableId',v_id)));
    RAISE EXCEPTION 'FAIL: certified an ungraded payable';
  EXCEPTION
    WHEN sqlstate 'ADA35' THEN
      RAISE NOTICE 'PASS  certify without a grade is refused by name';
    WHEN check_violation THEN
      RAISE EXCEPTION 'FAIL: certify without a grade still dies as a check constraint';
  END;
  SELECT lifecycle_status, grade::text INTO v_state, v_grade FROM app.payable WHERE id=v_id;
  IF v_state <> 'approved' OR v_grade IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL: the refused certify changed the payable';
  END IF;

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

  -- PRD §3 question 7: the payable lands in an inbox, not in a tradeable
  -- position, and the supplier decides whether to take delivery.
  IF (SELECT receipt_status FROM app.payable WHERE id=v_id) <> 'pending' THEN
    RAISE EXCEPTION 'FAIL: an issued payable should await acceptance';
  END IF;
  BEGIN
    PERFORM ledger.post(jsonb_build_object(
      'idempotencyKey','aaaa0000-0000-0000-0000-000000000009','actorUserId',PREP,
      'intent', jsonb_build_object('kind','publish_listing','payableId',v_id,
        'sellerWallet',SUPP,'quantityBase',1000000000,'minPriceBase',970000000)));
    RAISE EXCEPTION 'FAIL: an unaccepted payable was listed';
  EXCEPTION WHEN sqlstate 'ADA15' THEN
    RAISE NOTICE 'PASS  a payable awaiting acceptance cannot be listed';
  END;

  PERFORM ledger.post(jsonb_build_object(
    'idempotencyKey','aaaa0000-0000-0000-0000-00000000000a','actorUserId',PREP,
    'intent', jsonb_build_object('kind','accept_receipt','payableId',v_id)));
  IF (SELECT receipt_status FROM app.payable WHERE id=v_id) <> 'accepted' THEN
    RAISE EXCEPTION 'FAIL: acceptance did not take';
  END IF;
  RAISE NOTICE 'PASS  the supplier accepts delivery and the payable becomes tradeable';

  -- Declining returns the whole quantity to the anchor rather than burning it,
  -- so holdings still sum to outstanding face.
  DECLARE
    v_other uuid;
    v_anchor text;
  BEGIN
    -- TP-2026-0119 is held outright; the other seeded payables have their
    -- quantity escrowed against an open listing, which cannot be declined.
    SELECT id INTO v_other FROM app.payable WHERE ref = 'TP-2026-0119';
    SELECT address INTO v_anchor FROM app.wallet w JOIN app.entity e ON e.id = w.entity_id
     WHERE e.entity_type = 'anchor';
    -- Reset that payable's receipt so the decline path can be exercised.
    UPDATE app.payable SET receipt_status = 'pending' WHERE id = v_other;
    BEGIN
      PERFORM ledger.post(jsonb_build_object(
        'idempotencyKey','aaaa0000-0000-0000-0000-00000000000c','actorUserId',ADMIN,
        'intent', jsonb_build_object('kind','reject_receipt','payableId',v_other,
          'holderWallet','0x1e4de40000000000000000000000000000004b13')));
      RAISE EXCEPTION 'FAIL: a decline from a wallet that does not hold the face was accepted';
    EXCEPTION WHEN sqlstate 'ADA21' THEN
      RAISE NOTICE 'PASS  declining from a wallet that does not hold the face is refused';
    END;
    IF (SELECT receipt_status FROM app.payable WHERE id = v_other) <> 'pending' THEN
      RAISE EXCEPTION 'FAIL: a refused decline still marked the receipt rejected';
    END IF;
    PERFORM ledger.post(jsonb_build_object(
      'idempotencyKey','aaaa0000-0000-0000-0000-00000000000b','actorUserId',ADMIN,
      'intent', jsonb_build_object('kind','reject_receipt','payableId',v_other,
        'holderWallet','0x5f0451000000000000000000000000000000c119')));
    IF (SELECT SUM(quantity_base) FROM ledger.v_holding WHERE payable_id = v_other)
       <> (SELECT face_base FROM app.payable WHERE id = v_other) THEN
      RAISE EXCEPTION 'FAIL: a declined payable no longer sums to its face';
    END IF;
    IF (SELECT quantity_base FROM ledger.v_holding
         WHERE payable_id = v_other AND wallet_address = v_anchor) IS NULL THEN
      RAISE EXCEPTION 'FAIL: a declined payable did not return to the anchor';
    END IF;
    RAISE NOTICE 'PASS  declining returns the full quantity to the anchor, face intact';
  END;

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
