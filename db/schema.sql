-- ============================================================================
-- ADATA tokenised payables — persistence model
-- Candidate 3: append-only double-entry journal as the single source of truth.
--
-- Reading order:
--   §0  roles and schemas          — why the app role cannot write money
--   §1  world (demo clock + FX)
--   §2  parties and wallets
--   §3  assets                     — cash and payable tokens are the same kind of thing
--   §4  accounts and balances      — the projection, and the only lock target
--   §5  instruments                — payable, series, lifecycle edges
--   §6  market                     — listing, listing_leg, bid
--   §7  the journal                — journal_entry, journal_leg
--   §8  invariants                 — deferred constraint triggers
--   §9  views                      — holding, trade, chain_receipt, proofs
--   §10 the write surface          — ledger.post()
--   §11 grants                     — the REVOKE that makes §0 true
--
-- Two rules govern every choice below:
--   1. Money is bigint base units. Never numeric, never float, never text.
--   2. Nothing the clock can change is stored. Status columns hold only
--      transitions a *person* caused.
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;   -- digest() for deterministic mock tx hashes

-- ----------------------------------------------------------------------------
-- §0  Roles and schemas
-- ----------------------------------------------------------------------------
-- `ledger` holds money state and the one function allowed to change it.
-- `app` holds everything the request handler may write directly.
-- The application connects as `adata_app`, which has NO write privilege on
-- anything in `ledger` (see §11). This is what turns "always post through
-- ledger.post()" from a code-review convention into a physical property:
-- a contributor cannot write `UPDATE account_balance SET balance = ...`
-- because the role lacks the grant, so the lock ordering in ledger.post()
-- is the *only* lock ordering that exists.

CREATE SCHEMA IF NOT EXISTS ledger;
CREATE SCHEMA IF NOT EXISTS app;

-- ----------------------------------------------------------------------------
-- §1  World: the demo clock and the FX rate
-- ----------------------------------------------------------------------------
-- Singleton. Every time-derived value in the system is computed from this row
-- and never stored. `epoch` increments on reset so an open browser tab can
-- detect "the world was reset under me" from any response.

CREATE TABLE app.world (
  only_row          boolean PRIMARY KEY DEFAULT true,
  -- INVARIANT: exactly one world. A second INSERT collides on the PK.
  CONSTRAINT world_is_singleton CHECK (only_row),

  t0                date   NOT NULL,
  offset_days       integer NOT NULL DEFAULT 0,
  -- INVARIANT: the clock only moves forward within an epoch. Reset bumps epoch
  -- and sets offset_days back to 0, which is a different epoch, so this holds.
  CONSTRAINT clock_never_rewinds CHECK (offset_days >= 0),

  -- XSGD per 1 XUSD, scaled by 1e6. 1.31 -> 1_310_000.
  -- bigint, not numeric: §6 of the PRD makes every money path integer, and a
  -- numeric here is the one crack a float would come through (the pg driver
  -- hands numeric back as string and the first contributor to need arithmetic
  -- reaches for parseFloat).
  xsgd_per_xusd_e6  bigint NOT NULL DEFAULT 1310000,
  CONSTRAINT fx_rate_positive CHECK (xsgd_per_xusd_e6 > 0),

  epoch             bigint NOT NULL DEFAULT 1
);

-- ----------------------------------------------------------------------------
-- §2  Parties and wallets
-- ----------------------------------------------------------------------------

CREATE TYPE app.entity_type AS ENUM ('anchor', 'supplier', 'lender', 'platform');
CREATE TYPE app.user_role   AS ENUM (
  'adata_preparer', 'adata_checker', 'supplier', 'lender', 'straitsx_admin'
);
CREATE TYPE app.certification_status AS ENUM ('uncertified', 'certified', 'suspended');

CREATE TABLE app.entity (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name                  text NOT NULL,
  entity_type           app.entity_type NOT NULL,
  certification_status  app.certification_status NOT NULL DEFAULT 'uncertified',
  -- Programme limit is a face-value cap in XUSD base units.
  programme_limit_base  bigint,
  CONSTRAINT programme_limit_non_negative CHECK (programme_limit_base IS NULL
                                                 OR programme_limit_base >= 0)
);

CREATE TABLE app.wallet (
  address     text PRIMARY KEY,
  entity_id   uuid NOT NULL REFERENCES app.entity(id),
  -- INVARIANT: displayed addresses are 0x + 40 hex, so the mock explorer and a
  -- future Sepolia address are the same shape and the UI never branches.
  CONSTRAINT wallet_address_shape CHECK (address ~ '^0x[0-9a-f]{40}$')
);
CREATE INDEX wallet_by_entity ON app.wallet(entity_id);

CREATE TABLE app.app_user (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id               uuid NOT NULL REFERENCES app.entity(id),
  name                    text NOT NULL,
  role                    app.user_role NOT NULL,
  mock_kyc_verified       boolean NOT NULL DEFAULT false,
  institutional_eligible  boolean NOT NULL DEFAULT false,
  deactivated_at          timestamptz,
  -- INVARIANT (PRD §9): only institutionally eligible accounts bid or buy.
  -- Eligibility is a property of the lender role, so make the combination
  -- unrepresentable rather than checking it at every marketplace call site.
  CONSTRAINT only_lenders_are_institutional
    CHECK (NOT institutional_eligible OR role = 'lender')
);
-- INVARIANT (PRD §5): exactly one StraitsX admin account.
CREATE UNIQUE INDEX one_straitsx_admin
  ON app.app_user((role)) WHERE role = 'straitsx_admin' AND deactivated_at IS NULL;

-- ----------------------------------------------------------------------------
-- §3  Assets
-- ----------------------------------------------------------------------------
-- A cash asset and a payable token are the same kind of thing to the ledger:
-- an integer quantity that moves between accounts. Unifying them is what lets
-- one journal entry carry both sides of a trade atomically, and is what makes
-- a Sepolia ERC-20 and ERC-1155 transfer index into the same two tables.
--
-- ALL FOUR CASH ASSETS USE THE SAME 4-DECIMAL BASE UNIT as XUSD face value.
-- Real USDC is 6dp; here it is 4dp, deliberately, so USDC/USDT/XUSD conversion
-- is the identity function on integers and cannot round. Only XSGD rounds.

