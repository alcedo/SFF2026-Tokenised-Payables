/**
 * The read model. One function per screen, and no other way to display data.
 *
 * Two rules hold throughout.
 *
 * Nothing time-derived is stored, so every function that shows a day count or a
 * yield takes the clock and derives them. The schema's views never call `now()`
 * for the same reason: a demo whose clock can jump ninety days cannot afford a
 * cached tenor.
 *
 * Money arrives as `bigint` and stays that way. These functions return base
 * units, not formatted strings, so a screen decides its own precision (PRD §6
 * asks for two decimals in summaries and four in detail) and the pricing module
 * stays the only place a yield is computed.
 */

import { query, queryOne } from './client';
import { type DemoClock, clockAt, daysBetween, type IsoDate, parseIsoDate, today } from '@/core/clock';
import { type Asset, type BaseUnits, fromBaseUnits } from '@/core/money';
import { type LifecycleStatus, dueStatusFor, isOverdueByClock, type ReceiptStatus, type Role } from '@/core/lifecycle';
import { type Quote, quote } from '@/core/pricing';

// --- the world --------------------------------------------------------------

export interface World {
  clock: DemoClock;
  today: IsoDate;
  /** XSGD per 1 XUSD, scaled by 1e6. */
  xsgdPerXusdE6: bigint;
  /** Bumped by a reset, so an open tab can tell the world changed under it. */
  epoch: bigint;
}

export async function readWorld(): Promise<World> {
  const row = await queryOne<{
    t0: Date;
    offset_days: number;
    xsgd_per_xusd_e6: bigint;
    epoch: bigint;
  }>('SELECT t0, offset_days, xsgd_per_xusd_e6, epoch FROM app.world');
  if (!row) throw new Error('no world row; run scripts/db.sh reset');

  const clock = clockAt(parseIsoDate(row.t0.toISOString().slice(0, 10)), row.offset_days);
  return { clock, today: today(clock), xsgdPerXusdE6: row.xsgd_per_xusd_e6, epoch: row.epoch };
}

// --- personas ---------------------------------------------------------------

export interface Persona {
  userId: string;
  name: string;
  role: Role;
  entityId: string;
  entityName: string;
  entityType: 'anchor' | 'supplier' | 'lender' | 'platform';
  wallet: string;
  institutionalEligible: boolean;
}

/** Everyone the demo-controls switcher can become. PRD §11. */
export async function readPersonas(): Promise<Persona[]> {
  return (
    await query<{
      user_id: string;
      name: string;
      role: Persona['role'];
      entity_id: string;
      entity_name: string;
      entity_type: Persona['entityType'];
      wallet: string;
      institutional_eligible: boolean;
    }>(`
    SELECT u.id AS user_id, u.name, u.role, e.id AS entity_id, e.name AS entity_name,
           e.entity_type, w.address AS wallet, u.institutional_eligible
      FROM app.app_user u
      JOIN app.entity e ON e.id = u.entity_id
      JOIN app.wallet w ON w.entity_id = e.id
     WHERE u.deactivated_at IS NULL
     ORDER BY CASE e.entity_type
                WHEN 'anchor' THEN 1 WHEN 'supplier' THEN 2
                WHEN 'lender' THEN 3 ELSE 4 END, u.name`)
  ).map((r) => ({
    userId: r.user_id,
    name: r.name,
    role: r.role,
    entityId: r.entity_id,
    entityName: r.entity_name,
    entityType: r.entity_type,
    wallet: r.wallet,
    institutionalEligible: r.institutional_eligible,
  }));
}

// --- entities ---------------------------------------------------------------

export interface EntityRow {
  id: string;
  name: string;
  entityType: 'anchor' | 'supplier' | 'lender' | 'platform';
  certification: 'uncertified' | 'certified' | 'suspended';
  wallet: string | null;
  userCount: number;
}

/**
 * Counterparties on the platform. PRD §5 and §8 screens 2, 5 and 14.
 *
 * One function rather than one per screen, because "the suppliers", "the
 * lenders" and "everyone" are the same question with a different argument, and
 * three near-identical queries would be three places to fix a join.
 */
export async function readEntities(
  type?: EntityRow['entityType'],
): Promise<EntityRow[]> {
  return (
    await query<{
      id: string;
      name: string;
      entity_type: EntityRow['entityType'];
      certification_status: EntityRow['certification'];
      wallet: string | null;
      user_count: bigint;
    }>(
      `SELECT e.id, e.name, e.entity_type, e.certification_status,
              (SELECT w.address FROM app.wallet w WHERE w.entity_id = e.id LIMIT 1) AS wallet,
              (SELECT count(*) FROM app.app_user u
                WHERE u.entity_id = e.id AND u.deactivated_at IS NULL)::bigint AS user_count
         FROM app.entity e
        WHERE ($1::text IS NULL OR e.entity_type::text = $1)
        ORDER BY e.name`,
      [type ?? null],
    )
  ).map((r) => ({
    id: r.id,
    name: r.name,
    entityType: r.entity_type,
    certification: r.certification_status,
    wallet: r.wallet,
    userCount: Number(r.user_count),
  }));
}

