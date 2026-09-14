-- ============================================================================
--  ledger.post() — the single write surface
-- ============================================================================
-- Loaded after schema.sql. Kept in its own file so it can be replaced with
-- CREATE OR REPLACE during development without dropping the world.
--
-- The contract is stated in schema.sql §10. The order of business inside
-- post() is fixed and is the only lock ordering in the system:
--
--   1. idempotency gate      (before any lock, so replays serialise on the
--                             unique index rather than on the accounts)
--   2. resolve the intent    (what to lock, what legs to post)
--   3. lock in a total order (payable, series, listing, then balance rows)
--   4. recheck under lock    (the authoritative checks; TypeScript's are only
--                             there to produce a good inline message)
--   5. apply app.* effects   (listing status, bid status, lifecycle)
--   6. insert the legs       (triggers project balances; deferred constraints
--                             assert conservation at COMMIT)
--   7. attach the chain result
--
-- LOCK BY PRIMARY KEY ONLY. Never `WHERE id = $1 AND status = 'open' FOR
-- UPDATE`. Under READ COMMITTED, when the winner commits a status change,
-- EvalPlanQual re-evaluates the loser's predicate against the new row, it no
-- longer matches, and the loser gets ZERO ROWS — indistinguishable from "not
-- found". The presenter sees a mystery 404 instead of "already sold". Lock by
-- id, then read the status off the locked row and decide. There is a
-- regression test for this in tests/ledger/concurrency.test.ts.

-- ----------------------------------------------------------------------------
-- Leg specification
-- ----------------------------------------------------------------------------
DROP TYPE IF EXISTS ledger.leg_spec CASCADE;
CREATE TYPE ledger.leg_spec AS (
  account_id uuid,
  asset_id   uuid,
  amount     bigint
);

-- ----------------------------------------------------------------------------
-- Account and asset resolution
-- ----------------------------------------------------------------------------
-- Accounts are created on demand rather than pre-seeded for every (wallet,
-- purpose) pair, because a wallet that never lists anything should not carry an
-- empty escrow account. `ON CONFLICT DO NOTHING` plus a re-select makes this
-- safe under concurrency: two first-time listings for the same wallet race, one
-- inserts, both read back the same id.
CREATE OR REPLACE FUNCTION ledger.wallet_account(p_address text, p_purpose ledger.account_purpose)
RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE v_id uuid;
BEGIN
  SELECT id INTO v_id FROM ledger.account
   WHERE class = 'wallet' AND wallet_address = p_address AND purpose = p_purpose;
  IF v_id IS NOT NULL THEN RETURN v_id; END IF;

  INSERT INTO ledger.account (class, purpose, wallet_address)
  VALUES ('wallet', p_purpose, p_address)
  ON CONFLICT DO NOTHING
  RETURNING id INTO v_id;

  IF v_id IS NULL THEN
    SELECT id INTO v_id FROM ledger.account
     WHERE class = 'wallet' AND wallet_address = p_address AND purpose = p_purpose;
  END IF;
  RETURN v_id;
END $$;

CREATE OR REPLACE FUNCTION ledger.system_account(p_purpose ledger.account_purpose)
RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE v_id uuid;
BEGIN
  SELECT id INTO v_id FROM ledger.account WHERE class = 'system' AND purpose = p_purpose;
  IF v_id IS NOT NULL THEN RETURN v_id; END IF;
  INSERT INTO ledger.account (class, purpose) VALUES ('system', p_purpose)
  ON CONFLICT DO NOTHING RETURNING id INTO v_id;
  IF v_id IS NULL THEN
    SELECT id INTO v_id FROM ledger.account WHERE class = 'system' AND purpose = p_purpose;
  END IF;
  RETURN v_id;
END $$;

CREATE OR REPLACE FUNCTION ledger.cash_asset(p_code ledger.cash_code)
RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE v_id uuid;
BEGIN
  SELECT id INTO v_id FROM ledger.asset WHERE kind = 'cash' AND cash_code = p_code;
  IF v_id IS NOT NULL THEN RETURN v_id; END IF;
  INSERT INTO ledger.asset (kind, cash_code) VALUES ('cash', p_code)
  ON CONFLICT DO NOTHING RETURNING id INTO v_id;
  IF v_id IS NULL THEN
    SELECT id INTO v_id FROM ledger.asset WHERE kind = 'cash' AND cash_code = p_code;
  END IF;
  RETURN v_id;
END $$;

-- The payable's token asset. Created at issuance and never before: an asset
-- existing means the token exists, so there is no "issued but no asset" state.
CREATE OR REPLACE FUNCTION ledger.payable_asset(p_payable uuid)
RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE v_id uuid;
BEGIN
  SELECT id INTO v_id FROM ledger.asset WHERE kind = 'payable' AND payable_id = p_payable;
  RETURN v_id;
END $$;

-- ----------------------------------------------------------------------------
-- The lock-and-post primitive
-- ----------------------------------------------------------------------------
-- Every leg in the system goes through here, which is what makes the lock
-- ordering auditable by reading one function.
--
-- Step 1 creates any missing (account, asset) balance row at zero. A literal
-- zero always satisfies the non-negative CHECK, which is the whole reason this
-- design can debit a funded wallet at all: the mutation is later done by
-- `UPDATE balance = balance + delta` from the project_leg trigger, which
-- Postgres validates against the computed final row. The obvious-looking
-- alternative, `INSERT ... ON CONFLICT DO UPDATE SET balance = balance + delta`,
-- is broken for negative deltas: Postgres checks the raw candidate row (the
-- bare delta) before resolving the conflict, so any debit against a guarded
-- column fails even when the resulting balance would be valid.
--
-- Step 2 locks those rows in (account_id, asset_id) order. A total order over
-- the only rows two operations contend for is what makes deadlock impossible.
CREATE OR REPLACE FUNCTION ledger.post_legs(p_entry uuid, p_legs ledger.leg_spec[])
RETURNS void LANGUAGE plpgsql AS $$
DECLARE v_short RECORD;
BEGIN
  INSERT INTO ledger.account_balance (account_id, asset_id, class, balance)
  SELECT DISTINCT l.account_id, l.asset_id, a.class, 0
    FROM unnest(p_legs) AS l
    JOIN ledger.account a ON a.id = l.account_id
   ORDER BY 1, 2
  ON CONFLICT (account_id, asset_id) DO NOTHING;

  PERFORM 1 FROM ledger.account_balance b
   WHERE (b.account_id, b.asset_id) IN (SELECT l.account_id, l.asset_id FROM unnest(p_legs) l)
   ORDER BY b.account_id, b.asset_id
     FOR UPDATE;

  -- Under the locks just taken, the resulting balances are knowable, so a
  -- shortfall can be named precisely. The wallet_balance_non_negative CHECK
  -- would catch it either way, but one CHECK covers every asset, so a bare
  -- constraint violation cannot say whether a wallet ran out of dollars or ran
  -- out of payable. The caller has to tell a lender "you no longer have the
  -- funds" apart from "that is more than you hold", so the distinction is drawn
  -- here, where the asset kind is in hand. The CHECK stays as the backstop for
  -- anything that reaches the table by another route.
  SELECT a.wallet_address, s.kind, b.balance, d.delta
    INTO v_short
    FROM (SELECT account_id, asset_id, SUM(amount) AS delta
            FROM unnest(p_legs) GROUP BY 1, 2) d
    JOIN ledger.account_balance b ON b.account_id = d.account_id AND b.asset_id = d.asset_id
    JOIN ledger.account a ON a.id = d.account_id
    JOIN ledger.asset   s ON s.id = d.asset_id
   WHERE a.class = 'wallet' AND b.balance + d.delta < 0
   ORDER BY a.wallet_address
   LIMIT 1;
  IF FOUND THEN
    IF v_short.kind = 'cash' THEN
      RAISE EXCEPTION 'wallet % is short % of the funding asset',
        v_short.wallet_address, -(v_short.balance + v_short.delta)
        USING ERRCODE = 'ADA20';
    ELSE
      RAISE EXCEPTION 'wallet % holds % unlisted, needs %',
        v_short.wallet_address, v_short.balance, -v_short.delta
        USING ERRCODE = 'ADA21';
    END IF;
  END IF;

  -- Legs carrying the same (account, asset) are summed rather than inserted
  -- separately: a maturity settlement where one wallet holds two slices of the
  -- same payable would otherwise produce two legs that both project, which is
  -- correct but makes the entry harder to read on the receipt.
  INSERT INTO ledger.journal_leg (entry_id, leg_no, account_id, asset_id, amount)
  SELECT p_entry, row_number() OVER (ORDER BY account_id, asset_id),
         account_id, asset_id, SUM(amount)::bigint
    FROM unnest(p_legs)
   GROUP BY account_id, asset_id
  HAVING SUM(amount) <> 0;