CREATE TYPE ledger.asset_kind AS ENUM ('cash', 'payable');
CREATE TYPE ledger.cash_code  AS ENUM ('XUSD', 'USDC', 'USDT', 'XSGD');

CREATE TABLE ledger.asset (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind        ledger.asset_kind NOT NULL,
  cash_code   ledger.cash_code,
  payable_id  uuid,                        -- FK added in §5 (circular reference)
  -- The ERC-1155 token id. Mock now, the real on-chain id after the port.
  token_id    numeric(78,0),               -- uint256 range; NEVER used in arithmetic
  -- INVARIANT: an asset is exactly one of cash or payable, and a payable asset
  -- is the only kind with a token id. This is the `payable_id OR series_id`
  -- discipline of PRD §13 expressed as a constraint instead of prose.
  CONSTRAINT asset_is_exactly_one_kind CHECK (
    (kind = 'cash'    AND cash_code IS NOT NULL AND payable_id IS NULL AND token_id IS NULL)
 OR (kind = 'payable' AND cash_code IS NULL     AND payable_id IS NOT NULL AND token_id IS NOT NULL)
  ),
  UNIQUE (id, kind)                        -- target for composite FKs below
);
CREATE UNIQUE INDEX asset_one_per_cash_code ON ledger.asset(cash_code) WHERE kind = 'cash';
CREATE UNIQUE INDEX asset_one_per_payable   ON ledger.asset(payable_id) WHERE kind = 'payable';

-- ----------------------------------------------------------------------------
-- §4  Accounts and balances
-- ----------------------------------------------------------------------------
-- Account purposes:
--   wallet_free    spendable / transferable / listable
--   wallet_listed  escrowed against an open listing (PRD §9 "listed quantity
--                  is locked to the listing"). Modelling the lock as a real
--                  account is what removes "available = balance - locked"
--                  arithmetic from every call site: availability is just the
--                  free balance, and over-committing is blocked by the same
--                  non-negative CHECK that blocks an overdraft.
--   system_unissued  the 0x0 address, per asset. Minting credits a holder and
--                  debits this; burning at redemption does the reverse. Its
--                  balance is the negative of outstanding supply.
--   system_fx      absorbs currency conversion. An XSGD-funded purchase debits
--                  the buyer in XSGD to this account and credits the seller in
--                  XUSD from this account, so *every entry balances per asset*
--                  with no cross-currency special case anywhere in the code.
--   system_mint    source of demo top-ups.

CREATE TYPE ledger.account_purpose AS ENUM (
  'wallet_free', 'wallet_listed', 'system_unissued', 'system_fx', 'system_mint'
);
CREATE TYPE ledger.account_class AS ENUM ('wallet', 'system');

CREATE TABLE ledger.account (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  class           ledger.account_class NOT NULL,
  purpose         ledger.account_purpose NOT NULL,
  wallet_address  text REFERENCES app.wallet(address),
  -- INVARIANT: class is a function of purpose, and only wallet accounts carry
  -- an address. `class` is carried separately because the non-negative CHECK
  -- in account_balance needs it on the balance row (see composite FK below).
  CONSTRAINT account_class_matches_purpose CHECK (
    (class = 'wallet' AND purpose IN ('wallet_free','wallet_listed') AND wallet_address IS NOT NULL)
 OR (class = 'system' AND purpose NOT IN ('wallet_free','wallet_listed') AND wallet_address IS NULL)
  ),
  UNIQUE (id, class)                       -- target for the composite FK below
);
CREATE UNIQUE INDEX account_one_per_wallet_purpose
  ON ledger.account(wallet_address, purpose) WHERE class = 'wallet';
CREATE UNIQUE INDEX account_one_per_system_purpose
  ON ledger.account(purpose) WHERE class = 'system';

-- The projection. NOT a second source of truth: it is maintained only by the
-- trigger in §8 from journal_leg, it is the exclusive lock target, and
-- ledger.prove_books_balance() (§9) asserts it equals SUM(journal_leg) for
-- every row. It exists for two reasons and no others:
--   (a) a row to take FOR UPDATE, so contention blocks instead of aborting;
--   (b) a CHECK, so an overdraft is a constraint violation rather than a
--       read-then-write race that SSI has to catch.
CREATE TABLE ledger.account_balance (
  account_id  uuid NOT NULL,
  asset_id    uuid NOT NULL REFERENCES ledger.asset(id),
  class       ledger.account_class NOT NULL,
  balance     bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (account_id, asset_id),
  -- The composite FK proves `class` is a faithful copy of account.class, so
  -- the CHECK below cannot be defeated by writing the wrong class on a row.
  FOREIGN KEY (account_id, class) REFERENCES ledger.account(id, class),
  -- INVARIANT: no wallet may go negative — no overdraft, no over-quantity
  -- transfer, no double redemption (a second burn would drive the holder's
  -- token balance below zero and abort). System accounts must go negative:
  -- system_unissued holds -supply.
  CONSTRAINT wallet_balance_non_negative CHECK (class = 'system' OR balance >= 0)
);
-- Holder breakdown for a payable, and "all balances of a wallet", are both
-- single index scans. This is the whole performance story: no aggregate over
-- the journal is ever on a screen's critical path.
CREATE INDEX account_balance_by_asset ON ledger.account_balance(asset_id)
  WHERE balance <> 0;

-- ----------------------------------------------------------------------------
-- §5  Instruments
-- ----------------------------------------------------------------------------
-- Stored lifecycle holds ONLY states a person moved the payable into.
-- `matured` and `overdue` are absent from this enum on purpose: they are
-- functions of (maturity_date, world clock, settled?) and are derived in
-- core/lifecycle.ts. A stored `matured` would go stale the moment the demo
-- clock advanced, and would need a sweeper job whose failure mode is
-- "presenter fast-forwards and nothing happens".

CREATE TYPE app.obligation_state AS ENUM (
  'draft', 'pending_approval', 'approved', 'certified', 'issued', 'settled'
);
CREATE TYPE app.credit_grade AS ENUM ('AAA', 'AA', 'A');

CREATE TABLE app.series (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ref           text NOT NULL UNIQUE,
  anchor_id     uuid NOT NULL REFERENCES app.entity(id),
  maturity_date date NOT NULL,
  grade         app.credit_grade,
  grade_rationale text,
  -- No face value column. Series face is SUM of member quantities (PRD §6),
  -- exposed by ledger.v_series (§9). Storing it would be a second truth that
  -- drifts the first time a member is transferred.
  UNIQUE (id, maturity_date)               -- target for the composite FK below
);

CREATE TABLE app.payable (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ref                   text NOT NULL UNIQUE,          -- TP-2026-0141
  anchor_id             uuid NOT NULL REFERENCES app.entity(id),
  original_supplier_id  uuid NOT NULL REFERENCES app.entity(id),
  invoice_ref           text NOT NULL,
  -- Original invoice face in XUSD base units. Immutable after issuance; the
  -- outstanding face is derived from the ledger, not from this column.
  face_base             bigint NOT NULL,
  CONSTRAINT face_is_positive_whole_units CHECK (face_base > 0),
  issue_date            date,
  maturity_date         date NOT NULL,
  CONSTRAINT maturity_after_issue CHECK (issue_date IS NULL OR maturity_date > issue_date),
  grade                 app.credit_grade,
  grade_rationale       text,
  lifecycle_status      app.obligation_state NOT NULL DEFAULT 'draft',
  series_id             uuid,
  -- INVARIANT (PRD §6): every member of a series shares the series maturity
  -- date. Expressed as a composite foreign key rather than a trigger, so the
  -- database refuses the bad row instead of a code path remembering to check.
  FOREIGN KEY (series_id, maturity_date) REFERENCES app.series(id, maturity_date),
  -- INVARIANT (PRD §9): only certified, graded payables reach the market.
  CONSTRAINT graded_before_certified
    CHECK (lifecycle_status IN ('draft','pending_approval','approved') OR grade IS NOT NULL),
  CONSTRAINT issued_has_issue_date
    CHECK (lifecycle_status IN ('draft','pending_approval','approved','certified')
           OR issue_date IS NOT NULL)
);
-- INVARIANT: one supplier's invoice is financed once. Manual entry (PRD §8
-- screen 2) lets a preparer type an invoice reference by hand, and financing
-- the same invoice twice is the fraud this programme exists to prevent, so the
-- database refuses it rather than a form remembering to check.
CREATE UNIQUE INDEX payable_one_per_invoice
  ON app.payable(original_supplier_id, invoice_ref);