export interface UserRow {
  userId: string;
  name: string;
  role: 'adata_preparer' | 'adata_checker' | 'supplier' | 'lender' | 'straitsx_admin';
  entityId: string;
  entityName: string;
  entityType: 'anchor' | 'supplier' | 'lender' | 'platform';
  wallet: string | null;
  kycVerified: boolean;
  institutionalEligible: boolean;
  /** Journal entries this user is the actor on. PRD §5's delete needs it. */
  actions: number;
  /** Whether removing this account would strand its organisation's wallet. */
  isOnlyUserOfEntity: boolean;
}

/** Everyone with an account. PRD §5's admin view, which readPersonas is not. */
export async function readUsers(): Promise<UserRow[]> {
  return (
    await query<{
      user_id: string;
      name: string;
      role: UserRow['role'];
      entity_id: string;
      entity_name: string;
      entity_type: UserRow['entityType'];
      wallet: string | null;
      mock_kyc_verified: boolean;
      institutional_eligible: boolean;
      actions: bigint;
      peers: bigint;
    }>(`
    SELECT u.id AS user_id, u.name, u.role, e.id AS entity_id, e.name AS entity_name,
           e.entity_type, u.mock_kyc_verified, u.institutional_eligible,
           (SELECT w.address FROM app.wallet w WHERE w.entity_id = e.id LIMIT 1) AS wallet,
           (SELECT count(*) FROM ledger.journal_entry j
             WHERE j.actor_user_id = u.id)::bigint AS actions,
           (SELECT count(*) FROM app.app_user p
             WHERE p.entity_id = e.id AND p.id <> u.id AND p.deactivated_at IS NULL)::bigint AS peers
      FROM app.app_user u
      JOIN app.entity e ON e.id = u.entity_id
     WHERE u.deactivated_at IS NULL
     ORDER BY CASE e.entity_type
                WHEN 'anchor' THEN 1 WHEN 'supplier' THEN 2
                WHEN 'lender' THEN 3 ELSE 4 END, e.name, u.name`)
  ).map((r) => ({
    userId: r.user_id,
    name: r.name,
    role: r.role,
    entityId: r.entity_id,
    entityName: r.entity_name,
    entityType: r.entity_type,
    wallet: r.wallet,
    kycVerified: r.mock_kyc_verified,
    institutionalEligible: r.institutional_eligible,
    actions: Number(r.actions),
    isOnlyUserOfEntity: Number(r.peers) === 0,
  }));
}

// --- wallets ----------------------------------------------------------------

export type Balances = Record<Asset, BaseUnits>;

/**
 * The same four balances as strings, for a client component. bigint cannot
 * cross the server-to-client boundary, and typing the map by Asset means a
 * panel cannot be handed three balances and quietly read the fourth as zero.
 */
export type SerialBalances = Record<Asset, string>;

export function serializeBalances(b: Balances): SerialBalances {
  return { XUSD: b.XUSD.toString(), USDC: b.USDC.toString(), USDT: b.USDT.toString(), XSGD: b.XSGD.toString() };
}

const ZERO_BALANCES = (): Balances => ({
  XUSD: 0n as BaseUnits,
  USDC: 0n as BaseUnits,
  USDT: 0n as BaseUnits,
  XSGD: 0n as BaseUnits,
});

/** All four balances for a wallet. PRD §10 shows them together, always. */
export async function readBalances(wallet: string): Promise<Balances> {
  const rows = await query<{ cash_code: Asset; balance: bigint }>(
    `SELECT s.cash_code, b.balance
       FROM ledger.account_balance b
       JOIN ledger.account a ON a.id = b.account_id
       JOIN ledger.asset   s ON s.id = b.asset_id
      WHERE a.wallet_address = $1 AND a.purpose = 'wallet_free' AND s.kind = 'cash'`,
    [wallet],
  );
  const out = ZERO_BALANCES();
  for (const r of rows) out[r.cash_code] = fromBaseUnits(r.balance);
  return out;
}

// --- payables ---------------------------------------------------------------

