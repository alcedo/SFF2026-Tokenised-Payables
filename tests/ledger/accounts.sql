-- Onboarding, personas and account removal. PRD §5 and §8 screen 5.
--
--   "There should be a feature to create new account for new users, and assign
--    them a persona... StraitsX admin account is the only one where there's 1
--    single account managed by 1 single user. The admin account can delete all
--    other users from the platform."
--
-- Every rule above is a way the world can be put into a state the rest of the
-- product cannot handle: a persona that does not match its organisation, two
-- administrators, or an organisation whose wallet nobody can reach. Each one is
-- attempted here.
\set ON_ERROR_STOP on

\echo '=============================================================='
\echo ' ACCOUNTS'
\echo '=============================================================='

DO $$
DECLARE
  ADMIN uuid := '11111111-0000-0000-0000-000000000008';
  v_entity uuid;
  v_user   uuid;
  v_second uuid;
  v_wallet text;
  v_n      bigint;
  v_before bigint;
BEGIN
  SELECT count(*) INTO v_before FROM app.app_user WHERE deactivated_at IS NULL;

  ------------------------------------------------------------- 1. onboard --
  PERFORM ledger.post(jsonb_build_object(
    'idempotencyKey','cccc0000-0000-0000-0000-000000000001','actorUserId',ADMIN,
    'intent', jsonb_build_object('kind','onboard_entity','name','Formosa Precision Works',
      'entityType','supplier','userName','Lin Ya-Chi','role','supplier')));

  SELECT e.id, w.address INTO v_entity, v_wallet
    FROM app.entity e JOIN app.wallet w ON w.entity_id = e.id
   WHERE e.name = 'Formosa Precision Works';
  IF v_entity IS NULL THEN
    RAISE EXCEPTION 'FAIL: onboarding created no organisation';
  END IF;
  IF v_wallet !~ '^0x[0-9a-f]{40}$' THEN
    RAISE EXCEPTION 'FAIL: custodial wallet % is not a platform address', v_wallet;
  END IF;
  RAISE NOTICE 'PASS  onboarding creates an organisation and mints its custodial wallet';

  SELECT id INTO v_user FROM app.app_user WHERE entity_id = v_entity;
  PERFORM 1 FROM app.app_user
   WHERE id = v_user AND role = 'supplier' AND mock_kyc_verified
     AND NOT institutional_eligible;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'FAIL: the first user is not a KYC-verified supplier';
  END IF;
  RAISE NOTICE 'PASS  the first user is KYC verified on submit, with the matching persona';

  -- PRD §5: the new account appears in the switcher, which reads app_user.
  SELECT count(*) INTO v_n FROM app.app_user WHERE deactivated_at IS NULL;
  IF v_n <> v_before + 1 THEN
    RAISE EXCEPTION 'FAIL: the switcher gained % accounts, expected 1', v_n - v_before;
  END IF;
  RAISE NOTICE 'PASS  the new account is immediately switchable';

  ----------------------------------------------------- 2. duplicate names --
  BEGIN
    PERFORM ledger.post(jsonb_build_object(
      'idempotencyKey','cccc0000-0000-0000-0000-000000000002','actorUserId',ADMIN,
      'intent', jsonb_build_object('kind','onboard_entity','name','formosa precision works',
        'entityType','supplier','userName','Someone Else','role','supplier')));
    RAISE EXCEPTION 'FAIL: two organisations share a name, differing only in case';
  EXCEPTION WHEN sqlstate 'ADA27' THEN
    RAISE NOTICE 'PASS  a duplicate organisation name is refused, case-insensitively';
  END;

  ------------------------------------------------- 3. anchor is a fixture --
  BEGIN
    PERFORM ledger.post(jsonb_build_object(
      'idempotencyKey','cccc0000-0000-0000-0000-000000000003','actorUserId',ADMIN,
      'intent', jsonb_build_object('kind','onboard_entity','name','Rival Anchor Ltd',
        'entityType','anchor','userName','X','role','adata_preparer')));
    RAISE EXCEPTION 'FAIL: onboarded a second anchor obligor';
  EXCEPTION WHEN sqlstate 'ADA29' THEN
    RAISE NOTICE 'PASS  only a supplier or a lender can be onboarded';
  END;

  ------------------------------------------------------ 4. persona fits org --
  BEGIN
    PERFORM ledger.post(jsonb_build_object(
      'idempotencyKey','cccc0000-0000-0000-0000-000000000004','actorUserId',ADMIN,
      'intent', jsonb_build_object('kind','create_user','entityId', v_entity,
        'userName','Wrong Persona','role','lender')));
    RAISE EXCEPTION 'FAIL: a lender persona was created inside a supplier company';
  EXCEPTION WHEN sqlstate 'ADA29' THEN
    RAISE NOTICE 'PASS  a persona cannot be assigned to the wrong kind of organisation';
  END;

  --------------------------------------------------- 5. exactly one admin --
  BEGIN
    PERFORM ledger.post(jsonb_build_object(
      'idempotencyKey','cccc0000-0000-0000-0000-000000000005','actorUserId',ADMIN,
      'intent', jsonb_build_object('kind','create_user','entityId',
        (SELECT id FROM app.entity WHERE entity_type = 'platform' LIMIT 1),
        'userName','Second Admin','role','straitsx_admin')));
    RAISE EXCEPTION 'FAIL: the platform has two administrators';
  EXCEPTION WHEN sqlstate 'ADA29' THEN
    RAISE NOTICE 'PASS  there can only be one StraitsX administrator';
  END;

  BEGIN
    PERFORM ledger.post(jsonb_build_object(
      'idempotencyKey','cccc0000-0000-0000-0000-000000000006','actorUserId',ADMIN,
      'intent', jsonb_build_object('kind','remove_user','userId', ADMIN)));
    RAISE EXCEPTION 'FAIL: the administrator removed themselves';
  EXCEPTION WHEN sqlstate 'ADA15' THEN
    RAISE NOTICE 'PASS  the administrator cannot be removed';
  END;

  ------------------------------------------------- 6. no orphaned wallets --
  BEGIN
    PERFORM ledger.post(jsonb_build_object(
      'idempotencyKey','cccc0000-0000-0000-0000-000000000007','actorUserId',ADMIN,
      'intent', jsonb_build_object('kind','remove_user','userId', v_user)));
    RAISE EXCEPTION 'FAIL: removing the last account stranded an organisation wallet';
  EXCEPTION WHEN sqlstate 'ADA30' THEN
    RAISE NOTICE 'PASS  removing the only account of an organisation is refused';
  END;

  ------------------------------------------------------------- 7. removal --
  PERFORM ledger.post(jsonb_build_object(
    'idempotencyKey','cccc0000-0000-0000-0000-000000000008','actorUserId',ADMIN,
    'intent', jsonb_build_object('kind','create_user','entityId', v_entity,
      'userName','Chou Yi-Hsuan','role','supplier')));
  SELECT id INTO v_second FROM app.app_user
   WHERE entity_id = v_entity AND name = 'Chou Yi-Hsuan';

  PERFORM ledger.post(jsonb_build_object(
    'idempotencyKey','cccc0000-0000-0000-0000-000000000009','actorUserId',ADMIN,
    'intent', jsonb_build_object('kind','remove_user','userId', v_user)));

  PERFORM 1 FROM app.app_user WHERE id = v_user AND deactivated_at IS NOT NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'FAIL: the removed account is still active';
  END IF;
  RAISE NOTICE 'PASS  an account can be removed once its organisation has another';

  -- Removal is deactivation, because the journal names its actor. The row has
  -- to survive or the audit trail breaks at the first entry that user made.
  PERFORM 1 FROM app.app_user WHERE id = v_user;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'FAIL: the row was deleted, so its audit entries are unattributable';
  END IF;
  SELECT count(*) INTO v_n FROM ledger.journal_entry j
    JOIN app.app_user u ON u.id = j.actor_user_id;
  IF v_n <> (SELECT count(*) FROM ledger.journal_entry) THEN
    RAISE EXCEPTION 'FAIL: % journal entries lost their actor',
      (SELECT count(*) FROM ledger.journal_entry) - v_n;
  END IF;
  RAISE NOTICE 'PASS  every journal entry still names its actor after a removal';

  -- And the wallet is still reachable, which is the whole reason for the rule.
  PERFORM 1 FROM app.app_user u
    JOIN app.wallet w ON w.entity_id = u.entity_id
   WHERE w.address = v_wallet AND u.deactivated_at IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'FAIL: wallet % is no longer reachable by any account', v_wallet;
  END IF;
  RAISE NOTICE 'PASS  the organisation wallet is still reachable by a live account';

  ------------------------------------- 8. nothing held is unreachable --
  -- Not "every wallet has an account": the seed includes tier-2 suppliers who
  -- sold their whole position into the series lot and no longer have one,
  -- which is a real state, not a broken one. What must never happen is a
  -- wallet that still holds something with nobody able to act on it.
  SELECT count(*) INTO v_n FROM ledger.v_holding h
    JOIN app.wallet w ON w.address = h.wallet_address
   WHERE NOT EXISTS (SELECT 1 FROM app.app_user u
                      WHERE u.entity_id = w.entity_id AND u.deactivated_at IS NULL);
  IF v_n <> 0 THEN
    RAISE EXCEPTION 'FAIL: % holdings sit in wallets no live account can reach', v_n;
  END IF;
  RAISE NOTICE 'PASS  no holding is stranded in an unreachable wallet';

  --------------------------------- 8b. a supplier who cannot take delivery --
  BEGIN
    PERFORM ledger.post(jsonb_build_object(
      'idempotencyKey','cccc0000-0000-0000-0000-00000000000a','actorUserId',ADMIN,
      'intent', jsonb_build_object('kind','create_payable','ref','TP-2026-9901',
        'supplierId', (SELECT e.id FROM app.entity e
                        WHERE e.entity_type = 'supplier'
                          AND NOT EXISTS (SELECT 1 FROM app.app_user u
                                           WHERE u.entity_id = e.id AND u.deactivated_at IS NULL)
                        LIMIT 1),
        'invoiceRef','INV-TW-NOACCOUNT','faceBase', 5000000, 'termsDays', 30)));
    RAISE EXCEPTION 'FAIL: created a payable for a supplier who cannot accept it';
  EXCEPTION WHEN sqlstate 'ADA31' THEN
    RAISE NOTICE 'PASS  a payable cannot be raised against a supplier with no account';
  END;

  ------------------------------------------------------------ 9. the books --
  SELECT count(*) INTO v_n FROM ledger.prove_books_balance();
  IF v_n <> 0 THEN RAISE EXCEPTION 'FAIL: projection disagrees on % rows', v_n; END IF;
  RAISE NOTICE 'PASS  the books still reconcile after onboarding and removal';

  RAISE NOTICE '--- ACCOUNTS OK ---';
END $$;
