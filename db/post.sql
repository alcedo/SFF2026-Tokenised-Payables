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
  v_fx_cash     uuid;
  v_qty         bigint;
  v_price       bigint;
  v_source      bigint;
  v_rate        bigint;
  v_funding     ledger.cash_code;
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
BEGIN
  IF v_key IS NULL THEN
    RAISE EXCEPTION 'every command needs an idempotencyKey' USING ERRCODE = 'ADA17';
  END IF;

  SELECT * INTO v_world FROM app.world WHERE only_row;

  -- Map the intent verb onto the stored entry kind. Verbs are what a caller
  -- asks for; kinds are what the journal records.
  v_entry_kind := CASE v_kind
    WHEN 'issue_payable'  THEN 'issuance'
    WHEN 'top_up'         THEN 'top_up'
    WHEN 'transfer'       THEN 'transfer'
    WHEN 'publish_listing' THEN 'listing_published'
    WHEN 'cancel_listing' THEN 'listing_cancelled'
    WHEN 'place_bid'      THEN 'bid_placed'
    WHEN 'withdraw_bid'   THEN 'bid_withdrawn'
    WHEN 'accept_bid'     THEN 'trade_settlement'
    WHEN 'settle_maturity' THEN 'redemption'
    WHEN 'advance_clock'  THEN 'clock_advanced'
    WHEN 'reset_world'    THEN 'world_reset'
    WHEN 'create_payable' THEN 'payable_created'
    WHEN 'submit'         THEN 'submitted_for_approval'
    WHEN 'approve'        THEN 'approved'
    WHEN 'certify'        THEN 'certified'
    WHEN 'grade'          THEN 'graded'
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

    INSERT INTO ledger.asset (kind, payable_id, token_id)
    VALUES ('payable', v_payable.id, (v_intent->>'tokenId')::numeric)
    ON CONFLICT DO NOTHING;
    v_asset := ledger.payable_asset(v_payable.id);

    v_legs := ARRAY[
      ROW(ledger.system_account('system_unissued'), v_asset, -v_payable.face_base)::ledger.leg_spec,
      ROW(ledger.wallet_account(v_intent->>'toWallet', 'wallet_free'), v_asset, v_payable.face_base)::ledger.leg_spec
    ];
    UPDATE app.payable SET lifecycle_status = 'issued', issue_date = v_world.t0 + v_world.offset_days
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

  ELSIF v_kind = 'accept_bid' THEN
    -- Lock by primary key only. See the header note on EvalPlanQual.
    SELECT * INTO v_listing FROM app.listing WHERE id = (v_intent->>'listingId')::uuid FOR UPDATE;
    IF v_listing.id IS NULL THEN
      RAISE EXCEPTION 'no such listing' USING ERRCODE = 'ADA11';
    END IF;
    IF v_listing.status <> 'open' THEN
      RAISE EXCEPTION 'listing is %', v_listing.status USING ERRCODE = 'ADA11';
    END IF;
    SELECT * INTO v_bid FROM app.bid WHERE id = (v_intent->>'bidId')::uuid FOR UPDATE;
    IF v_bid.status <> 'placed' THEN
      RAISE EXCEPTION 'bid is %', v_bid.status USING ERRCODE = 'ADA11';
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

    v_price   := v_bid.price_base;
    v_funding := v_bid.funding_code;
    v_cash    := ledger.cash_asset('XUSD');
    v_rate    := v_world.xsgd_per_xusd_e6;

    -- The recipient always receives XUSD. Only the payer's side varies, and
    -- system_fx absorbs the difference so the entry still balances per asset.
    IF v_funding = 'XSGD' THEN
      v_source  := (v_price * v_rate + 500000) / 1000000;   -- round half up
      v_fx_cash := ledger.cash_asset('XSGD');
      v_legs := ARRAY[
        ROW(ledger.wallet_account(v_bid.bidder_wallet, 'wallet_free'), v_fx_cash, -v_source)::ledger.leg_spec,
        ROW(ledger.system_account('system_fx'), v_fx_cash, v_source)::ledger.leg_spec,
        ROW(ledger.system_account('system_fx'), v_cash, -v_price)::ledger.leg_spec,
        ROW(ledger.wallet_account(v_listing.seller_wallet, 'wallet_free'), v_cash, v_price)::ledger.leg_spec
      ];
    ELSE
      v_source  := v_price;    -- USDC, USDT and XUSD are 1:1 at 4dp
      v_fx_cash := ledger.cash_asset(v_funding);
      IF v_funding = 'XUSD' THEN
        v_legs := ARRAY[
          ROW(ledger.wallet_account(v_bid.bidder_wallet, 'wallet_free'), v_cash, -v_price)::ledger.leg_spec,
          ROW(ledger.wallet_account(v_listing.seller_wallet, 'wallet_free'), v_cash, v_price)::ledger.leg_spec
        ];
      ELSE
        v_legs := ARRAY[
          ROW(ledger.wallet_account(v_bid.bidder_wallet, 'wallet_free'), v_fx_cash, -v_source)::ledger.leg_spec,
          ROW(ledger.system_account('system_fx'), v_fx_cash, v_source)::ledger.leg_spec,
          ROW(ledger.system_account('system_fx'), v_cash, -v_price)::ledger.leg_spec,
          ROW(ledger.wallet_account(v_listing.seller_wallet, 'wallet_free'), v_cash, v_price)::ledger.leg_spec
        ];
      END IF;
    END IF;

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

    UPDATE ledger.journal_entry
       SET funding_code = v_funding, source_amount_base = v_source,
           fx_rate_e6 = CASE WHEN v_funding = 'XSGD' THEN v_rate ELSE 1000000 END
     WHERE id = v_entry.id;

  ELSIF v_kind = 'settle_maturity' THEN
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

    -- ADATA pays each current holder the face of the quantity they hold, and
    -- the tokens burn back to system_unissued. Because face and quantity are
    -- the same number of base units, each holder's credit IS their quantity —
    -- no pro-rata rounding is possible, and the credits reconcile to the debit
    -- exactly by construction.
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
        ROW(ledger.wallet_account(v_anchor_wallet, 'wallet_free'), v_cash, -v_holder.qty)::ledger.leg_spec,
        ROW(ledger.wallet_account(v_holder.wallet_address, 'wallet_free'), v_cash, v_holder.qty)::ledger.leg_spec
      ];
    END LOOP;

    UPDATE app.payable SET lifecycle_status = 'settled' WHERE id = v_payable.id;

  ELSIF v_kind = 'advance_clock' THEN
    v_days := (v_intent->>'days')::int;
    IF v_days < 0 THEN
      RAISE EXCEPTION 'the demo clock only moves forward' USING ERRCODE = 'ADA19';
    END IF;
    UPDATE app.world SET offset_days = offset_days + v_days WHERE only_row;

  ELSIF v_kind = 'create_payable' THEN
    -- Importing from the ERP mock rather than typing an invoice by hand is the
    -- common path (PRD section 8 screen 2), so the invoice is consumed here and
    -- the picker greys it out. Doing it inside post() means the creation is in
    -- the audit trail like every other act, instead of being a silent insert.
    SELECT * INTO v_erp FROM app.erp_invoice WHERE id = (v_intent->>'erpInvoiceId')::uuid FOR UPDATE;
    IF v_erp.id IS NULL THEN
      RAISE EXCEPTION 'no such ERP invoice' USING ERRCODE = 'ADA15';
    END IF;
    IF v_erp.consumed_by IS NOT NULL THEN
      RAISE EXCEPTION 'invoice % has already been issued as a payable', v_erp.doc_no
        USING ERRCODE = 'ADA15';
    END IF;

    INSERT INTO app.payable (id, ref, anchor_id, original_supplier_id, invoice_ref,
                             face_base, maturity_date, lifecycle_status)
    VALUES (COALESCE((v_intent->>'payableId')::uuid, gen_random_uuid()),
            v_intent->>'ref',
            (SELECT id FROM app.entity WHERE entity_type = 'anchor' ORDER BY name LIMIT 1),
            v_erp.supplier_id, v_erp.invoice_ref, v_erp.amount_base,
            (v_world.t0 + v_world.offset_days) + v_erp.terms_days,
            'draft')
    RETURNING * INTO v_payable;

    UPDATE app.erp_invoice SET consumed_by = v_payable.id WHERE id = v_erp.id;
    UPDATE ledger.journal_entry SET payable_id = v_payable.id WHERE id = v_entry.id;

  ELSIF v_kind IN ('submit','approve','certify','grade') THEN
    SELECT * INTO v_payable FROM app.payable WHERE id = (v_intent->>'payableId')::uuid FOR NO KEY UPDATE;
    UPDATE app.payable
       SET lifecycle_status = CASE v_kind
             WHEN 'submit'  THEN 'pending_approval'::app.obligation_state
             WHEN 'approve' THEN 'approved'::app.obligation_state
             WHEN 'certify' THEN 'certified'::app.obligation_state
             ELSE v_payable.lifecycle_status END,
           grade = COALESCE(v_intent->>'grade', grade),
           grade_rationale = COALESCE(v_intent->>'gradeRationale', grade_rationale)
     WHERE id = v_payable.id;
  END IF;

  -- Link the entry to whatever market rows this command resolved or created.
  -- Deliberately after the branch: publish_listing and place_bid create the row
  -- the FK points at, so the gate above cannot reference it yet.
  IF v_listing.id IS NOT NULL OR v_bid.id IS NOT NULL THEN
    UPDATE ledger.journal_entry
       SET listing_id = v_listing.id, bid_id = v_bid.id
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

GRANT EXECUTE ON FUNCTION ledger.post(jsonb) TO adata_app;