END $$;

-- ----------------------------------------------------------------------------
-- Funding an XUSD obligation
-- ----------------------------------------------------------------------------
-- Prices and redemptions are XUSD (PRD §6). The payer chooses which of the
-- four cash assets to pay with (PRD §10), and the recipient is credited XUSD
-- whatever that choice was. This is the one place that decides what the
-- payer's side of such an entry looks like, so a trade and a redemption charge
-- the same asset the same way.
--
-- The rate applied comes back alongside the legs because PRD §10 requires the
-- receipt to state it, and a later world reset must not change what a receipt
-- says. The 1:1 assets record 1000000, a rate of exactly one, which is also
-- what lets one source formula serve all four.
DROP TYPE IF EXISTS ledger.payment CASCADE;
CREATE TYPE ledger.payment AS (
  funding_code        ledger.cash_code,
  legs                ledger.leg_spec[],
  source_amount_base  bigint,
  fx_rate_e6          bigint
);

CREATE OR REPLACE FUNCTION ledger.payer_legs(
  p_payer text, p_funding ledger.cash_code, p_xusd bigint, p_rate_e6 bigint)
RETURNS ledger.payment LANGUAGE plpgsql AS $$
DECLARE
  v_pay   ledger.payment;
  v_payer uuid := ledger.wallet_account(p_payer, 'wallet_free');
  v_xusd  uuid := ledger.cash_asset('XUSD');
  v_fx    uuid;
  v_fund  uuid;
BEGIN
  v_pay.funding_code       := p_funding;
  v_pay.fx_rate_e6         := CASE WHEN p_funding = 'XSGD' THEN p_rate_e6 ELSE 1000000 END;
  v_pay.source_amount_base := (p_xusd * v_pay.fx_rate_e6 + 500000) / 1000000;
  IF p_funding = 'XUSD' THEN
    v_pay.legs := ARRAY[ROW(v_payer, v_xusd, -p_xusd)::ledger.leg_spec];
  ELSE
    v_fx   := ledger.system_account('system_fx');
    v_fund := ledger.cash_asset(p_funding);
    v_pay.legs := ARRAY[
      ROW(v_payer, v_fund, -v_pay.source_amount_base)::ledger.leg_spec,
      ROW(v_fx, v_fund, v_pay.source_amount_base)::ledger.leg_spec,
      ROW(v_fx, v_xusd, -p_xusd)::ledger.leg_spec
    ];
  END IF;
  RETURN v_pay;
END $$;

-- ----------------------------------------------------------------------------
-- Rendering an entry back to the caller
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION ledger.render_entry(p_entry ledger.journal_entry)
RETURNS jsonb LANGUAGE sql STABLE AS $$
  SELECT jsonb_build_object(
    'entryId',   p_entry.id,
    'seq',       p_entry.seq,
    'kind',      p_entry.kind,
    'worldDate', p_entry.world_date,
    'replayed',  false,
    'receipt', CASE WHEN p_entry.chain_tx_hash IS NULL THEN NULL ELSE jsonb_build_object(
      'txHash',      p_entry.chain_tx_hash,
      'blockNumber', p_entry.chain_block_number,
      'status',      p_entry.chain_status,
      'simulated',   true
    ) END,
    'conversion', CASE WHEN p_entry.funding_code IS NULL THEN NULL ELSE jsonb_build_object(
      'fundingAsset', p_entry.funding_code,
      'sourceDebit',  p_entry.source_amount_base::text,
      'rateE6',       p_entry.fx_rate_e6::text
    ) END,
    'legs', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
               'account', a.purpose, 'wallet', a.wallet_address,
               'asset', COALESCE(ast.cash_code::text, 'TOKEN'),
               'amount', l.amount::text) ORDER BY l.leg_no)
        FROM ledger.journal_leg l
        JOIN ledger.account a ON a.id = l.account_id
        JOIN ledger.asset ast ON ast.id = l.asset_id
       WHERE l.entry_id = p_entry.id), '[]'::jsonb)
  );
$$;

-- ----------------------------------------------------------------------------
-- Marketplace eligibility
-- ----------------------------------------------------------------------------
-- PRD §9: "Only institutional lender accounts can bid or buy." The UI says so
-- on the bid panel, but a rule that only the UI knows is not a rule: it holds
-- for people who use the screens and for nobody else. Eligibility belongs to
-- the account, and a wallet belongs to an organisation, so a wallet is eligible
-- when any live account on it is.
CREATE OR REPLACE FUNCTION ledger.wallet_is_institutional(p_wallet text)
RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1 FROM app.wallet w
      JOIN app.app_user u ON u.entity_id = w.entity_id
     WHERE w.address = p_wallet
       AND u.deactivated_at IS NULL
       AND u.institutional_eligible);
$$;