CREATE INDEX payable_by_series   ON app.payable(series_id) WHERE series_id IS NOT NULL;
CREATE INDEX payable_by_maturity ON app.payable(maturity_date) WHERE lifecycle_status = 'issued';

ALTER TABLE ledger.asset
  ADD CONSTRAINT asset_payable_fk FOREIGN KEY (payable_id) REFERENCES app.payable(id);

-- The lifecycle state machine of PRD §7, as data. The trigger below makes an
-- illegal transition a database error; core/lifecycle.ts makes it a type error.
-- Two layers on purpose: the type stops the contributor, the trigger stops the
-- migration script and the psql session.
-- PRD §3 question 7: "Supplier will have an option to accept the tokenised
-- payable or reject it." The section 7 lifecycle diagram has no state for this
-- and the PRD never says what a rejection does to the obligation, so acceptance
-- is modelled as delivery state on the payable rather than as a lifecycle state.
-- That keeps the obligation diagram exactly as the PRD draws it.
--
-- A rejection returns the full quantity to the anchor's wallet. Burning it
-- would break the section 13 rule that holdings sum to outstanding face, and
-- section 4 puts operational cancellation out of scope, so there is no
-- cancelled state to move to.
CREATE TYPE app.receipt_status AS ENUM ('pending', 'accepted', 'rejected');
ALTER TABLE app.payable ADD COLUMN receipt_status app.receipt_status;
-- INVARIANT: receipt state exists exactly for a payable that has been issued.
ALTER TABLE app.payable ADD CONSTRAINT receipt_only_once_issued CHECK (
  (lifecycle_status IN ('draft','pending_approval','approved','certified') AND receipt_status IS NULL)
  OR (lifecycle_status IN ('issued','settled') AND receipt_status IS NOT NULL)
);

CREATE TABLE app.lifecycle_edge (
  from_state  app.obligation_state NOT NULL,
  to_state    app.obligation_state NOT NULL,
  actor_role  app.user_role NOT NULL,
  PRIMARY KEY (from_state, to_state)
);
INSERT INTO app.lifecycle_edge VALUES
  ('draft',            'pending_approval', 'adata_preparer'),
  ('pending_approval', 'approved',         'adata_checker'),
  ('approved',         'certified',        'straitsx_admin'),
  ('certified',        'issued',           'straitsx_admin'),
  ('issued',           'settled',          'adata_preparer');
-- Note there is no edge into 'matured' or 'overdue'. There is no such row to
-- write, because there is no such stored state.

CREATE FUNCTION app.enforce_lifecycle_edge() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.lifecycle_status = OLD.lifecycle_status THEN RETURN NEW; END IF;
  IF NOT EXISTS (SELECT 1 FROM app.lifecycle_edge
                 WHERE from_state = OLD.lifecycle_status
                   AND to_state   = NEW.lifecycle_status) THEN
    RAISE EXCEPTION 'illegal lifecycle transition % -> %',
      OLD.lifecycle_status, NEW.lifecycle_status USING ERRCODE = 'ADA01';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER payable_lifecycle_edge BEFORE UPDATE ON app.payable
  FOR EACH ROW EXECUTE FUNCTION app.enforce_lifecycle_edge();

-- ----------------------------------------------------------------------------
-- §6  Market
-- ----------------------------------------------------------------------------
-- listing.status has no 'expired' member, and bid.status has no 'expired'
-- member, because expiry is a function of the clock and maturity. A listing is
-- *shown* as expired when status='open' AND clock >= maturity; acceptance
-- rechecks maturity under lock and refuses. Nothing sweeps, nothing goes stale.

CREATE TYPE app.listing_status AS ENUM (
  'open',                       -- published; escrow held
  'filled',                     -- a bid was accepted or buy-now executed
  'cancelled',                  -- seller withdrew
  'closed_by_transfer'          -- seller transferred out from under it (PRD §9)
);
CREATE TYPE app.bid_status AS ENUM (
  'placed', 'accepted', 'withdrawn',
  'superseded'                  -- a competing bid on the same listing won
);
CREATE TYPE app.listing_target AS ENUM ('payable', 'series');

