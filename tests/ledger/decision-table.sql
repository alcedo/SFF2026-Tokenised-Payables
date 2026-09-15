\set ON_ERROR_STOP on
\i tests/ledger/fixture.sql
\i tests/ledger/helpers.sql

\echo '=============================================================='
\echo ' DECISION TABLE: fields and compliance'
\echo '=============================================================='

DO $$
DECLARE
  PREP  uuid := '11111111-0000-0000-0000-000000000001';
  SUPP  uuid := 'e0000000-0000-0000-0000-0000000000a2';
  LEND  uuid := 'e0000000-0000-0000-0000-0000000000a3';
  BANK  text := '0x1e4de40000000000000000000000000000004b13';
  SELL  text := '0x509911000000000000000000000000000000f88a';
  LIST  uuid := '7a000000-0000-0000-0000-0000000000ab';
  PAY   uuid := '9a000000-0000-0000-0000-000000000141';
  v_before bigint;
  v_caught text;
  v_n bigint;
BEGIN
  SELECT count(*) INTO v_before FROM app.payable;

  BEGIN
    PERFORM ledger.post(jsonb_build_object(
      'idempotencyKey','d1000000-0000-0000-0000-000000000001','actorUserId',PREP,
      'intent', jsonb_build_object('kind','create_payable','ref','TP-DT-0001',
        'supplierId', SUPP, 'invoiceRef','INV-DT-ZERO','faceBase', 10000, 'termsDays', 0)));
    RAISE EXCEPTION 'FAIL: termsDays=0 was accepted';
  EXCEPTION WHEN sqlstate 'ADA23' THEN
    RAISE NOTICE 'PASS  termsDays=0 is refused as invalid_terms';
  END;

  PERFORM ledger.post(jsonb_build_object(
    'idempotencyKey','d1000000-0000-0000-0000-000000000002','actorUserId',PREP,
    'intent', jsonb_build_object('kind','create_payable','ref','TP-DT-0002',
      'supplierId', SUPP, 'invoiceRef','INV-DT-ONE','faceBase', 10000, 'termsDays', 1)));
  RAISE NOTICE 'PASS  termsDays=1 is accepted';

  PERFORM ledger.post(jsonb_build_object(
    'idempotencyKey','d1000000-0000-0000-0000-000000000003','actorUserId',PREP,
    'intent', jsonb_build_object('kind','create_payable','ref','TP-DT-0003',
      'supplierId', SUPP, 'invoiceRef','INV-DT-YEAR','faceBase', 10000, 'termsDays', 365)));
  RAISE NOTICE 'PASS  termsDays=365 is accepted';

  BEGIN
    PERFORM ledger.post(jsonb_build_object(
      'idempotencyKey','d1000000-0000-0000-0000-000000000004','actorUserId',PREP,
      'intent', jsonb_build_object('kind','create_payable','ref','TP-DT-0004',
        'supplierId', SUPP, 'invoiceRef','INV-DT-366','faceBase', 10000, 'termsDays', 366)));
    RAISE EXCEPTION 'FAIL: termsDays=366 was accepted';
  EXCEPTION WHEN sqlstate 'ADA23' THEN
    RAISE NOTICE 'PASS  termsDays=366 is refused as invalid_terms';
  END;

  BEGIN
    PERFORM ledger.post(jsonb_build_object(
      'idempotencyKey','d1000000-0000-0000-0000-000000000005','actorUserId',PREP,
      'intent', jsonb_build_object('kind','create_payable','ref','TP-DT-0005',
        'supplierId', SUPP, 'invoiceRef','INV-DT-FACE0','faceBase', 0, 'termsDays', 30)));
    RAISE EXCEPTION 'FAIL: faceBase=0 was accepted';
  EXCEPTION WHEN sqlstate 'ADA19' THEN
    RAISE NOTICE 'PASS  faceBase=0 is refused as invalid_amount';
  END;

  PERFORM ledger.post(jsonb_build_object(
    'idempotencyKey','d1000000-0000-0000-0000-000000000006','actorUserId',PREP,
    'intent', jsonb_build_object('kind','create_payable','ref','TP-DT-0006',
      'supplierId', SUPP, 'invoiceRef','INV-DT-FACE1','faceBase', 1, 'termsDays', 30)));
  IF (SELECT face_base FROM app.payable WHERE ref='TP-DT-0006') <> 1 THEN
    RAISE EXCEPTION 'FAIL: the one-base-unit face was not stored as 1';
  END IF;
  RAISE NOTICE 'PASS  faceBase=1, the minimum unit, is accepted';

  BEGIN
    PERFORM ledger.post(jsonb_build_object(
      'idempotencyKey','d1000000-0000-0000-0000-000000000007','actorUserId',PREP,
      'intent', jsonb_build_object('kind','create_payable','ref','TP-DT-0007',
        'supplierId', LEND, 'invoiceRef','INV-DT-LENDER','faceBase', 10000, 'termsDays', 30)));
    RAISE EXCEPTION 'FAIL: a lender was accepted as the original supplier';
  EXCEPTION WHEN sqlstate 'ADA24' THEN
    RAISE NOTICE 'PASS  a lender cannot be the original supplier';
  END;

  BEGIN
    PERFORM ledger.post(jsonb_build_object(
      'idempotencyKey','d1000000-0000-0000-0000-000000000008','actorUserId',PREP,
      'intent', jsonb_build_object('kind','create_payable','ref','TP-DT-0008',
        'supplierId', SUPP, 'invoiceRef','','faceBase', 10000, 'termsDays', 30)));
    RAISE EXCEPTION 'FAIL: a blank invoice reference was accepted';
  EXCEPTION WHEN sqlstate 'ADA25' THEN
    RAISE NOTICE 'PASS  a blank invoice reference is refused';
  END;

  PERFORM ledger.post(jsonb_build_object(
    'idempotencyKey','d1000000-0000-0000-0000-000000000009','actorUserId','11111111-0000-0000-0000-000000000003',
    'intent', jsonb_build_object('kind','publish_listing','listingId', LIST,
      'payableId', PAY, 'sellerWallet', SELL, 'quantityBase', 1000000000, 'minPriceBase', 978500000)));
  BEGIN
    PERFORM ledger.post(jsonb_build_object(
      'idempotencyKey','d1000000-0000-0000-0000-00000000000a','actorUserId','11111111-0000-0000-0000-000000000003',
      'intent', jsonb_build_object('kind','place_bid','listingId', LIST,
        'bidderWallet', SELL, 'priceBase', 978500000, 'fundingCode','XUSD')));
    RAISE EXCEPTION 'FAIL: the seller placed a bid as a non-institutional account';
  EXCEPTION WHEN sqlstate 'ADA34' OR sqlstate 'ADA11' OR sqlstate 'ADA15' THEN
    RAISE NOTICE 'PASS  a non-institutional seller cannot bid on the listing';
  END;

  SELECT count(*) INTO v_n FROM app.payable;
  IF v_n < v_before THEN
    RAISE EXCEPTION 'FAIL: a refused row deleted a payable';
  END IF;
  IF (SELECT count(*) FROM ledger.prove_books_balance()) <> 0 THEN
    RAISE EXCEPTION 'FAIL: the books drifted';
  END IF;
  RAISE NOTICE 'PASS  refused rows left the books balanced';
  RAISE NOTICE '--- DECISION TABLE HOLDS ---';
END $$;