export interface PayableRow {
  id: string;
  ref: string;
  invoiceRef: string;
  anchorName: string;
  supplierName: string;
  faceBase: BaseUnits;
  outstandingBase: BaseUnits;
  issueDate: IsoDate | null;
  maturityDate: IsoDate;
  grade: 'AAA' | 'AA' | 'A' | null;
  gradeRationale: string | null;
  tokenId: string | null;
  seriesRef: string | null;
  /** Stored state, before the clock is applied. */
  storedStatus: LifecycleStatus;
  /** Whether the first holder has taken delivery. PRD section 3 question 7. */
  receipt: ReceiptStatus | null;
  /** What the clock says it is now. This is what a screen shows. */
  status: LifecycleStatus;
  daysRemaining: number;
  tenorDays: number | null;
}

const PAYABLE_SELECT = `
  SELECT p.id, p.ref, p.invoice_ref, p.face_base, p.issue_date, p.maturity_date,
         p.grade, p.grade_rationale, p.lifecycle_status, p.receipt_status,
         anchor.name AS anchor_name, supplier.name AS supplier_name,
         ast.token_id::text AS token_id, s.ref AS series_ref,
         COALESCE(sup.outstanding_base, 0) AS outstanding_base
    FROM app.payable p
    JOIN app.entity anchor   ON anchor.id = p.anchor_id
    JOIN app.entity supplier ON supplier.id = p.original_supplier_id
    LEFT JOIN app.series s   ON s.id = p.series_id
    LEFT JOIN ledger.asset ast ON ast.payable_id = p.id
    LEFT JOIN ledger.v_payable_supply sup ON sup.payable_id = p.id`;

interface RawPayable {
  id: string;
  ref: string;
  invoice_ref: string;
  face_base: bigint;
  issue_date: Date | null;
  maturity_date: Date;
  grade: 'AAA' | 'AA' | 'A' | null;
  grade_rationale: string | null;
  lifecycle_status: LifecycleStatus;
  receipt_status: ReceiptStatus | null;
  anchor_name: string;
  supplier_name: string;
  token_id: string | null;
  series_ref: string | null;
  outstanding_base: bigint;
}

function toPayable(r: RawPayable, world: World): PayableRow {
  const maturity = parseIsoDate(r.maturity_date.toISOString().slice(0, 10));
  const issue = r.issue_date ? parseIsoDate(r.issue_date.toISOString().slice(0, 10)) : null;
  const days = daysBetween(world.today, maturity);
  // Maturity and overdue are functions of the clock, never stored. This is the
  // one place they are applied, so no screen can disagree with another.
  const clockStatus = dueStatusFor(r.lifecycle_status, days);
  const status = isOverdueByClock(clockStatus, days) ? 'overdue' : clockStatus;

  return {
    id: r.id,
    ref: r.ref,
    invoiceRef: r.invoice_ref,
    anchorName: r.anchor_name,
    supplierName: r.supplier_name,
    faceBase: fromBaseUnits(r.face_base),
    outstandingBase: fromBaseUnits(r.outstanding_base),
    issueDate: issue,
    maturityDate: maturity,
    grade: r.grade,
    gradeRationale: r.grade_rationale,
    tokenId: r.token_id,
    seriesRef: r.series_ref,
    storedStatus: r.lifecycle_status,
    receipt: r.receipt_status,
    status,
    daysRemaining: days,
    tenorDays: issue ? daysBetween(issue, maturity) : null,
  };
}

export async function readPayables(world: World): Promise<PayableRow[]> {
  const rows = await query<RawPayable>(`${PAYABLE_SELECT} WHERE p.series_id IS NULL ORDER BY p.ref`);
  return rows.map((r) => toPayable(r, world));
}

export async function readPayable(id: string, world: World): Promise<PayableRow | null> {
  const row = await queryOne<RawPayable>(`${PAYABLE_SELECT} WHERE p.id = $1`, [id]);
  return row ? toPayable(row, world) : null;
}

/**
 * The invoices inside a series lot. PRD §8 screen 10: "Expand a Series to
 * inspect its members."
 *
 * Each member carries its own holder, because §13 requires every member of a
 * series to be wholly held by one wallet. Showing the holder per row is what
 * makes that rule visible rather than asserted: a lender can see for
 * themselves that the lot is not a stack of fragments.
 */
export interface SeriesMember extends PayableRow {
  holderName: string | null;
  holderWallet: string | null;
}