CREATE TABLE app.listing (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  target_kind         app.listing_target NOT NULL,
  target_payable_id   uuid REFERENCES app.payable(id),
  target_series_id    uuid REFERENCES app.series(id),
  -- PRD §13 "payable_id OR series_id means exactly one target".
  CONSTRAINT listing_exactly_one_target CHECK (
    (target_kind = 'payable' AND target_payable_id IS NOT NULL AND target_series_id IS NULL)
 OR (target_kind = 'series'  AND target_payable_id IS NULL     AND target_series_id IS NOT NULL)
  ),
  target_id           uuid GENERATED ALWAYS AS
                        (COALESCE(target_payable_id, target_series_id)) STORED,
  seller_wallet       text NOT NULL REFERENCES app.wallet(address),
  -- Prices are the aggregate XUSD for the whole lot, in base units.
  -- There is no quantity column: quantity lives in listing_leg, one row per
  -- asset, so a series listing and a payable listing are the same shape and
  -- the escrow invariant in §8 is one equality rather than two cases.
  min_price_base      bigint NOT NULL,
  buy_now_price_base  bigint,
  status              app.listing_status NOT NULL DEFAULT 'open',
  created_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT listing_prices_positive CHECK (
    min_price_base > 0 AND (buy_now_price_base IS NULL OR buy_now_price_base >= min_price_base)
  )
);
-- INVARIANT (PRD §9): "a wallet may have only one active listing per payable
-- or Series". A partial unique index, so a concurrent second publish gets a
-- unique violation rather than winning a race.
CREATE UNIQUE INDEX one_open_listing_per_seller_target
  ON app.listing(seller_wallet, target_kind, target_id) WHERE status = 'open';

CREATE TABLE app.listing_leg (
  listing_id     uuid NOT NULL REFERENCES app.listing(id) ON DELETE CASCADE,
  asset_id       uuid NOT NULL REFERENCES ledger.asset(id),
  quantity_base  bigint NOT NULL,
  PRIMARY KEY (listing_id, asset_id),
  CONSTRAINT listing_quantity_positive CHECK (quantity_base > 0)
);