-- ----------------------------------------------------------------------------
-- ledger.post
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION ledger.post(p_command jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_key         uuid  := (p_command->>'idempotencyKey')::uuid;
  v_intent      jsonb := p_command->'intent';
  v_fingerprint bytea := digest(v_intent::text, 'sha256');
  v_actor       uuid  := (p_command->>'actorUserId')::uuid;
  v_kind        text  := v_intent->>'kind';
  v_entry       ledger.journal_entry;
  v_entry_kind  ledger.entry_kind;
  v_world       app.world;
  v_legs        ledger.leg_spec[] := ARRAY[]::ledger.leg_spec[];

  v_payable     app.payable;
  v_listing     app.listing;
  v_bid         app.bid;
  v_asset       uuid;
  v_cash        uuid;
  v_qty         bigint;
  v_price       bigint;
  v_funding     ledger.cash_code;
  v_payment     ledger.payment;
  v_holder      RECORD;
  v_shares      bigint[];
  v_holders     RECORD;
  v_i           int;
  v_total_qty   bigint;
  v_days        int;
  v_anchor_wallet text;
  v_series      app.series;
  v_leg         RECORD;
  v_erp         app.erp_invoice;
  v_supplier_id uuid;
  v_invoice_ref text;
  v_entity      app.entity;
  v_limit       bigint;
  v_outstanding bigint;
  v_user        app.app_user;
  v_role        app.user_role;
  v_name        text;
BEGIN
  IF v_key IS NULL THEN
    RAISE EXCEPTION 'every command needs an idempotencyKey' USING ERRCODE = 'ADA17';
  END IF;

  SELECT * INTO v_world FROM app.world WHERE only_row;

  -- Map the intent verb onto the stored entry kind. Verbs are what a caller
  -- asks for; kinds are what the journal records.
  v_entry_kind := CASE v_kind
    WHEN 'issue_payable'  THEN 'issuance'
    WHEN 'accept_receipt' THEN 'receipt_accepted'
    WHEN 'reject_receipt' THEN 'receipt_rejected'
    WHEN 'top_up'         THEN 'top_up'
    WHEN 'transfer'       THEN 'transfer'
    WHEN 'publish_listing' THEN 'listing_published'
    WHEN 'cancel_listing' THEN 'listing_cancelled'
    WHEN 'place_bid'      THEN 'bid_placed'
    WHEN 'withdraw_bid'   THEN 'bid_withdrawn'
    WHEN 'accept_bid'     THEN 'trade_settlement'
    WHEN 'buy_now'        THEN 'trade_settlement'
    WHEN 'settle_maturity' THEN 'redemption'
    WHEN 'advance_clock'  THEN 'clock_advanced'
    WHEN 'reset_world'    THEN 'world_reset'
    WHEN 'create_payable' THEN 'payable_created'
    WHEN 'submit'         THEN 'submitted_for_approval'
    WHEN 'approve'        THEN 'approved'
    WHEN 'certify'        THEN 'certified'
    WHEN 'grade'          THEN 'graded'
    WHEN 'onboard_entity' THEN 'entity_onboarded'
    WHEN 'create_user'    THEN 'user_created'
    WHEN 'remove_user'    THEN 'user_removed'
    WHEN 'set_programme_limit' THEN 'programme_limit_set'
    WHEN 'set_certification'   THEN 'issuer_certification_changed'
    ELSE NULL END;

  IF v_entry_kind IS NULL THEN
    RAISE EXCEPTION 'unknown intent kind %', v_kind USING ERRCODE = 'ADA18';
  END IF;

  -- 1. IDEMPOTENCY GATE ------------------------------------------------------
  INSERT INTO ledger.journal_entry
    (kind, idempotency_key, request_fingerprint, actor_user_id,
     world_date, world_epoch, payable_id, series_id, payload)
  VALUES
    (v_entry_kind, v_key, v_fingerprint, v_actor,
     v_world.t0 + v_world.offset_days, v_world.epoch,
     (v_intent->>'payableId')::uuid, (v_intent->>'seriesId')::uuid, v_intent)
  ON CONFLICT (idempotency_key) DO NOTHING
  RETURNING * INTO v_entry;

  IF v_entry.id IS NULL THEN
    SELECT * INTO v_entry FROM ledger.journal_entry WHERE idempotency_key = v_key;
    IF v_entry.request_fingerprint <> v_fingerprint THEN
      RAISE EXCEPTION 'idempotency key reused with a different intent'
        USING ERRCODE = 'ADA10';
    END IF;
    RETURN ledger.render_entry(v_entry) || jsonb_build_object('replayed', true);
  END IF;

  -- 2-6. PER-INTENT ----------------------------------------------------------
  IF v_kind = 'issue_payable' THEN
    SELECT * INTO v_payable FROM app.payable WHERE id = (v_intent->>'payableId')::uuid FOR NO KEY UPDATE;
    IF v_payable.lifecycle_status <> 'certified' THEN
      RAISE EXCEPTION 'payable % is % and must be certified before issuance',
        v_payable.ref, v_payable.lifecycle_status USING ERRCODE = 'ADA15';
    END IF;

    -- PRD §8 screen 14 and §5: StraitsX certifies the issuer and sets its
    -- programme limit. Both are checked here, at the only point where face
    -- enters the world, rather than on the screen that displays them. A limit
    -- that nothing enforces is a number, not a limit.
    --
    -- Locked, because two issuances racing each other could otherwise both
    -- read the same headroom and both fit inside it.
    SELECT * INTO v_entity FROM app.entity WHERE id = v_payable.anchor_id FOR UPDATE;
    IF v_entity.certification_status <> 'certified' THEN
      RAISE EXCEPTION '% is % and cannot issue under this programme',
        v_entity.name, v_entity.certification_status USING ERRCODE = 'ADA32';
    END IF;

    IF v_entity.programme_limit_base IS NOT NULL THEN
      -- Outstanding, not cumulative: redemption returns face to the unissued
      -- account and frees the headroom again, which is what the certification
      -- screen already calls "currently outstanding" and "headroom".
      SELECT COALESCE(SUM(sup.outstanding_base), 0)::bigint INTO v_outstanding
        FROM app.payable p
        JOIN ledger.v_payable_supply sup ON sup.payable_id = p.id
       WHERE p.anchor_id = v_entity.id;
      IF v_outstanding + v_payable.face_base > v_entity.programme_limit_base THEN
        RAISE EXCEPTION
          'issuing % would take % to % outstanding, over its % programme limit',
          v_payable.ref, v_entity.name,
          v_outstanding + v_payable.face_base, v_entity.programme_limit_base
          USING ERRCODE = 'ADA33';
      END IF;
    END IF;

    INSERT INTO ledger.asset (kind, payable_id, token_id)
    VALUES ('payable', v_payable.id, (v_intent->>'tokenId')::numeric)
    ON CONFLICT DO NOTHING;
    v_asset := ledger.payable_asset(v_payable.id);

    v_legs := ARRAY[
      ROW(ledger.system_account('system_unissued'), v_asset, -v_payable.face_base)::ledger.leg_spec,
      ROW(ledger.wallet_account(v_intent->>'toWallet', 'wallet_free'), v_asset, v_payable.face_base)::ledger.leg_spec
    ];
    UPDATE app.payable
       SET lifecycle_status = 'issued',
           issue_date = v_world.t0 + v_world.offset_days,
           receipt_status = 'pending'
     WHERE id = v_payable.id;

  ELSIF v_kind = 'top_up' THEN
    v_cash := ledger.cash_asset((v_intent->>'cashCode')::ledger.cash_code);
    v_qty  := (v_intent->>'amountBase')::bigint;
    IF v_qty <= 0 THEN
      RAISE EXCEPTION 'a top-up must be positive' USING ERRCODE = 'ADA19';
    END IF;
    v_legs := ARRAY[
      ROW(ledger.system_account('system_mint'), v_cash, -v_qty)::ledger.leg_spec,
      ROW(ledger.wallet_account(v_intent->>'wallet', 'wallet_free'), v_cash, v_qty)::ledger.leg_spec
    ];

  ELSIF v_kind = 'transfer' THEN
    SELECT * INTO v_payable FROM app.payable WHERE id = (v_intent->>'payableId')::uuid FOR NO KEY UPDATE;
    v_asset := ledger.payable_asset(v_payable.id);
    v_qty   := (v_intent->>'quantityBase')::bigint;
    IF v_qty <= 0 THEN
      RAISE EXCEPTION 'a transfer must be positive' USING ERRCODE = 'ADA19';
    END IF;
    IF (v_world.t0 + v_world.offset_days) >= v_payable.maturity_date THEN
      RAISE EXCEPTION 'payable % has reached maturity', v_payable.ref USING ERRCODE = 'ADA12';
    END IF;
    IF v_payable.receipt_status = 'pending' THEN
      RAISE EXCEPTION 'payable % has not been accepted by its supplier yet', v_payable.ref
        USING ERRCODE = 'ADA15';
    END IF;
    v_legs := ARRAY[
      ROW(ledger.wallet_account(v_intent->>'fromWallet', 'wallet_free'), v_asset, -v_qty)::ledger.leg_spec,
      ROW(ledger.wallet_account(v_intent->>'toWallet', 'wallet_free'), v_asset, v_qty)::ledger.leg_spec
    ];

  ELSIF v_kind = 'publish_listing' THEN
    -- A series listing and a payable listing differ only in how many legs they
    -- carry. Building both from the same loop is what keeps the escrow
    -- invariant one equality instead of two cases.
    IF v_intent ? 'seriesId' THEN
      SELECT * INTO v_series FROM app.series WHERE id = (v_intent->>'seriesId')::uuid FOR NO KEY UPDATE;
      IF (v_world.t0 + v_world.offset_days) >= v_series.maturity_date THEN
        RAISE EXCEPTION 'series % has reached maturity', v_series.ref USING ERRCODE = 'ADA12';
      END IF;
      INSERT INTO app.listing (id, target_kind, target_series_id, seller_wallet,
                               min_price_base, buy_now_price_base, status)
      VALUES (COALESCE((v_intent->>'listingId')::uuid, gen_random_uuid()), 'series', v_series.id,
              v_intent->>'sellerWallet', (v_intent->>'minPriceBase')::bigint,
              (v_intent->>'buyNowPriceBase')::bigint, 'open')
      RETURNING * INTO v_listing;

      -- PRD section 6: a series moves as one lot of wholly held members, so
      -- each leg is that member's entire free balance, and a member the seller
      -- only partly holds makes the whole listing illegal.
      FOR v_holder IN
        SELECT p.id AS payable_id, p.face_base FROM app.payable p
         WHERE p.series_id = v_series.id ORDER BY p.id
      LOOP
        v_asset := ledger.payable_asset(v_holder.payable_id);
        SELECT COALESCE(b.balance, 0) INTO v_qty
          FROM ledger.account_balance b
          JOIN ledger.account a ON a.id = b.account_id
         WHERE a.wallet_address = v_intent->>'sellerWallet'
           AND a.purpose = 'wallet_free' AND b.asset_id = v_asset;
        IF v_qty <> v_holder.face_base THEN
          RAISE EXCEPTION 'series member is not wholly held by the seller (holds %, face %)',
            v_qty, v_holder.face_base USING ERRCODE = 'ADA14';
        END IF;
        INSERT INTO app.listing_leg (listing_id, asset_id, quantity_base)
        VALUES (v_listing.id, v_asset, v_qty);
        v_legs := v_legs || ARRAY[
          ROW(ledger.wallet_account(v_listing.seller_wallet, 'wallet_free'), v_asset, -v_qty)::ledger.leg_spec,
          ROW(ledger.wallet_account(v_listing.seller_wallet, 'wallet_listed'), v_asset, v_qty)::ledger.leg_spec
        ];
      END LOOP;
    ELSE
      SELECT * INTO v_payable FROM app.payable WHERE id = (v_intent->>'payableId')::uuid FOR NO KEY UPDATE;
      v_asset := ledger.payable_asset(v_payable.id);
      v_qty   := (v_intent->>'quantityBase')::bigint;
      IF v_qty <= 0 THEN
        RAISE EXCEPTION 'a listing must be positive' USING ERRCODE = 'ADA19';
      END IF;
      IF (v_world.t0 + v_world.offset_days) >= v_payable.maturity_date THEN
        RAISE EXCEPTION 'payable % has reached maturity', v_payable.ref USING ERRCODE = 'ADA12';
      END IF;
      -- PRD §8 screen 15's "only certified, graded payables can be listed" needs
      -- no check here, and adding one would be a second opinion that can
      -- disagree. A listing escrows a free balance of the payable token; that
      -- balance exists only after issuance; issuance above refuses anything not
      -- 'certified'; and the graded_before_certified constraint in §5 of the
      -- schema means a payable past 'approved' always carries a grade.
      --
      -- PRD §8 screen 6 presents an inbox: a payable the supplier has not yet
      -- accepted is visible but not yet actionable.
      IF v_payable.receipt_status = 'pending' THEN
        RAISE EXCEPTION 'payable % has not been accepted by its supplier yet', v_payable.ref
          USING ERRCODE = 'ADA15';
      END IF;
      INSERT INTO app.listing (id, target_kind, target_payable_id, seller_wallet,
                               min_price_base, buy_now_price_base, status)
      VALUES (COALESCE((v_intent->>'listingId')::uuid, gen_random_uuid()), 'payable', v_payable.id,
              v_intent->>'sellerWallet', (v_intent->>'minPriceBase')::bigint,
              (v_intent->>'buyNowPriceBase')::bigint, 'open')
      RETURNING * INTO v_listing;
      INSERT INTO app.listing_leg (listing_id, asset_id, quantity_base)
      VALUES (v_listing.id, v_asset, v_qty);
      v_legs := ARRAY[
        ROW(ledger.wallet_account(v_listing.seller_wallet, 'wallet_free'), v_asset, -v_qty)::ledger.leg_spec,
        ROW(ledger.wallet_account(v_listing.seller_wallet, 'wallet_listed'), v_asset, v_qty)::ledger.leg_spec
      ];
    END IF;

  ELSIF v_kind = 'cancel_listing' THEN
    SELECT * INTO v_listing FROM app.listing WHERE id = (v_intent->>'listingId')::uuid FOR UPDATE;
    IF v_listing.status <> 'open' THEN
      RAISE EXCEPTION 'listing is %', v_listing.status USING ERRCODE = 'ADA11';
    END IF;
    UPDATE app.listing SET status = 'cancelled' WHERE id = v_listing.id;
    UPDATE app.bid SET status = 'superseded' WHERE listing_id = v_listing.id AND status = 'placed';
    FOR v_leg IN
      SELECT asset_id, quantity_base FROM app.listing_leg
       WHERE listing_id = v_listing.id ORDER BY asset_id
    LOOP
      v_legs := v_legs || ARRAY[
        ROW(ledger.wallet_account(v_listing.seller_wallet, 'wallet_listed'), v_leg.asset_id, -v_leg.quantity_base)::ledger.leg_spec,
        ROW(ledger.wallet_account(v_listing.seller_wallet, 'wallet_free'), v_leg.asset_id, v_leg.quantity_base)::ledger.leg_spec
      ];
    END LOOP;

  ELSIF v_kind = 'place_bid' THEN
    SELECT * INTO v_listing FROM app.listing WHERE id = (v_intent->>'listingId')::uuid FOR UPDATE;
    IF v_listing.status <> 'open' THEN
      RAISE EXCEPTION 'listing is %', v_listing.status USING ERRCODE = 'ADA11';
    END IF;
    IF NOT ledger.wallet_is_institutional(v_intent->>'bidderWallet') THEN
      RAISE EXCEPTION 'only institutional lender accounts can bid' USING ERRCODE = 'ADA34';
    END IF;
    -- PRD §9: bids do not reserve funds. Nothing is locked and no leg is
    -- posted; the balance is rechecked when the seller accepts.
    INSERT INTO app.bid (id, listing_id, bidder_wallet, price_base, funding_code, status)
    VALUES (COALESCE((v_intent->>'bidId')::uuid, gen_random_uuid()), v_listing.id,
            v_intent->>'bidderWallet', (v_intent->>'priceBase')::bigint,
            (v_intent->>'fundingCode')::ledger.cash_code, 'placed')
    RETURNING * INTO v_bid;

  ELSIF v_kind = 'withdraw_bid' THEN
    UPDATE app.bid SET status = 'withdrawn'
     WHERE id = (v_intent->>'bidId')::uuid AND status = 'placed';

  ELSIF v_kind IN ('accept_bid', 'buy_now') THEN
    -- One settlement path for both. Buy-now is an acceptance the buyer performs
    -- against a price the seller published in advance, so the only difference
    -- is who initiates it and where the price comes from. Giving it its own
    -- branch would mean two places that move money, which is exactly what this
    -- design exists to avoid.
    --
    -- Lock by primary key only. See the header note on EvalPlanQual.
    SELECT * INTO v_listing FROM app.listing WHERE id = (v_intent->>'listingId')::uuid FOR UPDATE;
    IF v_listing.id IS NULL THEN
      RAISE EXCEPTION 'no such listing' USING ERRCODE = 'ADA11';
    END IF;
    IF v_listing.status <> 'open' THEN
      RAISE EXCEPTION 'listing is %', v_listing.status USING ERRCODE = 'ADA11';
    END IF;

    IF v_kind = 'buy_now' THEN
      IF v_listing.buy_now_price_base IS NULL THEN
        RAISE EXCEPTION 'this listing has no buy-now price' USING ERRCODE = 'ADA11';
      END IF;
      -- The buyer's own bid, created and accepted in the same operation, so the
      -- trade has the same shape in the journal as any other and the portfolio
      -- gets its cost basis from the same place.
      INSERT INTO app.bid (listing_id, bidder_wallet, price_base, funding_code, status)
      VALUES (v_listing.id, v_intent->>'buyerWallet', v_listing.buy_now_price_base,
              (v_intent->>'fundingCode')::ledger.cash_code, 'placed')
      RETURNING * INTO v_bid;
    ELSE
      SELECT * INTO v_bid FROM app.bid WHERE id = (v_intent->>'bidId')::uuid FOR UPDATE;
      IF v_bid.status <> 'placed' THEN
        RAISE EXCEPTION 'bid is %', v_bid.status USING ERRCODE = 'ADA11';
      END IF;
    END IF;

    -- A seller cannot be the buyer. Without this the trade nets to nothing but
    -- still marks the listing filled, which would quietly retire a lot that
    -- never changed hands.
    IF v_bid.bidder_wallet = v_listing.seller_wallet THEN
      RAISE EXCEPTION 'a seller cannot buy their own listing' USING ERRCODE = 'ADA11';
    END IF;

    -- Rechecked here as well as at place_bid, because this is where the
    -- quantity actually moves and because eligibility can be removed between
    -- the two: the account that placed the bid may have been removed since.
    IF NOT ledger.wallet_is_institutional(v_bid.bidder_wallet) THEN
      RAISE EXCEPTION 'only institutional lender accounts can buy' USING ERRCODE = 'ADA34';
    END IF;

    -- Maturity closes the market whichever kind of lot this is.
    IF v_listing.target_kind = 'series' THEN
      SELECT * INTO v_series FROM app.series WHERE id = v_listing.target_series_id FOR NO KEY UPDATE;
      IF (v_world.t0 + v_world.offset_days) >= v_series.maturity_date THEN
        RAISE EXCEPTION 'series % has reached maturity', v_series.ref USING ERRCODE = 'ADA12';
      END IF;
    ELSE
      SELECT * INTO v_payable FROM app.payable WHERE id = v_listing.target_payable_id FOR NO KEY UPDATE;
      IF (v_world.t0 + v_world.offset_days) >= v_payable.maturity_date THEN
        RAISE EXCEPTION 'payable % has reached maturity', v_payable.ref USING ERRCODE = 'ADA12';
      END IF;
    END IF;

    v_price := v_bid.price_base;
    v_cash  := ledger.cash_asset('XUSD');

    v_payment := ledger.payer_legs(v_bid.bidder_wallet, v_bid.funding_code, v_price, v_world.xsgd_per_xusd_e6);
    v_legs := v_payment.legs || ARRAY[
      ROW(ledger.wallet_account(v_listing.seller_wallet, 'wallet_free'), v_cash, v_price)::ledger.leg_spec
    ];

    -- The traded quantity leaves escrow, not the seller's free balance. One
    -- leg per listing leg, so a series moves as one lot by construction.
    FOR v_leg IN
      SELECT asset_id, quantity_base FROM app.listing_leg
       WHERE listing_id = v_listing.id ORDER BY asset_id
    LOOP
      v_legs := v_legs || ARRAY[
        ROW(ledger.wallet_account(v_listing.seller_wallet, 'wallet_listed'), v_leg.asset_id, -v_leg.quantity_base)::ledger.leg_spec,
        ROW(ledger.wallet_account(v_bid.bidder_wallet, 'wallet_free'), v_leg.asset_id, v_leg.quantity_base)::ledger.leg_spec
      ];
    END LOOP;

    UPDATE app.listing SET status = 'filled' WHERE id = v_listing.id;
    UPDATE app.bid SET status = 'accepted' WHERE id = v_bid.id;
    UPDATE app.bid SET status = 'superseded'
     WHERE listing_id = v_listing.id AND id <> v_bid.id AND status = 'placed';

  ELSIF v_kind = 'settle_maturity' THEN
    -- PRD §3 q13: redemption is denominated in XUSD and the asset is chosen
    -- only for payment. The screen always chooses one, so a command without
    -- one is malformed rather than defaulted.
    v_funding := (v_intent->>'fundingCode')::ledger.cash_code;
    IF v_funding IS NULL THEN
      RAISE EXCEPTION 'settle_maturity needs a fundingCode naming the asset the anchor pays from'
        USING ERRCODE = 'ADA17';
    END IF;
    SELECT * INTO v_payable FROM app.payable WHERE id = (v_intent->>'payableId')::uuid FOR NO KEY UPDATE;
    IF v_payable.lifecycle_status = 'settled' THEN
      RAISE EXCEPTION 'payable % is already settled', v_payable.ref USING ERRCODE = 'ADA16';
    END IF;
    IF (v_world.t0 + v_world.offset_days) < v_payable.maturity_date THEN
      RAISE EXCEPTION 'payable % has not matured', v_payable.ref USING ERRCODE = 'ADA12';
    END IF;
    v_asset := ledger.payable_asset(v_payable.id);
    v_cash  := ledger.cash_asset('XUSD');
    -- The anchor obligor funds redemption from its own wallet.
    SELECT address INTO v_anchor_wallet FROM app.wallet WHERE entity_id = v_payable.anchor_id LIMIT 1;
    IF v_anchor_wallet IS NULL THEN
      RAISE EXCEPTION 'anchor for % has no wallet', v_payable.ref USING ERRCODE = 'ADA15';
    END IF;

    -- Maturity expires any listing still open, returning escrow to free so the
    -- holder's whole position redeems in one place.
    FOR v_listing IN
      SELECT li.* FROM app.listing li
       WHERE li.status = 'open'
         AND EXISTS (SELECT 1 FROM app.listing_leg ll
                      WHERE ll.listing_id = li.id AND ll.asset_id = v_asset)
       ORDER BY li.id FOR UPDATE
    LOOP
      UPDATE app.listing SET status = 'cancelled' WHERE id = v_listing.id;
      UPDATE app.bid SET status = 'superseded' WHERE listing_id = v_listing.id AND status = 'placed';
      FOR v_leg IN
        SELECT asset_id, quantity_base FROM app.listing_leg
         WHERE listing_id = v_listing.id AND asset_id = v_asset ORDER BY asset_id
      LOOP
        v_legs := v_legs || ARRAY[
          ROW(ledger.wallet_account(v_listing.seller_wallet, 'wallet_listed'), v_leg.asset_id, -v_leg.quantity_base)::ledger.leg_spec,
          ROW(ledger.wallet_account(v_listing.seller_wallet, 'wallet_free'), v_leg.asset_id, v_leg.quantity_base)::ledger.leg_spec
        ];
      END LOOP;
    END LOOP;

    -- Because face and quantity are the same number of base units, each
    -- holder's credit IS their quantity, and no pro-rata rounding is possible.
    v_total_qty := 0;
    FOR v_holder IN
      SELECT a.wallet_address, SUM(b.balance)::bigint AS qty
        FROM ledger.account_balance b
        JOIN ledger.account a ON a.id = b.account_id
       WHERE b.asset_id = v_asset AND a.class = 'wallet' AND b.balance > 0
       GROUP BY a.wallet_address
       ORDER BY a.wallet_address
    LOOP
      v_total_qty := v_total_qty + v_holder.qty;
      v_legs := v_legs || ARRAY[
        ROW(ledger.wallet_account(v_holder.wallet_address, 'wallet_free'), v_asset, -v_holder.qty)::ledger.leg_spec,
        ROW(ledger.system_account('system_unissued'), v_asset, v_holder.qty)::ledger.leg_spec,
        ROW(ledger.wallet_account(v_holder.wallet_address, 'wallet_free'), v_cash, v_holder.qty)::ledger.leg_spec
      ];
    END LOOP;

    -- The total is converted rather than each holder's share, so rounding
    -- happens once and the XSGD debit is what the whole obligation costs, not
    -- the sum of N rounded parts.
    v_payment := ledger.payer_legs(v_anchor_wallet, v_funding, v_total_qty, v_world.xsgd_per_xusd_e6);
    v_legs := v_legs || v_payment.legs;

    UPDATE app.payable SET lifecycle_status = 'settled' WHERE id = v_payable.id;

  ELSIF v_kind = 'advance_clock' THEN
    v_days := (v_intent->>'days')::int;
    IF v_days < 0 THEN
      RAISE EXCEPTION 'the demo clock only moves forward' USING ERRCODE = 'ADA19';
    END IF;
    UPDATE app.world SET offset_days = offset_days + v_days WHERE only_row;

  ELSIF v_kind IN ('accept_receipt', 'reject_receipt') THEN
    SELECT * INTO v_payable FROM app.payable WHERE id = (v_intent->>'payableId')::uuid FOR NO KEY UPDATE;
    IF v_payable.receipt_status <> 'pending' THEN
      RAISE EXCEPTION 'payable % was already %', v_payable.ref, v_payable.receipt_status
        USING ERRCODE = 'ADA15';
    END IF;
    v_asset := ledger.payable_asset(v_payable.id);

    IF v_kind = 'accept_receipt' THEN
      UPDATE app.payable SET receipt_status = 'accepted' WHERE id = v_payable.id;
    ELSE
      -- Return the whole quantity to the anchor. The obligation still exists
      -- and still matures; it is simply held by ADATA rather than the supplier.
      SELECT address INTO v_anchor_wallet FROM app.wallet WHERE entity_id = v_payable.anchor_id LIMIT 1;
      SELECT COALESCE(b.balance, 0) INTO v_qty
        FROM ledger.account_balance b
        JOIN ledger.account a ON a.id = b.account_id
       WHERE a.wallet_address = v_intent->>'holderWallet'
         AND a.purpose = 'wallet_free' AND b.asset_id = v_asset;
      UPDATE app.payable SET receipt_status = 'rejected' WHERE id = v_payable.id;
      v_legs := ARRAY[
        ROW(ledger.wallet_account(v_intent->>'holderWallet', 'wallet_free'), v_asset, -v_qty)::ledger.leg_spec,
        ROW(ledger.wallet_account(v_anchor_wallet, 'wallet_free'), v_asset, v_qty)::ledger.leg_spec
      ];
    END IF;

  ELSIF v_kind = 'create_payable' THEN
    -- PRD section 8 screen 2 offers two ways in: import from the ERP mock, or
    -- type the invoice by hand. Both land here, in one branch producing one
    -- row and one audit event, because the difference is only where the four
    -- facts come from. An ERP import additionally consumes the invoice so the
    -- picker can grey it out; manual entry has nothing to consume.
    IF v_intent ? 'erpInvoiceId' THEN
      SELECT * INTO v_erp FROM app.erp_invoice WHERE id = (v_intent->>'erpInvoiceId')::uuid FOR UPDATE;
      IF v_erp.id IS NULL THEN
        RAISE EXCEPTION 'no such ERP invoice' USING ERRCODE = 'ADA15';
      END IF;
      IF v_erp.consumed_by IS NOT NULL THEN
        RAISE EXCEPTION 'invoice % has already been issued as a payable', v_erp.doc_no
          USING ERRCODE = 'ADA15';
      END IF;
      v_supplier_id := v_erp.supplier_id;
      v_invoice_ref := v_erp.invoice_ref;
      v_qty         := v_erp.amount_base;
      v_days        := v_erp.terms_days;
    ELSE
      v_supplier_id := (v_intent->>'supplierId')::uuid;
      v_invoice_ref := btrim(COALESCE(v_intent->>'invoiceRef', ''));
      v_qty         := (v_intent->>'faceBase')::bigint;
      v_days        := (v_intent->>'termsDays')::int;

      PERFORM 1 FROM app.entity
       WHERE id = v_supplier_id AND entity_type = 'supplier';
      IF NOT FOUND THEN
        RAISE EXCEPTION 'no such supplier' USING ERRCODE = 'ADA24';
      END IF;
      -- A payable issues to its supplier's wallet and then waits for that
      -- supplier to accept delivery (PRD §3 q7). A supplier with no live
      -- account can never do that, so the payable would strand at issuance.
      -- The ERP path cannot reach this: its register only names onboarded
      -- suppliers. Manual entry can, which is why the check lives here.
      PERFORM 1 FROM app.app_user
       WHERE entity_id = v_supplier_id AND deactivated_at IS NULL;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'no account exists for this supplier yet' USING ERRCODE = 'ADA31';
      END IF;
      IF v_invoice_ref = '' THEN
        RAISE EXCEPTION 'an invoice reference is required' USING ERRCODE = 'ADA25';
      END IF;
      IF v_qty IS NULL OR v_qty <= 0 THEN
        RAISE EXCEPTION 'the face value must be greater than zero' USING ERRCODE = 'ADA19';
      END IF;
      -- The schema's maturity_after_issue check cannot help here: a draft has
      -- no issue date yet, so a zero-day term would pass it and only fail much
      -- later, at issuance, with a confusing message.
      IF v_days IS NULL OR v_days < 1 OR v_days > 365 THEN
        RAISE EXCEPTION 'payment terms must be between 1 and 365 days' USING ERRCODE = 'ADA23';
      END IF;
    END IF;

    BEGIN
      INSERT INTO app.payable (id, ref, anchor_id, original_supplier_id, invoice_ref,
                               face_base, maturity_date, lifecycle_status)
      VALUES (COALESCE((v_intent->>'payableId')::uuid, gen_random_uuid()),
              v_intent->>'ref',
              (SELECT id FROM app.entity WHERE entity_type = 'anchor' ORDER BY name LIMIT 1),
              v_supplier_id, v_invoice_ref, v_qty,
              (v_world.t0 + v_world.offset_days) + v_days,
              'draft')
      RETURNING * INTO v_payable;
    EXCEPTION WHEN unique_violation THEN
      -- One index guards the reference, another guards the invoice. Saying
      -- which one was hit is the difference between a preparer fixing a typo
      -- and a preparer wondering what the system means.
      IF SQLERRM LIKE '%payable_one_per_invoice%' THEN
        RAISE EXCEPTION 'invoice % has already been financed for this supplier', v_invoice_ref
          USING ERRCODE = 'ADA22';
      END IF;
      RAISE EXCEPTION 'reference % is already in use', v_intent->>'ref' USING ERRCODE = 'ADA26';
    END;

    IF v_erp.id IS NOT NULL THEN
      UPDATE app.erp_invoice SET consumed_by = v_payable.id WHERE id = v_erp.id;
    END IF;
    UPDATE ledger.journal_entry SET payable_id = v_payable.id WHERE id = v_entry.id;

  ELSIF v_kind IN ('onboard_entity', 'create_user') THEN
    -- PRD §5 and §8 screen 5. Onboarding a counterparty and adding a user to
    -- one are the same act at different depths: onboarding creates the
    -- organisation, its custodial wallet and its first user; create_user adds
    -- another user to an organisation that already exists. Sharing the branch
    -- keeps one set of role rules rather than two that drift.
    v_name := btrim(COALESCE(v_intent->>'userName', ''));
    IF v_name = '' THEN
      RAISE EXCEPTION 'a user name is required' USING ERRCODE = 'ADA28';
    END IF;

    IF v_kind = 'onboard_entity' THEN
      IF btrim(COALESCE(v_intent->>'name', '')) = '' THEN
        RAISE EXCEPTION 'an organisation name is required' USING ERRCODE = 'ADA28';
      END IF;
      IF (v_intent->>'entityType') NOT IN ('supplier', 'lender') THEN
        -- The anchor and the platform are fixtures of this programme, not
        -- things a visitor onboards. PRD §5 names exactly one of each.
        RAISE EXCEPTION 'only a supplier or a lender can be onboarded here'
          USING ERRCODE = 'ADA29';
      END IF;

      BEGIN
        INSERT INTO app.entity (name, entity_type, certification_status)
        VALUES (btrim(v_intent->>'name'), (v_intent->>'entityType')::app.entity_type,
                -- PRD §8 screen 5: "Mark the account KYC verified on submit."
                -- No document upload; certification here is the demo's stand-in.
                'certified')
        RETURNING * INTO v_entity;
      EXCEPTION WHEN unique_violation THEN
        RAISE EXCEPTION 'an organisation called % is already on the platform',
          btrim(v_intent->>'name') USING ERRCODE = 'ADA27';
      END;

      -- Custodial wallet. PRD §8 screen 5 is explicit that no external wallet
      -- is connected, so the platform mints one in the same shape as every
      -- seeded address: 0x and 40 hex characters.
      INSERT INTO app.wallet (address, entity_id)
      VALUES ('0x' || encode(gen_random_bytes(20), 'hex'), v_entity.id);
    ELSE
      SELECT * INTO v_entity FROM app.entity WHERE id = (v_intent->>'entityId')::uuid;
      IF v_entity.id IS NULL THEN
        RAISE EXCEPTION 'no such organisation' USING ERRCODE = 'ADA24';
      END IF;
    END IF;

    v_role := (v_intent->>'role')::app.user_role;
    -- A persona is a role inside an organisation, and the two have to agree.
    -- Without this a "lender" could be created inside a supplier company and
    -- would see a marketplace they cannot trade in, holding that company's
    -- wallet. The database refuses rather than the form remembering.
    IF NOT (
      (v_entity.entity_type = 'supplier' AND v_role = 'supplier')
      OR (v_entity.entity_type = 'lender' AND v_role = 'lender')
      OR (v_entity.entity_type = 'anchor' AND v_role IN ('adata_preparer', 'adata_checker'))
      OR (v_entity.entity_type = 'platform' AND v_role = 'straitsx_admin')
    ) THEN
      RAISE EXCEPTION 'a % cannot hold the % role', v_entity.entity_type, v_role
        USING ERRCODE = 'ADA29';
    END IF;

    BEGIN
      INSERT INTO app.app_user (entity_id, name, role, mock_kyc_verified, institutional_eligible)
      VALUES (v_entity.id, v_name, v_role, true, v_role = 'lender')
      RETURNING * INTO v_user;
    EXCEPTION WHEN unique_violation THEN
      -- The only unique index on this table is the one-admin rule.
      RAISE EXCEPTION 'the platform already has a StraitsX administrator'
        USING ERRCODE = 'ADA29';
    END;

  ELSIF v_kind IN ('set_programme_limit', 'set_certification') THEN
    -- PRD §5 gives the StraitsX admin exactly these two levers over an issuer.
    -- Both go through the journal like every other act, so "who raised the
    -- limit, and when" is answerable from the explorer rather than from
    -- nobody's memory.
    SELECT * INTO v_entity FROM app.entity WHERE id = (v_intent->>'entityId')::uuid FOR UPDATE;
    IF v_entity.id IS NULL THEN
      RAISE EXCEPTION 'no such organisation' USING ERRCODE = 'ADA24';
    END IF;

    IF v_kind = 'set_programme_limit' THEN
      v_limit := (v_intent->>'limitBase')::bigint;   -- NULL clears the limit
      IF v_limit IS NOT NULL AND v_limit < 0 THEN
        RAISE EXCEPTION 'a programme limit cannot be negative' USING ERRCODE = 'ADA19';
      END IF;
      -- Lowering a limit below what is already outstanding is allowed: an
      -- issuer being wound down should stop issuing, not have its existing
      -- obligations invalidated. The screen shows the breach rather than
      -- hiding it, and issuance is blocked until it unwinds.
      UPDATE app.entity SET programme_limit_base = v_limit WHERE id = v_entity.id;
    ELSE
      IF (v_intent->>'status') NOT IN ('uncertified', 'certified', 'suspended') THEN
        RAISE EXCEPTION 'unknown certification status %', v_intent->>'status'
          USING ERRCODE = 'ADA19';
      END IF;
      UPDATE app.entity
         SET certification_status = (v_intent->>'status')::app.certification_status
       WHERE id = v_entity.id;
    END IF;

  ELSIF v_kind = 'remove_user' THEN
    -- PRD §5: "The admin account can delete all other users from the platform."
    -- Deactivation rather than DELETE, because every journal entry names the
    -- user who made it and the audit trail has to keep working.
    SELECT * INTO v_user FROM app.app_user
     WHERE id = (v_intent->>'userId')::uuid AND deactivated_at IS NULL
     FOR UPDATE;
    IF v_user.id IS NULL THEN
      RAISE EXCEPTION 'no such user' USING ERRCODE = 'ADA15';
    END IF;
    IF v_user.role = 'straitsx_admin' THEN
      RAISE EXCEPTION 'the StraitsX administrator cannot be removed' USING ERRCODE = 'ADA15';
    END IF;

    -- A wallet is reached through its users, so removing the last one would
    -- strand whatever that organisation holds: the balance stays on the books
    -- and nobody can act on it. PRD §5 asks for user deletion, not for a way
    -- to orphan a position.
    PERFORM 1 FROM app.app_user
     WHERE entity_id = v_user.entity_id AND id <> v_user.id AND deactivated_at IS NULL;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'that is the only account for %, which still holds a wallet',
        (SELECT name FROM app.entity WHERE id = v_user.entity_id) USING ERRCODE = 'ADA30';
    END IF;

    UPDATE app.app_user SET deactivated_at = now() WHERE id = v_user.id;

  ELSIF v_kind IN ('submit','approve','certify','grade') THEN
    SELECT * INTO v_payable FROM app.payable WHERE id = (v_intent->>'payableId')::uuid FOR NO KEY UPDATE;
    UPDATE app.payable
       SET lifecycle_status = CASE v_kind
             WHEN 'submit'  THEN 'pending_approval'::app.obligation_state
             WHEN 'approve' THEN 'approved'::app.obligation_state
             WHEN 'certify' THEN 'certified'::app.obligation_state
             ELSE v_payable.lifecycle_status END,
           grade = COALESCE((v_intent->>'grade')::app.credit_grade, grade),
           grade_rationale = COALESCE(v_intent->>'gradeRationale', grade_rationale)
     WHERE id = v_payable.id;
  END IF;

  -- Link the entry to whatever market rows this command resolved or created.
  -- Deliberately after the branch: publish_listing and place_bid create the row
  -- the FK points at, so the gate above cannot reference it yet. The same write
  -- records how any XUSD owed was paid, for the receipt and the explorer (PRD
  -- §10); those columns stay NULL for a command that moved no funding.
  IF v_listing.id IS NOT NULL OR v_bid.id IS NOT NULL OR v_payment.funding_code IS NOT NULL THEN
    UPDATE ledger.journal_entry
       SET listing_id = v_listing.id, bid_id = v_bid.id,
           funding_code = v_payment.funding_code,
           source_amount_base = v_payment.source_amount_base,
           fx_rate_e6 = v_payment.fx_rate_e6
     WHERE id = v_entry.id;
  END IF;

  -- 6. LEGS ------------------------------------------------------------------
  IF array_length(v_legs, 1) > 0 THEN
    PERFORM ledger.post_legs(v_entry.id, v_legs);
  END IF;

  -- 7. CHAIN RESULT ----------------------------------------------------------
  -- PRD §10: issuance, trade settlement, transfer, redemption and top-up get a
  -- simulated receipt. Approval, grading, listing and bid placement are audit
  -- events with no receipt. The hash is derived from the idempotency key, so a
  -- replay returns the identical hash rather than minting a second one.
  IF v_entry_kind IN ('issuance','trade_settlement','transfer','redemption','top_up') THEN
    UPDATE ledger.journal_entry
       SET chain_status = 'confirmed',
           chain_tx_hash = '0x' || encode(digest(v_key::text, 'sha256'), 'hex'),
           chain_block_number = v_entry.seq
     WHERE id = v_entry.id;
  END IF;

  SELECT * INTO v_entry FROM ledger.journal_entry WHERE id = v_entry.id;
  RETURN ledger.render_entry(v_entry);
END $$;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'adata_app') THEN
    EXECUTE 'GRANT EXECUTE ON FUNCTION ledger.post(jsonb) TO adata_app';
  END IF;
END $$;