export async function readSeriesMembers(
  seriesId: string,
  world: World,
): Promise<SeriesMember[]> {
  const rows = await query<RawPayable & { holder_name: string | null; holder_wallet: string | null }>(
    `SELECT sub.*,
            (SELECT e2.name FROM ledger.v_holding h
               JOIN app.wallet w2 ON w2.address = h.wallet_address
               JOIN app.entity e2 ON e2.id = w2.entity_id
              WHERE h.payable_id = sub.id
              ORDER BY h.quantity_base DESC LIMIT 1)           AS holder_name,
            (SELECT h.wallet_address FROM ledger.v_holding h
              WHERE h.payable_id = sub.id
              ORDER BY h.quantity_base DESC LIMIT 1)           AS holder_wallet
       FROM (${PAYABLE_SELECT} WHERE p.series_id = $1) sub
      ORDER BY sub.ref`,
    [seriesId],
  );
  return rows.map((r) => ({
    ...toPayable(r, world),
    holderName: r.holder_name,
    holderWallet: r.holder_wallet,
  }));
}

// --- holdings ---------------------------------------------------------------

export interface Holder {
  wallet: string;
  entityName: string;
  quantityBase: BaseUnits;
  freeBase: BaseUnits;
  listedBase: BaseUnits;
}

/** PRD §6 shows the holder breakdown on the detail screen. */
export async function readHolders(payableId: string): Promise<Holder[]> {
  return (
    await query<{
      wallet_address: string;
      entity_name: string;
      quantity_base: bigint;
      free_base: bigint;
      listed_base: bigint;
    }>(
      `SELECT h.wallet_address, e.name AS entity_name, h.quantity_base, h.free_base, h.listed_base
         FROM ledger.v_holding h
         JOIN app.wallet w ON w.address = h.wallet_address
         JOIN app.entity e ON e.id = w.entity_id
        WHERE h.payable_id = $1
        ORDER BY h.quantity_base DESC`,
      [payableId],
    )
  ).map((r) => ({
    wallet: r.wallet_address,
    entityName: r.entity_name,
    quantityBase: fromBaseUnits(r.quantity_base),
    freeBase: fromBaseUnits(r.free_base),
    listedBase: fromBaseUnits(r.listed_base),
  }));
}

export interface HoldingRow {
  payable: PayableRow;
  quantityBase: BaseUnits;
  freeBase: BaseUnits;
  listedBase: BaseUnits;
  /** Present once this wallet bought the position. Null for the first holder. */
  costBase: BaseUnits | null;
  receipt: ReceiptStatus;
}

/**
 * Everything one wallet holds. Serves the supplier's inbox (PRD §8 screen 6)
 * and the lender's portfolio (screen 12); they differ in presentation, not in
 * the question being asked.
 */
export async function readHoldings(wallet: string, world: World): Promise<HoldingRow[]> {
  const rows = await query<RawPayable & { quantity_base: bigint; free_base: bigint; listed_base: bigint; cost_base: bigint | null }>(
    `${PAYABLE_SELECT.replace('SELECT p.id', 'SELECT h.quantity_base, h.free_base, h.listed_base, t.cost_base, p.id')}
       JOIN ledger.v_holding h ON h.payable_id = p.id AND h.wallet_address = $1
       LEFT JOIN LATERAL (
         SELECT tr.price_base AS cost_base FROM ledger.v_trade tr
          WHERE tr.payable_id = p.id AND tr.buyer_wallet = $1
          ORDER BY tr.seq DESC LIMIT 1
       ) t ON true
      ORDER BY p.maturity_date`,
    [wallet],
  );
  return rows.map((r) => ({
    payable: toPayable(r, world),
    quantityBase: fromBaseUnits(r.quantity_base),
    freeBase: fromBaseUnits(r.free_base),
    listedBase: fromBaseUnits(r.listed_base),
    costBase: r.cost_base === null ? null : fromBaseUnits(r.cost_base),
    receipt: r.receipt_status ?? 'accepted',
  }));
}

// --- the marketplace --------------------------------------------------------

export interface Listing {
  id: string;
  targetKind: 'payable' | 'series';
  targetRef: string;
  targetId: string;
  sellerWallet: string;
  sellerName: string;
  anchorName: string;
  grade: 'AAA' | 'AA' | 'A' | null;
  gradeRationale: string | null;
  /** Face of the listed quantity, which may be less than the invoice face. */
  listedFaceBase: BaseUnits;
  /** Original invoice face, shown alongside when they differ (PRD §9). */
  invoiceFaceBase: BaseUnits;
  askBase: BaseUnits;
  buyNowBase: BaseUnits | null;
  maturityDate: IsoDate;
  memberCount: number;
  bidCount: number;
  topBidBase: BaseUnits | null;
  /** The whole §6 economics for this lot, computed once. */
  quote: Quote;
}