CREATE TABLE app.bid (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  listing_id     uuid NOT NULL REFERENCES app.listing(id),
  bidder_wallet  text NOT NULL REFERENCES app.wallet(address),
  -- The XUSD offer is fixed; the funding asset only decides the source debit
  -- (PRD §9). funding_asset therefore belongs here, never on the instrument.
  price_base     bigint NOT NULL CHECK (price_base > 0),
  funding_code   ledger.cash_code NOT NULL,
  status         app.bid_status NOT NULL DEFAULT 'placed',
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX bid_by_listing ON app.bid(listing_id) WHERE status = 'placed';
-- Bids do NOT reserve funds (PRD §9). There is deliberately no escrow account
-- and no balance constraint here; sufficiency is rechecked under lock at
-- acceptance, and insufficiency leaves the bid untouched.

-- ----------------------------------------------------------------------------
-- §7  The journal
-- ----------------------------------------------------------------------------
-- This is the audit trail of PRD §10, the mock blockchain of PRD §10, and the
-- source of truth for every balance and holding, in one append-only table.
-- They are the same table because they are the same fact: a state transition
-- that happened, attributed to an actor, at a point in the world's ordering.
--
-- Entries with zero legs are application events (approval, grading, listing
-- publication, bid placement). Entries with legs are chain-relevant actions.
-- PRD §10's two lists coincide exactly, so "chain-relevant" is derived from
-- leg count, never stored as a flag that could disagree.

CREATE TYPE ledger.entry_kind AS ENUM (
  -- legless: application events
  'payable_created', 'submitted_for_approval', 'approved', 'certified',
  'graded', 'listing_published', 'listing_cancelled', 'bid_placed',
  'bid_withdrawn', 'clock_advanced', 'world_reset', 'receipt_accepted',
  -- legged: chain-relevant actions
  'issuance', 'receipt_rejected', 'top_up', 'transfer', 'trade_settlement', 'redemption'
);
CREATE TYPE ledger.chain_status AS ENUM ('not_applicable', 'pending', 'confirmed', 'failed');

CREATE TABLE ledger.journal_entry (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Total order over the world. Doubles as the mock block number, so the
  -- explorer's ordering and the audit trail's ordering cannot disagree.
  seq                  bigint GENERATED ALWAYS AS IDENTITY,
  kind                 ledger.entry_kind NOT NULL,

  -- IDEMPOTENCY. Client-minted UUID, bound to the *intent* not the click: the
  -- confirm dialog mints it when it opens, so a double-click, a React retry
  -- and a serverless re-invocation all carry the same key. A replay returns
  -- the original entry and the original receipt, exactly as resubmitting a
  -- signed transaction returns the original tx hash.
  idempotency_key      uuid NOT NULL UNIQUE,
  -- sha256 of the canonicalised command. A key replayed with a *different*
  -- payload is a bug, not a retry, and must be rejected loudly rather than
  -- silently returning someone else's receipt.
  request_fingerprint  bytea NOT NULL,

  actor_user_id        uuid NOT NULL REFERENCES app.app_user(id),
  -- The demo timestamp (world clock), separate from the wall clock. Audit
  -- shows the demo date; ordering uses seq.
  world_date           date NOT NULL,
  world_epoch          bigint NOT NULL,
  recorded_at          timestamptz NOT NULL DEFAULT now(),

  -- Subject references. Nullable, constrained per kind so the timeline query
  -- for "everything that happened to TP-2026-0141" is one indexed predicate.
  payable_id           uuid REFERENCES app.payable(id),
  series_id            uuid REFERENCES app.series(id),
  listing_id           uuid REFERENCES app.listing(id),
  bid_id               uuid REFERENCES app.bid(id),

  -- Chain attachment. In mock mode ledger.post() sets 'confirmed' with a hash
  -- derived from idempotency_key in the same transaction. In Sepolia mode it
  -- sets 'pending' and the indexer confirms. The column exists now precisely
  -- so the port does not have to add it later.
  chain_status         ledger.chain_status NOT NULL DEFAULT 'not_applicable',
  chain_tx_hash        text,
  chain_block_number   bigint,
  CONSTRAINT chain_fields_match_status CHECK (
    (chain_status IN ('not_applicable','pending') AND chain_tx_hash IS NULL)
 OR (chain_status IN ('confirmed','failed') AND chain_tx_hash IS NOT NULL)
  ),
  -- Conversion disclosure for payments (PRD §10 items 2-4). Null for entries
  -- that move no cash. fx_rate is the integer e6 rate actually used, captured
  -- at post time so a later world reset cannot retroactively change a receipt.
  funding_code         ledger.cash_code,
  source_amount_base   bigint,
  fx_rate_e6           bigint,
  CONSTRAINT funding_fields_together CHECK (
    (funding_code IS NULL AND source_amount_base IS NULL AND fx_rate_e6 IS NULL)
 OR (funding_code IS NOT NULL AND source_amount_base IS NOT NULL AND fx_rate_e6 IS NOT NULL)
  ),
  payload              jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX entry_timeline_payable ON ledger.journal_entry(payable_id, seq DESC);
CREATE INDEX entry_timeline_series  ON ledger.journal_entry(series_id, seq DESC);
CREATE UNIQUE INDEX entry_by_tx_hash ON ledger.journal_entry(chain_tx_hash)
  WHERE chain_tx_hash IS NOT NULL;

CREATE TABLE ledger.journal_leg (
  entry_id    uuid NOT NULL REFERENCES ledger.journal_entry(id),
  leg_no      smallint NOT NULL,
  account_id  uuid NOT NULL REFERENCES ledger.account(id),
  asset_id    uuid NOT NULL REFERENCES ledger.asset(id),
  -- Signed base units. Negative = debit, positive = credit.
  amount      bigint NOT NULL,
  PRIMARY KEY (entry_id, leg_no),
  -- A zero leg carries no information and would let a "balanced" entry hide a
  -- mistake behind noise.
  CONSTRAINT leg_amount_non_zero CHECK (amount <> 0)
);
CREATE INDEX leg_by_account_asset ON ledger.journal_leg(account_id, asset_id);
CREATE INDEX leg_by_asset ON ledger.journal_leg(asset_id);

-- ----------------------------------------------------------------------------
-- §8  Invariants
-- ----------------------------------------------------------------------------
-- Everything below is DEFERRABLE INITIALLY DEFERRED: it is checked once at
-- COMMIT, after all the legs of a multi-effect operation are in place. That is
-- what makes "a trade settlement is one operation" enforceable rather than
-- aspirational — the intermediate states inside the transaction are allowed to
-- be unbalanced; the committed state cannot be.

-- (1) BALANCE PROJECTION. account_balance is written here and nowhere else.
CREATE FUNCTION ledger.project_leg() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- The row is guaranteed to exist: ledger.post() pre-creates and locks every
  -- (account, asset) it will touch, in sorted order, before inserting legs.
  UPDATE ledger.account_balance
     SET balance = balance + NEW.amount
   WHERE account_id = NEW.account_id AND asset_id = NEW.asset_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no locked balance row for account % asset %',
      NEW.account_id, NEW.asset_id USING ERRCODE = 'ADA02';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER project_leg_into_balance AFTER INSERT ON ledger.journal_leg
  FOR EACH ROW EXECUTE FUNCTION ledger.project_leg();

-- (2) DOUBLE ENTRY. Every entry nets to zero *per asset*. Cross-asset netting
-- is meaningless (you cannot balance tokens against XUSD), so the check is per
-- (entry, asset). This is the constraint that makes the PRD §7 sum invariant
-- ("holdings must sum to outstanding face") free rather than enforced: if
-- every entry nets to zero per asset and supply was created by one mint entry,
-- the holder balances sum to supply by arithmetic, not by vigilance.
CREATE FUNCTION ledger.assert_entry_balances() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE offending record;
BEGIN
  SELECT entry_id, asset_id, SUM(amount) AS net INTO offending
    FROM ledger.journal_leg WHERE entry_id = NEW.entry_id
    GROUP BY entry_id, asset_id HAVING SUM(amount) <> 0 LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'entry % does not balance for asset % (net %)',
      offending.entry_id, offending.asset_id, offending.net USING ERRCODE = 'ADA03';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER entry_must_balance
  AFTER INSERT ON ledger.journal_leg
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION ledger.assert_entry_balances();

-- (3) ESCROW EQUALITY. For every seller and asset, the wallet_listed balance
-- equals the sum of that seller's open listing quantities in that asset.
--
-- This single equality enforces four separate PRD rules at once:
--   - listed quantity is locked to its listing (§9)
--   - a transfer that drops the holding below the listed quantity must close
--     the listing and expire its bids *as part of that transfer* (§9) —
--     forgetting the cascade is now a commit error, not a silent bug
--   - accepting a bid must close the listing as part of settlement (§7)
--   - cancelling a listing must return the quantity to the seller (§9)
-- Scoped to one seller wallet, because a CONSTRAINT TRIGGER must be FOR EACH
-- ROW (Postgres has no deferrable statement-level trigger). Scoping is the
-- better shape anyway: the check is two indexed lookups, not a table scan.
CREATE FUNCTION ledger.assert_escrow_for_wallet(p_wallet text) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE offending record;
BEGIN
  IF p_wallet IS NULL THEN RETURN; END IF;
  SELECT ab.asset_id, ab.balance, COALESCE(l.q, 0) AS listed INTO offending
    FROM ledger.account a
    JOIN ledger.account_balance ab ON ab.account_id = a.id
    LEFT JOIN LATERAL (
      SELECT SUM(ll.quantity_base) AS q
        FROM app.listing li JOIN app.listing_leg ll ON ll.listing_id = li.id
       WHERE li.status = 'open' AND li.seller_wallet = p_wallet
         AND ll.asset_id = ab.asset_id
    ) l ON true
   WHERE a.wallet_address = p_wallet AND a.purpose = 'wallet_listed'
     AND ab.balance <> COALESCE(l.q, 0)
   LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'escrow for % asset % does not match open listings (held %, listed %)',
      p_wallet, offending.asset_id, offending.balance, offending.listed
      USING ERRCODE = 'ADA04';
  END IF;
END $$;

CREATE FUNCTION ledger.escrow_guard_listing() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM ledger.assert_escrow_for_wallet(
    CASE WHEN TG_OP = 'DELETE' THEN OLD.seller_wallet ELSE NEW.seller_wallet END);
  RETURN NULL;
END $$;

CREATE FUNCTION ledger.escrow_guard_leg() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE v_wallet text;
BEGIN
  SELECT a.wallet_address INTO v_wallet FROM ledger.account a
   WHERE a.id = NEW.account_id AND a.purpose = 'wallet_listed';
  PERFORM ledger.assert_escrow_for_wallet(v_wallet);   -- no-op for other purposes
  RETURN NULL;
END $$;

CREATE CONSTRAINT TRIGGER escrow_matches_open_listings
  AFTER INSERT OR UPDATE OR DELETE ON app.listing
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION ledger.escrow_guard_listing();
CREATE CONSTRAINT TRIGGER escrow_matches_open_listings_legs
  AFTER INSERT ON ledger.journal_leg
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION ledger.escrow_guard_leg();

-- (4) CONSERVATION. For every asset, the sum of all balances is zero, because
-- supply is held as a negative in system_unissued. Belt and braces over (2):
-- (2) protects the write path, this protects hand-written migrations, seed
-- scripts and anything a psql session does with elevated privileges.
CREATE FUNCTION ledger.assert_asset_conservation() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE v_net bigint;
BEGIN
  -- Scoped to the leg's own asset: one indexed aggregate, not a table scan.
  SELECT SUM(balance) INTO v_net
    FROM ledger.account_balance WHERE asset_id = NEW.asset_id;
  IF v_net <> 0 THEN
    RAISE EXCEPTION 'asset % is not conserved (net %)', NEW.asset_id, v_net
      USING ERRCODE = 'ADA05';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER assets_are_conserved
  AFTER INSERT ON ledger.journal_leg
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION ledger.assert_asset_conservation();

-- (5) NO SILENT REWRITES. The journal is append-only once a receipt exists.
--
-- A trigger, not a RULE. The obvious spelling is
--   CREATE RULE ... ON UPDATE ... WHERE OLD.chain_status='confirmed' DO INSTEAD NOTHING
-- and it works, but Postgres then refuses `INSERT ... ON CONFLICT` against this
-- table entirely ("cannot be used with table that has INSERT or UPDATE rules"),
-- even though the rule only covers UPDATE. That would take away the idempotency
-- gate in ledger.post(), which is the more important of the two guarantees. A
-- BEFORE UPDATE trigger enforces the same immutability and leaves ON CONFLICT
-- available.
--
-- Raising rather than silently discarding the write is also the better
-- behaviour: a caller trying to rewrite a settled receipt has a bug, and
-- `DO INSTEAD NOTHING` would hide it.
CREATE FUNCTION ledger.journal_entry_is_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.chain_status = 'confirmed' THEN
    RAISE EXCEPTION 'journal entry % is confirmed and cannot be modified', OLD.id
      USING ERRCODE = 'ADA06';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER journal_entry_no_update BEFORE UPDATE ON ledger.journal_entry
  FOR EACH ROW EXECUTE FUNCTION ledger.journal_entry_is_append_only();
REVOKE UPDATE, DELETE ON ledger.journal_leg FROM PUBLIC;

-- ----------------------------------------------------------------------------
-- §9  Views: the read model
-- ----------------------------------------------------------------------------
-- Every view takes the clock as a *parameter* where time matters. None of them
-- calls now() or CURRENT_DATE. A CI grep over this file for `current_date|now()`
-- outside app.world and recorded_at defaults is the mechanism that keeps it so.

-- A wallet's position in a payable. PRD §13: "a wallet with quantity zero has
-- no holding row" — the balance table may hold zero rows (they are locks), the
-- holding view filters them out. The projection table is not the API.
CREATE VIEW ledger.v_holding AS
  -- SUM(bigint) returns numeric in Postgres, and numeric reaches node-postgres
  -- as a string, which is where the first parseFloat would appear. Every
  -- aggregate in this schema casts back to bigint for that reason; the CI
  -- scan in §12 covers views precisely so a new one cannot forget.
  SELECT a.wallet_address,
         ast.payable_id,
         SUM(ab.balance)::bigint                                            AS quantity_base,
         COALESCE(SUM(ab.balance) FILTER (WHERE a.purpose='wallet_free'),0)::bigint   AS free_base,
         COALESCE(SUM(ab.balance) FILTER (WHERE a.purpose='wallet_listed'),0)::bigint AS listed_base
    FROM ledger.account_balance ab
    JOIN ledger.account a   ON a.id = ab.account_id AND a.class = 'wallet'
    JOIN ledger.asset   ast ON ast.id = ab.asset_id AND ast.kind = 'payable'
   GROUP BY a.wallet_address, ast.payable_id
  HAVING SUM(ab.balance) > 0;

-- Outstanding face = negative of the unissued account. Not a stored column.
CREATE VIEW ledger.v_payable_supply AS
  SELECT ast.payable_id, -ab.balance AS outstanding_base
    FROM ledger.account_balance ab
    JOIN ledger.account a   ON a.id = ab.account_id AND a.purpose = 'system_unissued'
    JOIN ledger.asset   ast ON ast.id = ab.asset_id AND ast.kind = 'payable';

-- Series face derived from members, never stored, never double counted:
-- programme totals join payables and treat series purely as a grouping key.
CREATE VIEW ledger.v_series AS
  SELECT s.id, s.ref, s.maturity_date, s.grade,
         COUNT(p.id)::bigint                            AS member_count,
         COALESCE(SUM(sup.outstanding_base), 0)::bigint AS face_base
    FROM app.series s
    LEFT JOIN app.payable p ON p.series_id = s.id
    LEFT JOIN ledger.v_payable_supply sup ON sup.payable_id = p.id
   GROUP BY s.id, s.ref, s.maturity_date, s.grade;

-- Trades are derived from the journal, not stored twice. Cost basis for the
-- portfolio's purchase-price-weighted entry yield comes from here.
-- The buyer is whoever the token was credited to; the seller is whoever it was
-- debited from (their listed escrow account); the price is the XUSD credited
-- to that same seller's wallet. Deriving the seller from "the cash debit"
-- instead is wrong whenever funding is XSGD: the debit is then in XSGD and
-- sits against the FX book, not the seller.
-- TODO series: N token legs produce N rows sharing one lot price. Allocate
-- price_base pro-rata by member quantity before using it as a cost basis.
CREATE VIEW ledger.v_trade AS
  SELECT e.id AS entry_id, e.seq, e.world_date, e.listing_id, e.bid_id,
         buyer.wallet_address  AS buyer_wallet,
         seller.wallet_address AS seller_wallet,
         tok.payable_id,
         tok_in.amount         AS quantity_base,
         xusd_in.amount        AS price_base
    FROM ledger.journal_entry e
    JOIN ledger.journal_leg tok_in  ON tok_in.entry_id = e.id AND tok_in.amount > 0
    JOIN ledger.asset tok           ON tok.id = tok_in.asset_id AND tok.kind = 'payable'
    JOIN ledger.account buyer       ON buyer.id = tok_in.account_id
    JOIN ledger.journal_leg tok_out ON tok_out.entry_id = e.id
                                   AND tok_out.asset_id = tok_in.asset_id
                                   AND tok_out.amount < 0
    JOIN ledger.account seller      ON seller.id = tok_out.account_id
    JOIN ledger.journal_leg xusd_in ON xusd_in.entry_id = e.id AND xusd_in.amount > 0
    JOIN ledger.asset xusd          ON xusd.id = xusd_in.asset_id AND xusd.cash_code = 'XUSD'
    JOIN ledger.account sc          ON sc.id = xusd_in.account_id
                                   AND sc.wallet_address = seller.wallet_address
   WHERE e.kind = 'trade_settlement';

-- The mock explorer and the event history read the same view, so a receipt
-- reopened from history is byte-identical to the one shown at confirmation.
-- The hash is a pure function of the idempotency key, which means a replayed
-- command produces the same hash before the database is even consulted.
--
-- INVARIANT (PRD §10): an entry is chain-relevant iff its legs span more than
-- one party — two wallets, or a wallet and a system account. "Has legs" is NOT
-- the test: publishing a listing moves quantity from the seller's free account
-- to their listed account, which is real ledger movement but is intra-wallet
-- and mints no receipt, exactly as escrow-by-approval mints no ERC-1155
-- transfer on chain. Under this rule the two lists in PRD §10 coincide exactly
-- — issuance, top-up, transfer, trade settlement and redemption cross a party
-- boundary; approval, grading, listing and bid placement do not — so
-- chain-relevance stays derived and can never disagree with the legs.
CREATE VIEW ledger.v_chain_receipt AS
  SELECT e.id AS entry_id,
         COALESCE(e.chain_tx_hash,
                  '0x' || encode(digest(e.idempotency_key::text, 'sha256'), 'hex')) AS tx_hash,
         e.seq AS block_number,
         e.chain_status,
         e.kind, e.world_date, e.funding_code, e.source_amount_base, e.fx_rate_e6,
         true AS simulated
    FROM ledger.journal_entry e
   WHERE (SELECT COUNT(DISTINCT COALESCE(a.wallet_address, '~system'))
            FROM ledger.journal_leg l
            JOIN ledger.account a ON a.id = l.account_id
           WHERE l.entry_id = e.id) > 1;

-- Demo asset as much as a test: "prove the books balance" on the admin screen.
-- Returns one row per disagreement between the journal and the projection.
CREATE FUNCTION ledger.prove_books_balance()
RETURNS TABLE (account_id uuid, asset_id uuid, projected bigint, journalled bigint)
LANGUAGE sql STABLE AS $$
  SELECT ab.account_id, ab.asset_id, ab.balance,
         COALESCE((SELECT SUM(l.amount) FROM ledger.journal_leg l
                    WHERE l.account_id = ab.account_id AND l.asset_id = ab.asset_id), 0)
    FROM ledger.account_balance ab
   WHERE ab.balance <> COALESCE((SELECT SUM(l.amount) FROM ledger.journal_leg l
                    WHERE l.account_id = ab.account_id AND l.asset_id = ab.asset_id), 0);
$$;

-- ----------------------------------------------------------------------------
-- §10  The write surface
-- ----------------------------------------------------------------------------
-- ONE function. Every money-moving and every auditable action goes through it.
-- SECURITY DEFINER, owned by a role that can write `ledger`; the application
-- role cannot (§11). The lock ordering below is therefore the only lock
-- ordering in the system, which is what makes "deadlock free" a property you
-- can verify by reading one function instead of auditing every call site.
--
-- Returns the posted entry as jsonb, including whether this was a replay.
-- One network round trip per operation. That is the performance design: an
-- ORM-orchestrated version of accept_bid is 8-10 round trips, which is
-- 250-350ms of pure latency from Vercel before any work happens, against a
-- 500-2000ms budget that also has to absorb a cold start.

CREATE FUNCTION ledger.post(p_command jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_key         uuid  := (p_command->>'idempotencyKey')::uuid;
  v_fingerprint bytea := digest(p_command->'intent'::text, 'sha256');
  v_entry       ledger.journal_entry;
BEGIN
  -- TODO 1. IDEMPOTENCY GATE, before any lock is taken.
  --   INSERT INTO ledger.journal_entry (idempotency_key, request_fingerprint, ...)
  --   VALUES (v_key, v_fingerprint, ...)
  --   ON CONFLICT (idempotency_key) DO NOTHING
  --   RETURNING * INTO v_entry;
  --   IF v_entry IS NULL THEN
  --     SELECT * INTO v_entry FROM ledger.journal_entry WHERE idempotency_key = v_key;
  --     IF v_entry.request_fingerprint <> v_fingerprint THEN
  --       RAISE EXCEPTION ... USING ERRCODE = 'ADA10';   -- key reuse, different intent
  --     END IF;
  --     RETURN ledger.render_entry(v_entry) || jsonb_build_object('replayed', true);
  --   END IF;
  -- Taking the unique-key insert FIRST means two concurrent replays of the
  -- same command serialise on the unique index, not on the accounts: the
  -- loser blocks, then sees the winner's row and returns the same receipt.

  -- TODO 2. RESOLVE the intent into (a) the rows to lock and (b) the legs to
  -- post. For settle_maturity the leg set is not knowable until the holder
  -- accounts are locked, so resolution happens *after* step 3 for that kind.

  -- TODO 3. LOCK, in one total order. Deadlock freedom is the ordering, and
  -- the ordering is here and nowhere else:
  --     3a. app.payable      rows, ORDER BY id, FOR NO KEY UPDATE
  --     3b. app.series       rows, ORDER BY id, FOR NO KEY UPDATE
  --     3c. app.listing      rows, ORDER BY id, FOR UPDATE
  --     3d. INSERT INTO ledger.account_balance (account_id, asset_id, class, balance)
  --         SELECT ... ORDER BY account_id, asset_id ON CONFLICT DO NOTHING;
  --     3e. SELECT 1 FROM ledger.account_balance
  --          WHERE (account_id, asset_id) IN (...) ORDER BY account_id, asset_id
  --          FOR UPDATE;
  -- 3d creates any missing (account, asset) row so 3e always finds one — a
  -- first-time holder has no balance row to lock, and "lock a row that does
  -- not exist yet" is the classic hole in this pattern.
  -- FOR NO KEY UPDATE on parents so child FK inserts do not block on them.
  -- The world row is deliberately NOT locked: a fast-forward concurrent with
  -- a trade may land either side of it, and both outcomes are legal.

  -- TODO 4. RECHECK under lock, per PRD §9 "recheck balance, ownership,
  -- listed quantity, listing status, and maturity when a seller accepts".
  -- The TypeScript pre-checks exist to produce good inline messages; these
  -- are the authoritative ones. Each raises a distinct SQLSTATE that
  -- ledger/post.ts maps to a PostFailure variant:
  --   ADA11 listing_not_open     ADA12 past_maturity
  --   ADA13 stale_owner          ADA14 series_not_whole_lot
  --   ADA15 not_permitted        ADA16 already_settled
  --   ADA22 duplicate_invoice    ADA23 invalid_terms
  --   ADA24 unknown_supplier     ADA25 missing_invoice_ref
  --   ADA26 duplicate_reference
  -- ADA22 to ADA26 exist because PRD §8 screen 2's manual entry is the first
  -- form a person types into freely. Folding them into not_permitted would
  -- tell a preparer who mistyped an invoice number that they lack permission,
  -- which is both wrong and unactionable.
  -- Insufficient funds and over-quantity transfers need no explicit check:
  -- the CHECK in §4 raises 23514 when the leg lands, which post.ts maps to
  -- insufficient_funds / insufficient_unlisted_quantity using the leg's asset
  -- kind. Fewer checks to forget.

  -- TODO 5. APPLY side effects on app.* (listing.status, bid.status,
  -- payable.lifecycle_status). The lifecycle trigger in §5 vets transitions.

  -- TODO 6. INSERT the legs. The §8 triggers project balances, and at COMMIT
  -- assert per-asset balance, escrow equality and conservation. If any fails
  -- the whole operation vanishes: no partial trade, no orphaned escrow.

  -- TODO 7. ATTACH the chain result.
  --   mock:    chain_status='confirmed', tx hash = sha256(idempotency_key),
  --            block number = seq. Same transaction, deterministic.
  --   sepolia: chain_status='pending'; the indexer confirms later.

  RAISE EXCEPTION 'not implemented';
END $$;

-- ----------------------------------------------------------------------------
-- §11  Grants — what makes §0 true
-- ----------------------------------------------------------------------------
-- Roles are cluster-level, so creation must be idempotent across re-seeds.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'adata_app') THEN
    CREATE ROLE adata_app NOLOGIN;
  END IF;
END $$;
GRANT USAGE ON SCHEMA app, ledger TO adata_app;
GRANT SELECT ON ALL TABLES IN SCHEMA app, ledger TO adata_app;
-- The application may write the things it owns outright...
GRANT INSERT, UPDATE ON app.entity, app.app_user, app.wallet, app.payable TO adata_app;
-- ...and nothing in the ledger. No INSERT on journal_entry, no UPDATE on
-- account_balance, ever. The only path is ledger.post(), which is
-- SECURITY DEFINER and therefore runs as its owner.
REVOKE ALL ON ledger.journal_entry, ledger.journal_leg, ledger.account_balance,
              ledger.account, ledger.asset FROM adata_app;
GRANT SELECT ON ledger.journal_entry, ledger.journal_leg, ledger.account_balance,
                ledger.account, ledger.asset TO adata_app;
GRANT EXECUTE ON FUNCTION ledger.post(jsonb) TO adata_app;
GRANT EXECUTE ON FUNCTION ledger.prove_books_balance() TO adata_app;

-- ----------------------------------------------------------------------------
-- §12  Schema self-test — run in CI
-- ----------------------------------------------------------------------------
-- INVARIANT: no floating point or arbitrary-precision decimal anywhere in the
-- money path. This is the structural version of "don't use floats": a
-- contributor who adds `price numeric` fails the build, they do not get a
-- review comment. token_id is the sole numeric(78,0) and is never arithmetic.
--
-- The scan deliberately covers VIEWS as well as tables: SUM(bigint) yields
-- numeric, so an aggregate that forgets its ::bigint cast is the most likely
-- way a string-typed money value ever reaches the driver.
--
--   SELECT table_schema, table_name, column_name, data_type
--     FROM information_schema.columns
--    WHERE table_schema IN ('app','ledger')
--      AND data_type IN ('double precision','real','numeric')
--      AND NOT (table_name = 'asset' AND column_name = 'token_id');
--   -- must return zero rows

-- ----------------------------------------------------------------------------
-- §13  ERP mock
-- ----------------------------------------------------------------------------
-- PRD §8 screen 2: "Import from ERP. The import uses a clearly simulated
-- SAP-style picker and select from a list of 10 different sample invoice
-- pre-generated for the demo."
--
-- These are approved invoices that have NOT yet become payables. They are
-- reference data for the create-payable screen, deliberately outside the
-- ledger: nothing here has a token, a holder or a balance. `consumed_by` is set
-- when a preparer turns one into a payable, so the picker can grey it out
-- instead of letting the same invoice be issued twice.
CREATE TABLE app.erp_invoice (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  doc_no         text NOT NULL UNIQUE,          -- SAP-style document number
  supplier_id    uuid NOT NULL REFERENCES app.entity(id),
  invoice_ref    text NOT NULL,
  amount_base    bigint NOT NULL CHECK (amount_base > 0),
  terms_days     integer NOT NULL CHECK (terms_days BETWEEN 30 AND 180),
  -- PRD §5: "The scenario uses ADATA payment terms of 30-180 days."
  approved_on    date NOT NULL,
  cost_centre    text NOT NULL,
  consumed_by    uuid REFERENCES app.payable(id),
  UNIQUE (consumed_by)                          -- one invoice becomes at most one payable
);
CREATE INDEX erp_invoice_available ON app.erp_invoice(doc_no) WHERE consumed_by IS NULL;
GRANT SELECT, INSERT, UPDATE ON app.erp_invoice TO adata_app;