const LISTING_SELECT = `
  SELECT li.id, li.target_kind, li.seller_wallet, li.min_price_base, li.buy_now_price_base,
         COALESCE(p.ref, s.ref)                       AS target_ref,
         COALESCE(p.id::text, s.id::text)             AS target_id,
         COALESCE(p.maturity_date, s.maturity_date)   AS maturity_date,
         COALESCE(p.grade::text, s.grade::text)       AS grade,
         COALESCE(p.grade_rationale, s.grade_rationale) AS grade_rationale,
         COALESCE(p.face_base, sv.face_base)          AS invoice_face_base,
         COALESCE(sv.member_count, 1)                 AS member_count,
         seller.name                                  AS seller_name,
         anchor.name                                  AS anchor_name,
         (SELECT SUM(ll.quantity_base)::bigint FROM app.listing_leg ll
           WHERE ll.listing_id = li.id)               AS listed_face_base,
         (SELECT count(*)::bigint FROM app.bid b
           WHERE b.listing_id = li.id AND b.status = 'placed') AS bid_count,
         (SELECT max(b.price_base) FROM app.bid b
           WHERE b.listing_id = li.id AND b.status = 'placed') AS top_bid_base
    FROM app.listing li
    LEFT JOIN app.payable p  ON p.id = li.target_payable_id
    LEFT JOIN app.series  s  ON s.id = li.target_series_id
    LEFT JOIN ledger.v_series sv ON sv.id = s.id
    JOIN app.wallet sw       ON sw.address = li.seller_wallet
    JOIN app.entity seller   ON seller.id = sw.entity_id
    JOIN app.entity anchor   ON anchor.id = COALESCE(p.anchor_id, s.anchor_id)`;

interface RawListing {
  id: string;
  target_kind: 'payable' | 'series';
  target_ref: string;
  target_id: string;
  seller_wallet: string;
  seller_name: string;
  anchor_name: string;
  grade: 'AAA' | 'AA' | 'A' | null;
  grade_rationale: string | null;
  listed_face_base: bigint;
  invoice_face_base: bigint;
  min_price_base: bigint;
  buy_now_price_base: bigint | null;
  maturity_date: Date;
  member_count: bigint;
  bid_count: bigint;
  top_bid_base: bigint | null;
}

function toListing(r: RawListing, world: World): Listing {
  const maturity = parseIsoDate(r.maturity_date.toISOString().slice(0, 10));
  const listedFace = fromBaseUnits(r.listed_face_base);
  const ask = fromBaseUnits(r.min_price_base);
  return {
    id: r.id,
    targetKind: r.target_kind,
    targetRef: r.target_ref,
    targetId: r.target_id,
    sellerWallet: r.seller_wallet,
    sellerName: r.seller_name,
    anchorName: r.anchor_name,
    grade: r.grade,
    gradeRationale: r.grade_rationale,
    listedFaceBase: listedFace,
    invoiceFaceBase: fromBaseUnits(r.invoice_face_base),
    askBase: ask,
    buyNowBase: r.buy_now_price_base === null ? null : fromBaseUnits(r.buy_now_price_base),
    maturityDate: maturity,
    memberCount: Number(r.member_count),
    bidCount: Number(r.bid_count),
    topBidBase: r.top_bid_base === null ? null : fromBaseUnits(r.top_bid_base),
    // `F` is the listed quantity's face, not the invoice face. PRD §6.
    quote: quote(listedFace, ask, daysBetween(world.today, maturity)),
  };
}

/** PRD §9: default sort is yield. */
export async function readMarketplace(world: World): Promise<Listing[]> {
  const rows = await query<RawListing>(`${LISTING_SELECT} WHERE li.status = 'open'`);
  return rows
    .map((r) => toListing(r, world))
    .sort((a, b) => (b.quote.lenderYieldPercent ?? -1) - (a.quote.lenderYieldPercent ?? -1));
}

export async function readListing(id: string, world: World): Promise<Listing | null> {
  const row = await queryOne<RawListing>(`${LISTING_SELECT} WHERE li.id = $1`, [id]);
  return row ? toListing(row, world) : null;
}

export async function readListingForTarget(targetId: string, world: World): Promise<Listing | null> {
  const row = await queryOne<RawListing>(
    `${LISTING_SELECT} WHERE li.status = 'open' AND li.target_id = $1`,
    [targetId],
  );
  return row ? toListing(row, world) : null;
}

// --- bids -------------------------------------------------------------------

export interface Bid {
  id: string;
  listingId: string;
  bidderWallet: string;
  bidderName: string;
  priceBase: BaseUnits;
  fundingAsset: Asset;
  status: 'placed' | 'accepted' | 'withdrawn' | 'superseded';
  /** Economics of this bid against the listed quantity. */
  quote: Quote;
}

/** PRD §8 screen 8: the offers a seller chooses between. */
export async function readBids(listingId: string, listedFace: BaseUnits, daysRemaining: number): Promise<Bid[]> {
  return (
    await query<{
      id: string;
      listing_id: string;
      bidder_wallet: string;
      bidder_name: string;
      price_base: bigint;
      funding_code: Asset;
      status: Bid['status'];
    }>(
      `SELECT b.id, b.listing_id, b.bidder_wallet, e.name AS bidder_name,
              b.price_base, b.funding_code, b.status
         FROM app.bid b
         JOIN app.wallet w ON w.address = b.bidder_wallet
         JOIN app.entity e ON e.id = w.entity_id
        WHERE b.listing_id = $1
        ORDER BY b.status = 'placed' DESC, b.price_base DESC`,
      [listingId],
    )
  ).map((r) => ({
    id: r.id,
    listingId: r.listing_id,
    bidderWallet: r.bidder_wallet,
    bidderName: r.bidder_name,
    priceBase: fromBaseUnits(r.price_base),
    fundingAsset: r.funding_code,
    status: r.status,
    quote: quote(listedFace, fromBaseUnits(r.price_base), daysRemaining),
  }));
}

// --- audit and receipts -----------------------------------------------------

export interface EventRow {
  entryId: string;
  seq: bigint;
  kind: string;
  worldDate: IsoDate;
  actorName: string;
  actorRole: Role;
  payableRef: string | null;
  txHash: string | null;
  blockNumber: bigint | null;
  fundingAsset: Asset | null;
  sourceAmountBase: BaseUnits | null;
}

/**
 * The audit trail, and the mock explorer, from one query. PRD §10 requires a
 * receipt reopened from history to be identical to the one shown at
 * confirmation, which it is here because both read the same rows.
 */
export async function readEvents(
  opts: { payableId?: string; seriesId?: string; limit?: number } = {},
): Promise<EventRow[]> {
  const rows = await query<{
    entry_id: string;
    seq: bigint;
    kind: string;
    world_date: Date;
    actor_name: string;
    actor_role: Role;
    payable_ref: string | null;
    tx_hash: string | null;
    block_number: bigint | null;
    funding_code: Asset | null;
    source_amount_base: bigint | null;
  }>(
    `SELECT e.id AS entry_id, e.seq, e.kind::text, e.world_date,
            u.name AS actor_name, u.role::text AS actor_role,
            p.ref AS payable_ref,
            e.chain_tx_hash AS tx_hash, e.chain_block_number AS block_number,
            e.funding_code, e.source_amount_base
       FROM ledger.journal_entry e
       JOIN app.app_user u ON u.id = e.actor_user_id
       LEFT JOIN app.payable p ON p.id = e.payable_id
      WHERE ($1::uuid IS NULL OR e.payable_id = $1)
        AND ($2::uuid IS NULL
             OR e.series_id = $2
             -- A series lot's history is also everything that happened to its
             -- member invoices: each was created, approved and issued in its
             -- own right before the lot existed.
             OR p.series_id = $2)
      ORDER BY e.seq DESC
      LIMIT $3`,
    [opts.payableId ?? null, opts.seriesId ?? null, opts.limit ?? 100],
  );
  return rows.map((r) => ({
    entryId: r.entry_id,
    seq: r.seq,
    kind: r.kind,
    worldDate: parseIsoDate(r.world_date.toISOString().slice(0, 10)),
    actorName: r.actor_name,
    actorRole: r.actor_role,
    payableRef: r.payable_ref,
    txHash: r.tx_hash,
    blockNumber: r.block_number,
    fundingAsset: r.funding_code,
    sourceAmountBase: r.source_amount_base === null ? null : fromBaseUnits(r.source_amount_base),
  }));
}

export interface ReceiptMovement {
  legNo: number;
  direction: 'debit' | 'credit';
  amountBase: BaseUnits;
  accountPurpose: string;
  wallet: string | null;
  entityName: string | null;
  cashAsset: Asset | null;
  tokenId: string | null;
}

export interface SimulatedReceipt {
  simulated: true;
  txHash: string;
  blockNumber: bigint;
  status: 'confirmed' | 'failed';
  kind: string;
  worldDate: IsoDate;
  actorName: string;
  payableRef: string | null;
  fundingAsset: Asset | null;
  sourceAmountBase: BaseUnits | null;
  fxRateE6: bigint | null;
  movements: ReceiptMovement[];
}

/**
 * One mocked chain receipt, looked up by hash. Null when the hash is unknown
 * or the journal row is audit-only (no chain_tx_hash).
 */
export async function readSimulatedReceipt(txHash: string): Promise<SimulatedReceipt | null> {
  const rows = await query<{
    entry_id: string;
    seq: bigint;
    kind: string;
    world_date: Date;
    tx_hash: string;
    block_number: bigint;
    chain_status: 'confirmed' | 'failed';
    actor_name: string;
    payable_ref: string | null;
    funding_code: Asset | null;
    source_amount_base: bigint | null;
    fx_rate_e6: bigint | null;
    leg_no: number;
    amount: bigint;
    purpose: string;
    wallet_address: string | null;
    entity_name: string | null;
    cash_code: Asset | null;
    token_id: string | null;
  }>(
    `SELECT e.id AS entry_id, e.seq, e.kind::text, e.world_date,
            e.chain_tx_hash AS tx_hash, e.chain_block_number AS block_number,
            e.chain_status::text AS chain_status,
            u.name AS actor_name, p.ref AS payable_ref,
            e.funding_code, e.source_amount_base, e.fx_rate_e6,
            l.leg_no, l.amount, a.purpose::text AS purpose,
            a.wallet_address, ent.name AS entity_name,
            s.cash_code, s.token_id::text AS token_id
       FROM ledger.journal_entry e
       JOIN app.app_user u ON u.id = e.actor_user_id
       LEFT JOIN app.payable p ON p.id = e.payable_id
       JOIN ledger.journal_leg l ON l.entry_id = e.id
       JOIN ledger.account a ON a.id = l.account_id
       JOIN ledger.asset s ON s.id = l.asset_id
       LEFT JOIN app.entity ent ON ent.id = (
         SELECT w.entity_id FROM app.wallet w WHERE w.address = a.wallet_address
       )
      WHERE e.chain_tx_hash = $1
      ORDER BY l.leg_no`,
    [txHash],
  );
  const first = rows[0];
  if (!first) return null;
  return {
    simulated: true,
    txHash: first.tx_hash,
    blockNumber: first.block_number,
    status: first.chain_status,
    kind: first.kind,
    worldDate: parseIsoDate(first.world_date.toISOString().slice(0, 10)),
    actorName: first.actor_name,
    payableRef: first.payable_ref,
    fundingAsset: first.funding_code,
    sourceAmountBase:
      first.source_amount_base === null ? null : fromBaseUnits(first.source_amount_base),
    fxRateE6: first.fx_rate_e6,
    movements: rows.map((r) => ({
      legNo: Number(r.leg_no),
      direction: r.amount < 0n ? 'debit' : 'credit',
      amountBase: fromBaseUnits(r.amount < 0n ? -r.amount : r.amount),
      accountPurpose: r.purpose,
      wallet: r.wallet_address,
      entityName: r.entity_name,
      cashAsset: r.cash_code,
      tokenId: r.token_id,
    })),
  };
}

export interface SerialEventRow {
  entryId: string;
  seq: string;
  kind: string;
  worldDate: IsoDate;
  actorName: string;
  actorRole: Role;
  payableRef: string | null;
  txHash: string | null;
  blockNumber: string | null;
  fundingAsset: Asset | null;
  sourceAmountBase: string | null;
}

export function serializeEvent(e: EventRow): SerialEventRow {
  return {
    entryId: e.entryId,
    seq: String(e.seq),
    kind: e.kind,
    worldDate: e.worldDate,
    actorName: e.actorName,
    actorRole: e.actorRole,
    payableRef: e.payableRef,
    txHash: e.txHash,
    blockNumber: e.blockNumber === null ? null : String(e.blockNumber),
    fundingAsset: e.fundingAsset,
    sourceAmountBase: e.sourceAmountBase === null ? null : String(e.sourceAmountBase),
  };
}

export interface SerialReceipt {
  simulated: true;
  txHash: string;
  blockNumber: string;
  status: 'confirmed' | 'failed';
  kind: string;
  worldDate: IsoDate;
  actorName: string;
  payableRef: string | null;
  fundingAsset: Asset | null;
  sourceAmountBase: string | null;
  fxRateE6: string | null;
  movements: Array<{
    legNo: number;
    direction: 'debit' | 'credit';
    amountBase: string;
    accountPurpose: string;
    wallet: string | null;
    entityName: string | null;
    cashAsset: Asset | null;
    tokenId: string | null;
  }>;
}

export function serializeReceipt(r: SimulatedReceipt): SerialReceipt {
  return {
    simulated: true,
    txHash: r.txHash,
    blockNumber: String(r.blockNumber),
    status: r.status,
    kind: r.kind,
    worldDate: r.worldDate,
    actorName: r.actorName,
    payableRef: r.payableRef,
    fundingAsset: r.fundingAsset,
    sourceAmountBase: r.sourceAmountBase === null ? null : String(r.sourceAmountBase),
    fxRateE6: r.fxRateE6 === null ? null : String(r.fxRateE6),
    movements: r.movements.map((m) => ({
      ...m,
      amountBase: String(m.amountBase),
    })),
  };
}

// --- programme totals -------------------------------------------------------

export interface ProgrammeTotals {
  issuedCount: number;
  issuedFaceBase: BaseUnits;
  financedFaceBase: BaseUnits;
  unfinancedFaceBase: BaseUnits;
  settledFaceBase: BaseUnits;
  overdueFaceBase: BaseUnits;
  nextSettlementDate: IsoDate | null;
  /** Zero means the projection agrees with the journal on every row. */
  bookDrift: number;
}

/**
 * PRD §8 screen 1 and screen 16. Series members are counted once, as members;
 * the series itself is a grouping key and is never added on top.
 */
export async function readProgrammeTotals(world: World): Promise<ProgrammeTotals> {
  const payables = await query<RawPayable>(`${PAYABLE_SELECT}`);
  const rows = payables.map((r) => toPayable(r, world));

  const sum = (xs: PayableRow[]) => xs.reduce<bigint>((acc, p) => acc + p.faceBase, 0n) as BaseUnits;
  const live = rows.filter((p) => p.status === 'issued' || p.status === 'matured' || p.status === 'overdue');

  const financedIds = new Set(
    (
      await query<{ payable_id: string }>('SELECT DISTINCT payable_id FROM ledger.v_trade')
    ).map((r) => r.payable_id),
  );

  const upcoming = live
    .filter((p) => p.daysRemaining >= 0)
    .sort((a, b) => a.daysRemaining - b.daysRemaining);

  const drift = await queryOne<{ count: bigint }>(
    'SELECT count(*)::bigint AS count FROM ledger.prove_books_balance()',
  );

  return {
    issuedCount: live.length,
    issuedFaceBase: sum(live),
    financedFaceBase: sum(live.filter((p) => financedIds.has(p.id))),
    unfinancedFaceBase: sum(live.filter((p) => !financedIds.has(p.id))),
    settledFaceBase: sum(rows.filter((p) => p.status === 'settled')),
    overdueFaceBase: sum(rows.filter((p) => p.status === 'overdue')),
    nextSettlementDate: upcoming[0]?.maturityDate ?? null,
    bookDrift: Number(drift?.count ?? 0n),
  };
}

// --- the ERP inbox ----------------------------------------------------------

export interface ErpInvoice {
  id: string;
  docNo: string;
  supplierId: string;
  supplierName: string;
  invoiceRef: string;
  amountBase: BaseUnits;
  termsDays: number;
  approvedOn: IsoDate;
  costCentre: string;
  consumed: boolean;
}

/**
 * Every reference already in use, for the create screen's two suggestions.
 *
 * Deliberately not `readPayables()`. That is the priced marketplace projection
 * and it hides series members behind `series_id IS NULL`, so the
 * `TP-2026-05xx` refs in the seeded lot are invisible to it. A generator that
 * claims to continue the series has to see the whole table. An unconsumed ERP
 * row counts too: its invoice reference exists the moment someone imports it.
 */
export async function readReferencesInUse(): Promise<{
  payableRefs: string[];
  invoiceRefs: string[];
}> {
  const rows = await query<{ ref: string | null; invoice_ref: string }>(
    `SELECT ref, invoice_ref FROM app.payable
      UNION ALL
     SELECT NULL AS ref, invoice_ref FROM app.erp_invoice WHERE consumed_by IS NULL`,
  );
  return {
    payableRefs: rows.map((r) => r.ref).filter((r): r is string => r !== null),
    invoiceRefs: rows.map((r) => r.invoice_ref),
  };
}

export async function readErpInbox(): Promise<ErpInvoice[]> {
  return (
    await query<{
      id: string;
      doc_no: string;
      supplier_id: string;
      supplier_name: string;
      invoice_ref: string;
      amount_base: bigint;
      terms_days: number;
      approved_on: Date;
      cost_centre: string;
      consumed_by: string | null;
    }>(
      `SELECT i.id, i.doc_no, i.supplier_id, e.name AS supplier_name, i.invoice_ref,
              i.amount_base, i.terms_days, i.approved_on, i.cost_centre, i.consumed_by
         FROM app.erp_invoice i
         JOIN app.entity e ON e.id = i.supplier_id
        ORDER BY i.consumed_by IS NOT NULL, i.doc_no`,
    )
  ).map((r) => ({
    id: r.id,
    docNo: r.doc_no,
    supplierId: r.supplier_id,
    supplierName: r.supplier_name,
    invoiceRef: r.invoice_ref,
    amountBase: fromBaseUnits(r.amount_base),
    termsDays: r.terms_days,
    approvedOn: parseIsoDate(r.approved_on.toISOString().slice(0, 10)),
    costCentre: r.cost_centre,
    consumed: r.consumed_by !== null,
  }));
}
