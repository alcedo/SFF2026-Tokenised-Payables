/**
 * Model-based testing for workflow coverage.
 *
 * A payable's life is a state machine wrapped in a market, and most of its
 * interesting behaviour is a refusal: the command that arrives one state too
 * early, the bid on a listing that has already filled, the settlement of an
 * obligation that has not matured. A suite that only ever drives the happy path
 * never sees any of it.
 *
 * So this suite carries a second, much smaller implementation of the workflow:
 * an in-memory reducer over six maps, plus one `predict` per command saying
 * whether the ledger will accept it and which SQLSTATE it will refuse with.
 * fast-check generates command sequences without regard for legality, every
 * command runs against both, and the two are compared after every single step.
 *
 * The model is deliberately not a port of ledger.post(). Its whole state is
 * statuses and balances: it knows nothing of journal legs, receipts or lock
 * ordering, and funding is restricted to XUSD throughout so that no FX rounding
 * enters its arithmetic. Anything it cannot predict from those, it does not
 * compare.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fc from 'fast-check';
import {
  freshDatabase,
  ledgerHealth,
  post,
  actors,
  HEALTHY,
  type Database,
  type Role,
} from '../support/database';

// --- the world the model knows about ---------------------------------------

type LifecycleState =
  | 'draft'
  | 'pending_approval'
  | 'approved'
  | 'certified'
  | 'issued'
  | 'settled';

type ReceiptState = 'pending' | 'accepted' | 'rejected';
type ListingState = 'open' | 'filled' | 'cancelled' | 'closed_by_transfer';
type BidState = 'placed' | 'accepted' | 'withdrawn' | 'superseded';

const COMMAND_KINDS = [
  'create_payable', 'submit', 'approve', 'grade', 'certify', 'issue_payable',
  'accept_receipt', 'reject_receipt', 'top_up', 'transfer', 'publish_listing',
  'place_bid', 'withdraw_bid', 'accept_bid', 'buy_now', 'cancel_listing',
  'advance_clock', 'settle_maturity',
] as const;
type CommandKind = (typeof COMMAND_KINDS)[number];

/** A command that names no payable is counted against this pseudo-state. */
const NO_PAYABLE = 'none';

interface Wallet {
  readonly address: string;
  readonly label: string;
  readonly institutional: boolean;
}

/** Everything resolved out of the fixture world once, before any command runs. */
interface Real {
  readonly db: Database;
  readonly wallets: readonly Wallet[];
  readonly anchor: Wallet;
  readonly suppliers: readonly { id: string; name: string }[];
  readonly edges: ReadonlySet<string>;
  readonly programmeLimit: bigint;
  readonly actorsByRole: Readonly<Record<Role, string>>;
}

interface MPayable {
  ref: string;
  supplierId: string;
  face: bigint;
  maturity: number;
  status: LifecycleState;
  graded: boolean;
  receipt: ReceiptState | null;
  issuedTo: string | null;
}

interface MListing {
  payableId: string;
  seller: string;
  qty: bigint;
  minPrice: bigint;
  buyNow: bigint;
  status: ListingState;
}

interface MBid {
  id: string | null;
  listingId: string;
  bidder: string;
  price: bigint;
  status: BidState;
}

interface Model {
  day: number;
  seq: number;
  payables: Map<string, MPayable>;
  listings: Map<string, MListing>;
  bids: MBid[];
  /** Keyed exactly as the snapshot is: `${wallet}|${purpose}|${asset}`. */
  balances: Map<string, bigint>;
  refs: Set<string>;
  invoices: Set<string>;
}

// --- the observable state both sides render --------------------------------

interface Snapshot {
  day: number;
  payables: Record<string, string>;
  listings: Record<string, string>;
  bids: string[];
  balances: Record<string, string>;
}

const SNAPSHOT_SQL = `
  SELECT jsonb_build_object(
    'day', (SELECT offset_days FROM app.world WHERE only_row),
    'payables', COALESCE((
      SELECT jsonb_object_agg(p.id::text,
               p.lifecycle_status::text || '/' || COALESCE(p.receipt_status::text, 'none'))
        FROM app.payable p), '{}'::jsonb),
    'listings', COALESCE((
      SELECT jsonb_object_agg(l.id::text, l.status::text) FROM app.listing l), '{}'::jsonb),
    'bids', COALESCE((
      SELECT jsonb_agg(b.listing_id::text || '|' || b.bidder_wallet || '|'
                       || b.price_base::text || '|' || b.status::text)
        FROM app.bid b), '[]'::jsonb),
    'balances', COALESCE((
      SELECT jsonb_object_agg(s.k, s.v) FROM (
        SELECT a.wallet_address || '|' || a.purpose::text || '|'
               || COALESCE(ast.cash_code::text, ast.payable_id::text) AS k,
               ab.balance::text AS v
          FROM ledger.account_balance ab
          JOIN ledger.account a   ON a.id = ab.account_id
          JOIN ledger.asset   ast ON ast.id = ab.asset_id
         WHERE a.class = 'wallet' AND ab.balance <> 0) s), '{}'::jsonb)
  ) AS snap`;

async function observe(real: Real): Promise<Snapshot> {
  const { rows } = await real.db.pool.query<{ snap: Snapshot }>(SNAPSHOT_SQL);
  const snap = rows[0]!.snap;
  return { ...snap, bids: [...snap.bids].sort() };
}

function render(model: Model): Snapshot {
  const payables: Record<string, string> = {};
  for (const [id, p] of model.payables) payables[id] = `${p.status}/${p.receipt ?? 'none'}`;
  const listings: Record<string, string> = {};
  for (const [id, l] of model.listings) listings[id] = l.status;
  const balances: Record<string, string> = {};
  for (const [key, amount] of model.balances) {
    if (amount !== 0n) balances[key] = amount.toString();
  }
  const bids = model.bids
    .map((b) => `${b.listingId}|${b.bidder}|${b.price}|${b.status}`)
    .sort();
  return { day: model.day, payables, listings, bids, balances };
}

// --- balance helpers --------------------------------------------------------

type Purpose = 'wallet_free' | 'wallet_listed';
const XUSD = 'XUSD';

const key = (wallet: string, purpose: Purpose, asset: string) => `${wallet}|${purpose}|${asset}`;

function held(model: Model, wallet: string, purpose: Purpose, asset: string): bigint {
  return model.balances.get(key(wallet, purpose, asset)) ?? 0n;
}

function move(model: Model, wallet: string, purpose: Purpose, asset: string, delta: bigint): void {
  const k = key(wallet, purpose, asset);
  const next = (model.balances.get(k) ?? 0n) + delta;
  if (next === 0n) model.balances.delete(k);
  else model.balances.set(k, next);
}

// --- what the model predicts a command will do ------------------------------

type Verdict = { legal: true } | { legal: false; code: string; says: string };

const legal: Verdict = { legal: true };
const refuse = (code: string, says: string): Verdict => ({ legal: false, code, says });

// --- coverage ---------------------------------------------------------------

const coverage = {
  states: new Set<string>(),
  commands: new Set<string>(),
  pairs: new Set<string>(),
  verdicts: new Map<string, number>(),
  steps: 0,
};

function note(kind: CommandKind, state: string, verdict: Verdict): void {
  coverage.commands.add(kind);
  coverage.pairs.add(`${state}:${kind}`);
  coverage.steps += 1;
  const outcome = verdict.legal ? 'accepted' : verdict.code;
  coverage.verdicts.set(outcome, (coverage.verdicts.get(outcome) ?? 0) + 1);
}

/**
 * Pairs the command set cannot reach, with the reason each is impossible.
 * Reported alongside the hit count so a gap in coverage is either explained
 * here or is a real gap.
 */
function unreachablePairs(): string[] {
  const lifecycle: LifecycleState[] = [
    'draft', 'pending_approval', 'approved', 'certified', 'issued', 'settled',
  ];
  const out: string[] = [];
  // These name no payable, so they can only ever be counted against `none`.
  for (const kind of ['create_payable', 'top_up', 'advance_clock'] as const) {
    for (const state of lifecycle) out.push(`${state}:${kind}`);
  }
  // These name a payable that already exists, so `none` is impossible.
  for (const kind of [
    'submit', 'approve', 'grade', 'certify', 'issue_payable', 'accept_receipt',
    'reject_receipt', 'transfer', 'publish_listing', 'settle_maturity',
  ] as const) {
    out.push(`${NO_PAYABLE}:${kind}`);
  }
  // A listing escrows a payable token, and that token exists only from
  // issuance onward, so no listing or bid can name a pre-issuance payable.
  for (const kind of [
    'place_bid', 'withdraw_bid', 'accept_bid', 'buy_now', 'cancel_listing',
  ] as const) {
    for (const state of ['draft', 'pending_approval', 'approved', 'certified'] as const) {
      out.push(`${state}:${kind}`);
    }
  }
  // These three refuse to be generated at all until their referent exists, so
  // unlike cancel_listing and withdraw_bid they have no "names nothing" form.
  for (const kind of ['place_bid', 'accept_bid', 'buy_now'] as const) {
    out.push(`${NO_PAYABLE}:${kind}`);
  }
  return out;
}

// --- maker-checker roles -----------------------------------------------------

/**
 * The role app.lifecycle_edge names for each of the five edges, read here as a
 * fixed table rather than from the database, because the whole point of this
 * suite is a second implementation that predicts the first rather than a copy
 * of it.
 */
const EDGE_ROLE: Record<
  'submit' | 'approve' | 'certify' | 'issue_payable' | 'settle_maturity',
  Role
> = {
  submit: 'adata_preparer',
  approve: 'adata_checker',
  certify: 'straitsx_admin',
  issue_payable: 'straitsx_admin',
  settle_maturity: 'adata_preparer',
};

const ROLE_ORDER: readonly Role[] = [
  'adata_preparer', 'adata_checker', 'straitsx_admin', 'supplier', 'lender',
];

/** Some role other than the one named, chosen the same way every time. */
function wrongRoleFor(required: Role): Role {
  return ROLE_ORDER.find((role) => role !== required)!;
}

/**
 * The actor a hand-written setup sequence needs for one intent, so that a
 * fixture built out of raw `post()` calls still walks the lifecycle rather
 * than tripping ADA36 on its own scaffolding.
 */
function correctActor(real: Real, kind: string): string | undefined {
  const role = (EDGE_ROLE as Partial<Record<string, Role>>)[kind];
  return role ? real.actorsByRole[role] : undefined;
}

// --- commands ---------------------------------------------------------------

abstract class Step implements fc.AsyncCommand<Model, Real> {
  abstract readonly kind: CommandKind;

  /** Structural: can this command even be addressed in this state? */
  check(_model: Readonly<Model>): boolean {
    return true;
  }

  /** The lifecycle state this command is aimed at, for coverage accounting. */
  protected abstract subject(model: Model): string;

  protected abstract predict(model: Model, real: Real): Verdict;

  protected abstract intent(model: Model, real: Real): Record<string, unknown>;

  /** Applied to the model only when the ledger accepted the command. */
  protected abstract apply(model: Model, real: Real): Promise<void> | void;

  /** Who posts this command. Only the five role-gated edges override this. */
  protected actorFor(_model: Model, _real: Real): string | undefined {
    return undefined;
  }

  async run(model: Model, real: Real): Promise<void> {
    const verdict = this.predict(model, real);
    note(this.kind, this.subject(model), verdict);

    const result = await post(real.db.pool, this.intent(model, real), {
      actorUserId: this.actorFor(model, real),
    });
    const seen = result.ok
      ? { accepted: true, code: null as string | null }
      : { accepted: false, code: result.code ?? null };
    const want = verdict.legal
      ? { accepted: true, code: null as string | null }
      : { accepted: false, code: verdict.code };

    expect(
      seen,
      `${this} expected ${verdict.legal ? 'to be accepted' : `refusal ${verdict.code}`}` +
        `${result.ok ? '' : `, got ${result.code}: ${result.message}`}`,
    ).toEqual(want);

    if (!verdict.legal) expect(result.ok ? '' : result.message).toContain(verdict.says);
    else await this.apply(model, real);

    // Read off the model rather than the database, so a state the model failed
    // to predict can never be counted as covered.
    for (const payable of model.payables.values()) coverage.states.add(payable.status);

    expect(await observe(real), `state after ${this}`).toEqual(render(model));
  }
}

// -- helpers shared by the payable-addressing commands --

function nth<T>(items: T[], index: number): T {
  return items[index % items.length]!;
}

/**
 * What each command would need of its subject to be accepted, used only to
 * steer generation.
 *
 * Walking a six-deep lifecycle by drawing commands blind almost never gets past
 * approval, and the clock only moves forward, so a run either trades or matures
 * but never both. A guided command therefore looks for a payable that is ready
 * for it. The blind arm is kept precisely so the out-of-order commands still
 * fire: this table biases which sequences are generated, never which are judged
 * legal. Every verdict still comes from the model.
 */
type Aim = (payable: MPayable, model: Model) => boolean;

const AIMS: Partial<Record<CommandKind, Aim>> = {
  submit: (p) => p.status === 'draft',
  approve: (p) => p.status === 'pending_approval',
  grade: (p) => p.status === 'approved',
  certify: (p) => p.status === 'approved' && p.graded,
  issue_payable: (p, m) => p.status === 'certified' && m.day < p.maturity,
  accept_receipt: (p) => p.receipt === 'pending',
  reject_receipt: (p) => p.receipt === 'pending',
  transfer: (p, m) => p.status === 'issued' && p.receipt !== 'pending' && m.day < p.maturity,
  publish_listing: (p, m) => p.status === 'issued' && p.receipt !== 'pending' && m.day < p.maturity,
  settle_maturity: (p, m) => p.status === 'issued' && m.day >= p.maturity,
};

function payableAt(model: Model, index: number, aim: Aim | null = null): [string, MPayable] {
  const entries = [...model.payables.entries()];
  if (aim !== null) {
    const ready = entries.filter(([, p]) => aim(p, model));
    if (ready.length > 0) return nth(ready, index);
  }
  return nth(entries, index);
}

function aimed(
  model: Model,
  kind: CommandKind,
  index: number,
  guided: boolean,
): [string, MPayable] {
  return payableAt(model, index, guided ? AIMS[kind] ?? null : null);
}

function listingAt(model: Model, index: number, preferOpen = false): [string, MListing] {
  const entries = [...model.listings.entries()];
  if (preferOpen) {
    const open = entries.filter(([, l]) => l.status === 'open');
    if (open.length > 0) return nth(open, index);
  }
  return nth(entries, index);
}

function stateOfPayable(model: Model, kind: CommandKind, index: number, guided: boolean): string {
  return model.payables.size === 0 ? NO_PAYABLE : aimed(model, kind, index, guided)[1].status;
}

function stateBehindListing(model: Model, index: number, preferOpen: boolean): string {
  if (model.listings.size === 0) return NO_PAYABLE;
  const listing = listingAt(model, index, preferOpen)[1];
  return model.payables.get(listing.payableId)?.status ?? NO_PAYABLE;
}

/**
 * How a generated quantity relates to what the wallet actually holds.
 *
 * Drawing a raw number almost never lands on a holding, so every transfer and
 * listing would be refused for the same reason and the market would never open.
 * Sizing against the model keeps the legal cases legal without giving up the
 * over-quantity case that ADA21 exists for.
 */
type SizeMode = 'zero' | 'all' | 'half' | 'over' | 'one';

function sized(mode: SizeMode, holding: bigint): bigint {
  switch (mode) {
    case 'zero': return 0n;
    case 'one': return 1n;
    case 'over': return holding + 1n;
    // A wallet holding nothing would turn every one of these into a zero
    // quantity, and the whole generator would spend itself on ADA19. One base
    // unit against an empty wallet is the more interesting refusal: ADA21,
    // which names what the wallet actually holds.
    case 'all': return holding > 0n ? holding : 1n;
    case 'half': return holding > 1n ? holding / 2n : 1n;
  }
}

/** A wallet that actually holds the payable, or any wallet at all. */
function pickWallet(
  model: Model,
  real: Real,
  payableId: string,
  index: number,
  preferHolder: boolean,
): string {
  if (preferHolder) {
    const holders = real.wallets
      .filter((w) => held(model, w.address, 'wallet_free', payableId) > 0n)
      .map((w) => w.address);
    if (holders.length > 0) return nth(holders, index);
  }
  return nth([...real.wallets], index).address;
}

/** Total quantity of a payable a wallet holds, free and escrowed together. */
function position(model: Model, wallet: string, payableId: string): bigint {
  return held(model, wallet, 'wallet_free', payableId)
    + held(model, wallet, 'wallet_listed', payableId);
}

// -- create_payable --

type CreateFlaw = 'none' | 'dup_ref' | 'dup_invoice' | 'bad_supplier' | 'bad_terms'
  | 'bad_face' | 'empty_invoice';

const ABSENT_SUPPLIER = '00000000-0000-4000-8000-0000000000ff';

class CreatePayable extends Step {
  readonly kind = 'create_payable' as const;

  constructor(
    private readonly supplierIndex: number,
    private readonly face: bigint,
    private readonly terms: number,
    private readonly flaw: CreateFlaw,
  ) {
    super();
  }

  private supplier(model: Model, real: Real): string {
    if (this.flaw === 'bad_supplier') return ABSENT_SUPPLIER;
    return nth([...real.suppliers], this.supplierIndex).id;
  }

  private ref(model: Model): string {
    if (this.flaw === 'dup_ref' && model.refs.size > 0) return [...model.refs][0]!;
    return `MB-${model.seq}`;
  }

  private invoice(model: Model, real: Real): string {
    if (this.flaw === 'empty_invoice') return '   ';
    if (this.flaw === 'dup_invoice') {
      const supplier = this.supplier(model, real);
      const mine = [...model.invoices].filter((k) => k.startsWith(`${supplier}|`));
      if (mine.length > 0) return mine[0]!.slice(supplier.length + 1);
    }
    return `INV-${model.seq}`;
  }

  private facing(): bigint {
    return this.flaw === 'bad_face' ? 0n : this.face;
  }

  private terming(): number {
    return this.flaw === 'bad_terms' ? 0 : this.terms;
  }

  protected subject(): string {
    return NO_PAYABLE;
  }

  protected predict(model: Model, real: Real): Verdict {
    const supplier = this.supplier(model, real);
    if (supplier === ABSENT_SUPPLIER) return refuse('ADA24', 'no such supplier');
    if (this.invoice(model, real).trim() === '') {
      return refuse('ADA25', 'an invoice reference is required');
    }
    if (this.facing() <= 0n) {
      return refuse('ADA19', 'the face value must be greater than zero');
    }
    const terms = this.terming();
    if (terms < 1 || terms > 365) {
      return refuse('ADA23', 'payment terms must be between 1 and 365 days');
    }
    const invoice = this.invoice(model, real);
    if (model.invoices.has(`${supplier}|${invoice}`)) {
      return refuse('ADA22', `invoice ${invoice} has already been financed for this supplier`);
    }
    const ref = this.ref(model);
    if (model.refs.has(ref)) return refuse('ADA26', `reference ${ref} is already in use`);
    return legal;
  }

  protected intent(model: Model, real: Real): Record<string, unknown> {
    return {
      kind: 'create_payable',
      ref: this.ref(model),
      supplierId: this.supplier(model, real),
      invoiceRef: this.invoice(model, real),
      faceBase: this.facing().toString(),
      termsDays: this.terming(),
    };
  }

  protected async apply(model: Model, real: Real): Promise<void> {
    const ref = this.ref(model);
    const supplier = this.supplier(model, real);
    const invoice = this.invoice(model, real);
    // ledger.post() writes journal_entry.payable_id from the intent before the
    // payable exists, so a caller-chosen payableId is refused by that foreign
    // key. The id has to be read back instead.
    const { rows } = await real.db.pool.query<{ id: string }>(
      'SELECT id::text FROM app.payable WHERE ref = $1',
      [ref],
    );
    model.payables.set(rows[0]!.id, {
      ref,
      supplierId: supplier,
      face: this.facing(),
      maturity: model.day + this.terming(),
      status: 'draft',
      graded: false,
      receipt: null,
      issuedTo: null,
    });
    model.refs.add(ref);
    model.invoices.add(`${supplier}|${invoice}`);
    model.seq += 1;
  }

  toString(): string {
    return `create_payable(supplier=${this.supplierIndex}, face=${this.face}, terms=${this.terms}, flaw=${this.flaw})`;
  }
}

// -- submit / approve / certify --

class Advance extends Step {
  constructor(
    readonly kind: 'submit' | 'approve' | 'certify',
    private readonly target: LifecycleState,
    private readonly index: number,
    private readonly guided: boolean,
    private readonly rightRole: boolean,
  ) {
    super();
  }

  check(model: Readonly<Model>): boolean {
    return model.payables.size > 0;
  }

  private role(): Role {
    const required = EDGE_ROLE[this.kind];
    return this.rightRole ? required : wrongRoleFor(required);
  }

  protected subject(model: Model): string {
    return stateOfPayable(model, this.kind, this.index, this.guided);
  }

  protected predict(model: Model, real: Real): Verdict {
    const p = aimed(model, this.kind, this.index, this.guided)[1];
    // ledger.post() checks the stored grade before it touches the row, so ADA35
    // beats both the lifecycle trigger and the graded_before_certified CHECK.
    if (this.kind === 'certify' && !p.graded) {
      return refuse('ADA35', `payable ${p.ref} has no grade yet`);
    }
    // The lifecycle trigger returns early when the status does not change, so
    // re-issuing a transition the payable already made is accepted and does
    // nothing.
    if (p.status === this.target) return legal;
    if (!real.edges.has(`${p.status}->${this.target}`)) {
      return refuse('ADA01', `illegal lifecycle transition ${p.status} -> ${this.target}`);
    }
    // Only reached once the edge is confirmed real, which is exactly when
    // app.assert_edge_actor finds a row and can have anything to check.
    const required = EDGE_ROLE[this.kind];
    if (this.role() !== required) {
      return refuse(
        'ADA36',
        `payable ${p.ref} moves from ${p.status} to ${this.target} on the ${required}, not the ${this.role()}`,
      );
    }
    return legal;
  }

  protected actorFor(_model: Model, real: Real): string {
    return real.actorsByRole[this.role()];
  }

  protected intent(model: Model): Record<string, unknown> {
    return { kind: this.kind, payableId: aimed(model, this.kind, this.index, this.guided)[0] };
  }

  protected apply(model: Model): void {
    aimed(model, this.kind, this.index, this.guided)[1].status = this.target;
  }

  toString(): string {
    return `${this.kind}(payable=${this.guided ? 'ready' : ''}${this.index}, actor=${this.rightRole ? 'right' : 'wrong'})`;
  }
}

// -- grade --

class Grade extends Step {
  readonly kind = 'grade' as const;

  constructor(
    private readonly index: number,
    private readonly grade: 'AAA' | 'AA' | 'A',
    private readonly guided: boolean,
  ) {
    super();
  }

  check(model: Readonly<Model>): boolean {
    return model.payables.size > 0;
  }

  protected subject(model: Model): string {
    return stateOfPayable(model, this.kind, this.index, this.guided);
  }

  protected predict(): Verdict {
    return legal;
  }

  protected intent(model: Model): Record<string, unknown> {
    return {
      kind: 'grade',
      payableId: aimed(model, this.kind, this.index, this.guided)[0],
      grade: this.grade,
      gradeRationale: 'model-based run',
    };
  }

  protected apply(model: Model): void {
    aimed(model, this.kind, this.index, this.guided)[1].graded = true;
  }

  toString(): string {
    return `grade(payable=${this.guided ? 'ready' : ''}${this.index}, ${this.grade})`;
  }
}

// -- issue_payable --

class Issue extends Step {
  readonly kind = 'issue_payable' as const;

  constructor(
    private readonly index: number,
    private readonly walletIndex: number,
    private readonly guided: boolean,
    private readonly rightRole: boolean,
  ) {
    super();
  }

  check(model: Readonly<Model>): boolean {
    return model.payables.size > 0;
  }

  private to(real: Real): Wallet {
    return nth([...real.wallets], this.walletIndex);
  }

  private role(): Role {
    return this.rightRole ? EDGE_ROLE.issue_payable : wrongRoleFor(EDGE_ROLE.issue_payable);
  }

  protected subject(model: Model): string {
    return stateOfPayable(model, this.kind, this.index, this.guided);
  }

  protected predict(model: Model, real: Real): Verdict {
    const p = aimed(model, this.kind, this.index, this.guided)[1];
    if (p.status !== 'certified') {
      return refuse('ADA15', `payable ${p.ref} is ${p.status} and must be certified before issuance`);
    }
    // Reached only once the payable is certified, which is the only from_state
    // this intent's edge names, so app.assert_edge_actor always finds a row here.
    if (this.role() !== EDGE_ROLE.issue_payable) {
      return refuse(
        'ADA36',
        `payable ${p.ref} moves from certified to issued on the ${EDGE_ROLE.issue_payable}, not the ${this.role()}`,
      );
    }
    // app.payable's maturity_after_issue CHECK, reached whenever the clock has
    // already passed the date the draft was written against.
    if (model.day >= p.maturity) {
      return refuse('23514', 'violates check constraint "maturity_after_issue"');
    }
    let outstanding = 0n;
    for (const other of model.payables.values()) {
      if (other.status === 'issued') outstanding += other.face;
    }
    if (outstanding + p.face > real.programmeLimit) {
      return refuse('ADA33', 'over its');
    }
    return legal;
  }

  protected actorFor(_model: Model, real: Real): string {
    return real.actorsByRole[this.role()];
  }

  protected intent(model: Model, real: Real): Record<string, unknown> {
    return {
      kind: 'issue_payable',
      payableId: aimed(model, this.kind, this.index, this.guided)[0],
      toWallet: this.to(real).address,
      tokenId: 1_000 + this.index,
    };
  }

  protected apply(model: Model, real: Real): void {
    const [id, p] = aimed(model, this.kind, this.index, this.guided);
    p.status = 'issued';
    p.receipt = 'pending';
    p.issuedTo = this.to(real).address;
    move(model, p.issuedTo, 'wallet_free', id, p.face);
  }

  toString(): string {
    return `issue_payable(payable=${this.guided ? 'ready' : ''}${this.index}, to=${this.walletIndex}, actor=${this.rightRole ? 'right' : 'wrong'})`;
  }
}

// -- accept_receipt / reject_receipt --

class Receipt extends Step {
  constructor(
    readonly kind: 'accept_receipt' | 'reject_receipt',
    private readonly index: number,
    private readonly guided: boolean,
  ) {
    super();
  }

  check(model: Readonly<Model>): boolean {
    return model.payables.size > 0;
  }

  protected subject(model: Model): string {
    return stateOfPayable(model, this.kind, this.index, this.guided);
  }

  protected predict(model: Model): Verdict {
    const p = aimed(model, this.kind, this.index, this.guided)[1];
    if (p.receipt === 'pending') return legal;
    // A payable that was never issued has no receipt state at all, and the
    // guard in post.sql compares against NULL, which is never true. The write
    // then falls through to the receipt_only_once_issued CHECK.
    if (p.receipt === null) {
      return refuse('23514', 'violates check constraint "receipt_only_once_issued"');
    }
    return refuse('ADA15', `payable ${p.ref} was already ${p.receipt}`);
  }

  protected intent(model: Model, real: Real): Record<string, unknown> {
    const [id, p] = aimed(model, this.kind, this.index, this.guided);
    if (this.kind === 'accept_receipt') return { kind: this.kind, payableId: id };
    return {
      kind: this.kind,
      payableId: id,
      holderWallet: p.issuedTo ?? real.anchor.address,
    };
  }

  protected apply(model: Model, real: Real): void {
    const [id, p] = aimed(model, this.kind, this.index, this.guided);
    if (this.kind === 'accept_receipt') {
      p.receipt = 'accepted';
      return;
    }
    p.receipt = 'rejected';
    const holder = p.issuedTo ?? real.anchor.address;
    const quantity = held(model, holder, 'wallet_free', id);
    move(model, holder, 'wallet_free', id, -quantity);
    move(model, real.anchor.address, 'wallet_free', id, quantity);
  }

  toString(): string {
    return `${this.kind}(payable=${this.guided ? 'ready' : ''}${this.index})`;
  }
}

// -- top_up --

class TopUp extends Step {
  readonly kind = 'top_up' as const;

  constructor(private readonly walletIndex: number, private readonly amount: bigint) {
    super();
  }

  protected subject(): string {
    return NO_PAYABLE;
  }

  protected predict(): Verdict {
    if (this.amount <= 0n) return refuse('ADA19', 'a top-up must be positive');
    return legal;
  }

  protected intent(_model: Model, real: Real): Record<string, unknown> {
    return {
      kind: 'top_up',
      wallet: nth([...real.wallets], this.walletIndex).address,
      cashCode: XUSD,
      amountBase: this.amount.toString(),
    };
  }

  protected apply(model: Model, real: Real): void {
    move(model, nth([...real.wallets], this.walletIndex).address, 'wallet_free', XUSD, this.amount);
  }

  toString(): string {
    return `top_up(wallet=${this.walletIndex}, ${this.amount})`;
  }
}

// -- transfer --

class Transfer extends Step {
  readonly kind = 'transfer' as const;

  constructor(
    private readonly index: number,
    private readonly fromIndex: number,
    private readonly toIndex: number,
    private readonly size: SizeMode,
    private readonly fromHolder: boolean,
    private readonly guided: boolean,
  ) {
    super();
  }

  check(model: Readonly<Model>): boolean {
    return model.payables.size > 0;
  }

  private subjectOf(model: Model): [string, MPayable] {
    return aimed(model, this.kind, this.index, this.guided);
  }

  private from(model: Model, real: Real): string {
    return pickWallet(model, real, this.subjectOf(model)[0], this.fromIndex, this.fromHolder);
  }

  private to(real: Real): string {
    return nth([...real.wallets], this.toIndex).address;
  }

  private quantityOf(model: Model, real: Real): bigint {
    const id = this.subjectOf(model)[0];
    return sized(this.size, held(model, this.from(model, real), 'wallet_free', id));
  }

  protected subject(model: Model): string {
    return stateOfPayable(model, this.kind, this.index, this.guided);
  }

  protected predict(model: Model, real: Real): Verdict {
    const [id, p] = this.subjectOf(model);
    const quantity = this.quantityOf(model, real);
    if (quantity <= 0n) return refuse('ADA19', 'a transfer must be positive');
    if (model.day >= p.maturity) {
      return refuse('ADA12', `payable ${p.ref} has reached maturity`);
    }
    if (p.receipt === 'pending') {
      return refuse('ADA15', `payable ${p.ref} has not been accepted by its supplier yet`);
    }
    // No token asset exists before issuance, so the legs carry a null asset and
    // the balance row they pre-create is refused by NOT NULL.
    if (p.status !== 'issued' && p.status !== 'settled') {
      return refuse('23502', 'null value in column "asset_id" of relation "account_balance"');
    }
    const from = this.from(model, real);
    // Both legs land on the same account and sum to zero, so nothing is posted
    // and nothing can be short.
    if (from === this.to(real)) return legal;
    const have = held(model, from, 'wallet_free', id);
    if (have < quantity) {
      return refuse('ADA21', `wallet ${from} holds ${have} unlisted, needs ${quantity}`);
    }
    return legal;
  }

  protected intent(model: Model, real: Real): Record<string, unknown> {
    return {
      kind: 'transfer',
      payableId: this.subjectOf(model)[0],
      fromWallet: this.from(model, real),
      toWallet: this.to(real),
      quantityBase: this.quantityOf(model, real).toString(),
    };
  }

  protected apply(model: Model, real: Real): void {
    const id = this.subjectOf(model)[0];
    const from = this.from(model, real);
    const to = this.to(real);
    const quantity = this.quantityOf(model, real);
    if (from === to) return;
    move(model, from, 'wallet_free', id, -quantity);
    move(model, to, 'wallet_free', id, quantity);
  }

  toString(): string {
    return `transfer(payable=${this.guided ? 'ready' : ''}${this.index}, ${this.fromHolder ? 'holder' : 'wallet'}${this.fromIndex}->wallet${this.toIndex}, qty=${this.size})`;
  }
}

// -- publish_listing --

class PublishListing extends Step {
  readonly kind = 'publish_listing' as const;

  constructor(
    private readonly index: number,
    private readonly sellerIndex: number,
    private readonly size: SizeMode,
    private readonly price: bigint,
    private readonly fromHolder: boolean,
    private readonly guided: boolean,
  ) {
    super();
  }

  check(model: Readonly<Model>): boolean {
    return model.payables.size > 0;
  }

  private subjectOf(model: Model): [string, MPayable] {
    return aimed(model, this.kind, this.index, this.guided);
  }

  private seller(model: Model, real: Real): string {
    return pickWallet(model, real, this.subjectOf(model)[0], this.sellerIndex, this.fromHolder);
  }

  private quantityOf(model: Model, real: Real): bigint {
    const id = this.subjectOf(model)[0];
    return sized(this.size, held(model, this.seller(model, real), 'wallet_free', id));
  }

  private listingId(model: Model): string {
    return `00000000-0000-4000-b000-${String(model.seq).padStart(12, '0')}`;
  }

  protected subject(model: Model): string {
    return stateOfPayable(model, this.kind, this.index, this.guided);
  }

  protected predict(model: Model, real: Real): Verdict {
    const [id, p] = this.subjectOf(model);
    const quantity = this.quantityOf(model, real);
    if (quantity <= 0n) return refuse('ADA19', 'a listing must be positive');
    if (model.day >= p.maturity) {
      return refuse('ADA12', `payable ${p.ref} has reached maturity`);
    }
    if (p.receipt === 'pending') {
      return refuse('ADA15', `payable ${p.ref} has not been accepted by its supplier yet`);
    }
    if (p.status !== 'issued' && p.status !== 'settled') {
      return refuse('23502', 'null value in column "asset_id" of relation "listing_leg"');
    }
    const seller = this.seller(model, real);
    for (const listing of model.listings.values()) {
      if (listing.status === 'open' && listing.seller === seller && listing.payableId === id) {
        return refuse('23505', 'unique constraint "one_open_listing_per_seller_target"');
      }
    }
    const have = held(model, seller, 'wallet_free', id);
    if (have < quantity) {
      return refuse('ADA21', `wallet ${seller} holds ${have} unlisted, needs ${quantity}`);
    }
    return legal;
  }

  protected intent(model: Model, real: Real): Record<string, unknown> {
    return {
      kind: 'publish_listing',
      listingId: this.listingId(model),
      payableId: this.subjectOf(model)[0],
      sellerWallet: this.seller(model, real),
      quantityBase: this.quantityOf(model, real).toString(),
      minPriceBase: this.price.toString(),
      buyNowPriceBase: (this.price * 2n).toString(),
    };
  }

  protected apply(model: Model, real: Real): void {
    const id = this.subjectOf(model)[0];
    const seller = this.seller(model, real);
    const quantity = this.quantityOf(model, real);
    model.listings.set(this.listingId(model), {
      payableId: id,
      seller,
      qty: quantity,
      minPrice: this.price,
      buyNow: this.price * 2n,
      status: 'open',
    });
    move(model, seller, 'wallet_free', id, -quantity);
    move(model, seller, 'wallet_listed', id, quantity);
    model.seq += 1;
  }

  toString(): string {
    return `publish_listing(payable=${this.guided ? 'ready' : ''}${this.index}, ${this.fromHolder ? 'holder' : 'wallet'}${this.sellerIndex}, qty=${this.size}, price=${this.price})`;
  }
}

// -- place_bid --

class PlaceBid extends Step {
  readonly kind = 'place_bid' as const;

  constructor(
    private readonly index: number,
    private readonly bidderIndex: number,
    private readonly price: bigint,
    private readonly open: boolean,
  ) {
    super();
  }

  check(model: Readonly<Model>): boolean {
    return model.listings.size > 0;
  }

  private bidder(real: Real): Wallet {
    return nth([...real.wallets], this.bidderIndex);
  }

  private bidId(model: Model): string {
    return `00000000-0000-4000-c000-${String(model.seq).padStart(12, '0')}`;
  }

  protected subject(model: Model): string {
    return stateBehindListing(model, this.index, this.open);
  }

  protected predict(model: Model, real: Real): Verdict {
    const listing = listingAt(model, this.index, this.open)[1];
    if (listing.status !== 'open') return refuse('ADA11', `listing is ${listing.status}`);
    if (!this.bidder(real).institutional) {
      return refuse('ADA34', 'only institutional lender accounts can bid');
    }
    return legal;
  }

  protected intent(model: Model, real: Real): Record<string, unknown> {
    return {
      kind: 'place_bid',
      bidId: this.bidId(model),
      listingId: listingAt(model, this.index, this.open)[0],
      bidderWallet: this.bidder(real).address,
      priceBase: this.price.toString(),
      fundingCode: XUSD,
    };
  }

  protected apply(model: Model, real: Real): void {
    model.bids.push({
      id: this.bidId(model),
      listingId: listingAt(model, this.index, this.open)[0],
      bidder: this.bidder(real).address,
      price: this.price,
      status: 'placed',
    });
    model.seq += 1;
  }

  toString(): string {
    return `place_bid(listing=${this.open ? 'open' : ''}${this.index}, bidder=${this.bidderIndex}, price=${this.price})`;
  }
}

// -- withdraw_bid --

const ABSENT_BID = '00000000-0000-4000-d000-0000000000ff';

class WithdrawBid extends Step {
  readonly kind = 'withdraw_bid' as const;

  constructor(
    private readonly index: number,
    private readonly known: boolean,
    private readonly open: boolean,
  ) {
    super();
  }

  private target(model: Model): MBid | undefined {
    const named = model.bids.filter((b) => b.id !== null);
    if (!this.known || named.length === 0) return undefined;
    if (this.open) {
      const live = named.filter((b) => b.status === 'placed');
      if (live.length > 0) return nth(live, this.index);
    }
    return nth(named, this.index);
  }

  protected subject(model: Model): string {
    const bid = this.target(model);
    if (!bid) return NO_PAYABLE;
    const listing = model.listings.get(bid.listingId);
    return (listing && model.payables.get(listing.payableId)?.status) ?? NO_PAYABLE;
  }

  /** PRD has no "no such bid"; the UPDATE simply matches nothing. */
  protected predict(): Verdict {
    return legal;
  }

  protected intent(model: Model): Record<string, unknown> {
    return { kind: 'withdraw_bid', bidId: this.target(model)?.id ?? ABSENT_BID };
  }

  protected apply(model: Model): void {
    const bid = this.target(model);
    if (bid && bid.status === 'placed') bid.status = 'withdrawn';
  }

  toString(): string {
    return `withdraw_bid(bid=${this.known ? this.index : 'absent'})`;
  }
}

// -- settlement shared by accept_bid and buy_now --

function settleTrade(
  model: Model,
  listingId: string,
  listing: MListing,
  buyer: string,
  price: bigint,
  winner: MBid,
): void {
  for (const other of model.bids) {
    if (other !== winner && other.listingId === listingId && other.status === 'placed') {
      other.status = 'superseded';
    }
  }
  listing.status = 'filled';
  winner.status = 'accepted';
  move(model, buyer, 'wallet_free', XUSD, -price);
  move(model, listing.seller, 'wallet_free', XUSD, price);
  move(model, listing.seller, 'wallet_listed', listing.payableId, -listing.qty);
  move(model, buyer, 'wallet_free', listing.payableId, listing.qty);
}

function tradeRefusal(
  model: Model,
  listing: MListing,
  buyer: string,
  buyerInstitutional: boolean,
  price: bigint,
  verb: 'bid' | 'buy',
): Verdict | null {
  if (buyer === listing.seller) {
    return refuse('ADA11', 'a seller cannot buy their own listing');
  }
  if (!buyerInstitutional) {
    return refuse('ADA34', `only institutional lender accounts can ${verb}`);
  }
  const payable = model.payables.get(listing.payableId)!;
  if (model.day >= payable.maturity) {
    return refuse('ADA12', `payable ${payable.ref} has reached maturity`);
  }
  const funds = held(model, buyer, 'wallet_free', XUSD);
  if (funds < price) {
    return refuse('ADA20', `wallet ${buyer} is short ${price - funds} of the funding asset`);
  }
  return null;
}

// -- accept_bid --

class AcceptBid extends Step {
  readonly kind = 'accept_bid' as const;

  constructor(private readonly index: number, private readonly open: boolean) {
    super();
  }

  check(model: Readonly<Model>): boolean {
    return model.bids.some((b) => b.id !== null);
  }

  private target(model: Model): MBid {
    const named = model.bids.filter((b) => b.id !== null);
    if (this.open) {
      const live = named.filter(
        (b) => b.status === 'placed' && model.listings.get(b.listingId)?.status === 'open',
      );
      if (live.length > 0) return nth(live, this.index);
    }
    return nth(named, this.index);
  }

  protected subject(model: Model): string {
    const listing = model.listings.get(this.target(model).listingId)!;
    return model.payables.get(listing.payableId)?.status ?? NO_PAYABLE;
  }

  protected predict(model: Model, real: Real): Verdict {
    const bid = this.target(model);
    const listing = model.listings.get(bid.listingId)!;
    if (listing.status !== 'open') return refuse('ADA11', `listing is ${listing.status}`);
    if (bid.status !== 'placed') return refuse('ADA11', `bid is ${bid.status}`);
    const institutional = real.wallets.find((w) => w.address === bid.bidder)!.institutional;
    return tradeRefusal(model, listing, bid.bidder, institutional, bid.price, 'buy') ?? legal;
  }

  protected intent(model: Model): Record<string, unknown> {
    const bid = this.target(model);
    return { kind: 'accept_bid', listingId: bid.listingId, bidId: bid.id };
  }

  protected apply(model: Model): void {
    const bid = this.target(model);
    const listing = model.listings.get(bid.listingId)!;
    settleTrade(model, bid.listingId, listing, bid.bidder, bid.price, bid);
  }

  toString(): string {
    return `accept_bid(bid=${this.open ? 'live' : ''}${this.index})`;
  }
}

// -- buy_now --

class BuyNow extends Step {
  readonly kind = 'buy_now' as const;

  constructor(
    private readonly index: number,
    private readonly buyerIndex: number,
    private readonly open: boolean,
  ) {
    super();
  }

  check(model: Readonly<Model>): boolean {
    return model.listings.size > 0;
  }

  private buyer(real: Real): Wallet {
    return nth([...real.wallets], this.buyerIndex);
  }

  protected subject(model: Model): string {
    return stateBehindListing(model, this.index, this.open);
  }

  protected predict(model: Model, real: Real): Verdict {
    const listing = listingAt(model, this.index, this.open)[1];
    if (listing.status !== 'open') return refuse('ADA11', `listing is ${listing.status}`);
    const buyer = this.buyer(real);
    return tradeRefusal(model, listing, buyer.address, buyer.institutional, listing.buyNow, 'buy')
      ?? legal;
  }

  protected intent(model: Model, real: Real): Record<string, unknown> {
    return {
      kind: 'buy_now',
      listingId: listingAt(model, this.index, this.open)[0],
      buyerWallet: this.buyer(real).address,
      fundingCode: XUSD,
    };
  }

  protected apply(model: Model, real: Real): void {
    const [id, listing] = listingAt(model, this.index, this.open);
    const buyer = this.buyer(real).address;
    // buy_now mints its own bid row with a generated id, so the model records
    // one it cannot name. Bids are compared as a multiset for that reason.
    const winner: MBid = {
      id: null,
      listingId: id,
      bidder: buyer,
      price: listing.buyNow,
      status: 'placed',
    };
    model.bids.push(winner);
    settleTrade(model, id, listing, buyer, listing.buyNow, winner);
  }

  toString(): string {
    return `buy_now(listing=${this.open ? 'open' : ''}${this.index}, buyer=${this.buyerIndex})`;
  }
}

// -- cancel_listing --

const ABSENT_LISTING = '00000000-0000-4000-e000-0000000000ff';

class CancelListing extends Step {
  readonly kind = 'cancel_listing' as const;

  constructor(
    private readonly index: number,
    private readonly known: boolean,
    private readonly open: boolean,
  ) {
    super();
  }

  private target(model: Model): [string, MListing] | undefined {
    if (!this.known || model.listings.size === 0) return undefined;
    return listingAt(model, this.index, this.open);
  }

  protected subject(model: Model): string {
    const found = this.target(model);
    if (!found) return NO_PAYABLE;
    return model.payables.get(found[1].payableId)?.status ?? NO_PAYABLE;
  }

  protected predict(model: Model): Verdict {
    const found = this.target(model);
    // A listing id that matches nothing leaves status NULL, and `NULL <> 'open'`
    // is not true, so the command falls through to an UPDATE of no rows.
    if (!found) return legal;
    if (found[1].status !== 'open') return refuse('ADA11', `listing is ${found[1].status}`);
    return legal;
  }

  protected intent(model: Model): Record<string, unknown> {
    return { kind: 'cancel_listing', listingId: this.target(model)?.[0] ?? ABSENT_LISTING };
  }

  protected apply(model: Model): void {
    const found = this.target(model);
    if (!found) return;
    const [id, listing] = found;
    listing.status = 'cancelled';
    for (const bid of model.bids) {
      if (bid.listingId === id && bid.status === 'placed') bid.status = 'superseded';
    }
    move(model, listing.seller, 'wallet_listed', listing.payableId, -listing.qty);
    move(model, listing.seller, 'wallet_free', listing.payableId, listing.qty);
  }

  toString(): string {
    return `cancel_listing(listing=${this.known ? this.index : 'absent'})`;
  }
}

// -- advance_clock --

class AdvanceClock extends Step {
  readonly kind = 'advance_clock' as const;

  constructor(private readonly days: number) {
    super();
  }

  protected subject(): string {
    return NO_PAYABLE;
  }

  protected predict(): Verdict {
    if (this.days < 0) return refuse('ADA19', 'the demo clock only moves forward');
    return legal;
  }

  protected intent(): Record<string, unknown> {
    return { kind: 'advance_clock', days: this.days };
  }

  protected apply(model: Model): void {
    model.day += this.days;
  }

  toString(): string {
    return `advance_clock(${this.days})`;
  }
}

// -- settle_maturity --

class SettleMaturity extends Step {
  readonly kind = 'settle_maturity' as const;

  constructor(
    private readonly index: number,
    private readonly funded: boolean,
    private readonly guided: boolean,
    private readonly rightRole: boolean,
  ) {
    super();
  }

  check(model: Readonly<Model>): boolean {
    return model.payables.size > 0;
  }

  private subjectOf(model: Model): [string, MPayable] {
    return aimed(model, this.kind, this.index, this.guided);
  }

  private role(): Role {
    return this.rightRole ? EDGE_ROLE.settle_maturity : wrongRoleFor(EDGE_ROLE.settle_maturity);
  }

  protected subject(model: Model): string {
    return stateOfPayable(model, this.kind, this.index, this.guided);
  }

  protected predict(model: Model, real: Real): Verdict {
    const [id, p] = this.subjectOf(model);
    if (!this.funded) {
      return refuse('ADA17', 'settle_maturity needs a fundingCode naming the asset the anchor pays from');
    }
    if (p.status === 'settled') return refuse('ADA16', `payable ${p.ref} is already settled`);
    if (model.day < p.maturity) return refuse('ADA12', `payable ${p.ref} has not matured`);
    // The redemption legs are built before the lifecycle write, but the write
    // happens before any leg is posted, so an unissued payable is stopped by
    // the lifecycle trigger rather than by a missing token. app.assert_edge_actor
    // is called before that write too, but only an already-issued payable names
    // a row for it to find, so the role check only ever applies here.
    if (p.status !== 'issued') {
      return refuse('ADA01', `illegal lifecycle transition ${p.status} -> settled`);
    }
    if (this.role() !== EDGE_ROLE.settle_maturity) {
      return refuse(
        'ADA36',
        `payable ${p.ref} moves from issued to settled on the ${EDGE_ROLE.settle_maturity}, not the ${this.role()}`,
      );
    }
    // Rejection returned the whole quantity to the anchor, so there is no
    // holder left to credit. Checked after the role and before the anchor's
    // wallet and funds.
    if (p.receipt === 'rejected') {
      return refuse(
        'ADA37',
        `payable ${p.ref} was rejected by its supplier and has nobody to redeem to`,
      );
    }
    let total = 0n;
    for (const wallet of real.wallets) total += position(model, wallet.address, id);
    const anchorDelta = position(model, real.anchor.address, id) - total;
    const anchorCash = held(model, real.anchor.address, 'wallet_free', XUSD);
    if (anchorCash + anchorDelta < 0n) {
      return refuse(
        'ADA20',
        `wallet ${real.anchor.address} is short ${-(anchorCash + anchorDelta)} of the funding asset`,
      );
    }
    return legal;
  }

  protected actorFor(_model: Model, real: Real): string {
    return real.actorsByRole[this.role()];
  }

  protected intent(model: Model): Record<string, unknown> {
    const intent: Record<string, unknown> = {
      kind: 'settle_maturity',
      payableId: this.subjectOf(model)[0],
    };
    if (this.funded) intent.fundingCode = XUSD;
    return intent;
  }

  protected apply(model: Model, real: Real): void {
    const [id, p] = this.subjectOf(model);
    for (const [listingId, listing] of model.listings) {
      if (listing.status !== 'open' || listing.payableId !== id) continue;
      listing.status = 'cancelled';
      for (const bid of model.bids) {
        if (bid.listingId === listingId && bid.status === 'placed') bid.status = 'superseded';
      }
    }
    let total = 0n;
    for (const wallet of real.wallets) {
      const quantity = position(model, wallet.address, id);
      if (quantity <= 0n) continue;
      total += quantity;
      move(model, wallet.address, 'wallet_free', id, -held(model, wallet.address, 'wallet_free', id));
      move(model, wallet.address, 'wallet_listed', id, -held(model, wallet.address, 'wallet_listed', id));
      move(model, wallet.address, 'wallet_free', XUSD, quantity);
    }
    move(model, real.anchor.address, 'wallet_free', XUSD, -total);
    p.status = 'settled';
  }

  toString(): string {
    return `settle_maturity(payable=${this.guided ? 'ready' : ''}${this.index}, funded=${this.funded}, actor=${this.rightRole ? 'right' : 'wrong'})`;
  }
}

// --- booting the real world -------------------------------------------------

/**
 * A database of this suite's own, with the pool's idle-error event absorbed.
 *
 * `Database.close()` ends the pool and then drops the database `WITH (FORCE)`,
 * which terminates any backend the pool has not finished releasing. That
 * arrives as a 57P01 on the pool's `error` event, and with no listener node
 * reports it as an unhandled error that fails the file after the test has
 * already passed. Query failures still surface through `post()`, which is where
 * this suite reads them.
 */
async function freshWorld(suite: string): Promise<Database> {
  const db = await freshDatabase(suite, 'fixtures');
  db.pool.on('error', () => {});
  return db;
}

async function bootReal(db: Database): Promise<Real> {
  const wallets = await db.pool.query<{
    address: string;
    label: string;
    entity_type: string;
    institutional: boolean;
  }>(`
    SELECT w.address, e.name AS label, e.entity_type::text AS entity_type,
           ledger.wallet_is_institutional(w.address) AS institutional
      FROM app.wallet w JOIN app.entity e ON e.id = w.entity_id
     WHERE e.entity_type IN ('anchor', 'supplier', 'lender')
     ORDER BY e.entity_type, e.name`);
  const suppliers = await db.pool.query<{ id: string; name: string }>(
    `SELECT id::text, name FROM app.entity WHERE entity_type = 'supplier' ORDER BY name`,
  );
  const edges = await db.pool.query<{ from_state: string; to_state: string }>(
    'SELECT from_state::text, to_state::text FROM app.lifecycle_edge',
  );
  const anchorRow = await db.pool.query<{ id: string; programme_limit_base: bigint }>(
    `SELECT id::text, programme_limit_base FROM app.entity WHERE entity_type = 'anchor'`,
  );
  const list = wallets.rows.map((r) => ({
    address: r.address,
    label: r.label,
    institutional: r.institutional,
  }));
  const anchorAddress = wallets.rows.find((r) => r.entity_type === 'anchor')!.address;
  const anchor = list.find((w) => w.address === anchorAddress)!;
  const byRole = await actors(db.pool);
  const roles: Role[] = ['adata_preparer', 'adata_checker', 'straitsx_admin', 'supplier', 'lender'];
  for (const role of roles) {
    if (!byRole[role]) throw new Error(`no live app_user with role ${role}; fixtures should always seed one`);
  }
  return {
    db,
    wallets: list,
    anchor,
    suppliers: suppliers.rows,
    edges: new Set(edges.rows.map((r) => `${r.from_state}->${r.to_state}`)),
    programmeLimit: anchorRow.rows[0]!.programme_limit_base,
    actorsByRole: byRole as Record<Role, string>,
  };
}

async function initialModel(real: Real): Promise<Model> {
  const snap = await observe(real);
  const balances = new Map<string, bigint>();
  for (const [k, v] of Object.entries(snap.balances)) balances.set(k, BigInt(v));
  return {
    day: snap.day,
    seq: 1,
    payables: new Map(),
    listings: new Map(),
    bids: [],
    balances,
    refs: new Set(),
    invoices: new Set(),
  };
}

// --- generators -------------------------------------------------------------

const walletIndex = fc.nat({ max: 4 });

/**
 * Indices are drawn heavily toward zero rather than uniformly.
 *
 * Reaching issuance takes five particular commands in order on one particular
 * payable, so spreading the draws evenly over every payable a run creates means
 * none of them ever gets there, and the whole second half of the lifecycle goes
 * unobserved. Concentrating the traffic on the oldest subject lets one payable
 * run the full course while the others still collect the out-of-order commands.
 */
const leaning = (max: number) =>
  fc.oneof(
    { weight: 6, arbitrary: fc.constant(0) },
    { weight: 3, arbitrary: fc.constant(1) },
    { weight: 2, arbitrary: fc.constant(2) },
    { weight: 1, arbitrary: fc.nat({ max }) },
  );

const payableIndex = leaning(5);
const marketIndex = leaning(4);
const sizeMode = fc.constantFrom<SizeMode>('zero', 'all', 'half', 'over', 'one');

/** Listings stay affordable, so that buy-now and acceptance can actually settle. */
const listPrice = fc.bigInt({ min: 1n, max: 5_000n });

/**
 * Bids do not reserve funds, so a bid beyond anything the bidder holds is
 * placed happily and only refused when the seller accepts it. That is the one
 * route to ADA20, and it has to be a bid price rather than a listing price or
 * the listing itself becomes unbuyable and no trade ever settles.
 */
const bidPrice = fc.oneof(
  { weight: 3, arbitrary: fc.bigInt({ min: 1n, max: 5_000n }) },
  { weight: 1, arbitrary: fc.constant(500_000_000_000n) },
);

/**
 * True two times in three.
 *
 * Every switch that decides whether a command aims at a subject ready for it,
 * names a referent that exists, or carries the field it needs draws from this.
 * The remaining third is what keeps the out-of-order commands, and so the
 * refusal codes, in the generated sequences.
 */
const mostly = fc.oneof(
  { weight: 2, arbitrary: fc.constant(true) },
  { weight: 1, arbitrary: fc.constant(false) },
);

function commandArbitraries(): fc.Arbitrary<fc.AsyncCommand<Model, Real>>[] {
  const create = fc
    .record({
      supplier: fc.nat({ max: 1 }),
      face: fc.constantFrom(1_000_000n, 2_500_000n),
      // Short terms make issuance race the clock and hit the maturity_after_issue
      // CHECK; long ones survive to issuance so that settlement is reachable at
      // all. Both arms are needed, so both are generated.
      terms: fc.oneof(
        { weight: 1, arbitrary: fc.integer({ min: 1, max: 3 }) },
        { weight: 4, arbitrary: fc.integer({ min: 10, max: 45 }) },
      ),
      flaw: fc.constantFrom<CreateFlaw>(
        'none', 'none', 'none', 'dup_ref', 'dup_invoice', 'bad_supplier',
        'bad_terms', 'bad_face', 'empty_invoice',
      ),
    })
    .map((p) => new CreatePayable(p.supplier, p.face, p.terms, p.flaw));

  const aim = fc.record({ i: payableIndex, g: mostly });
  // Wrong-role commands are the only route to ADA36, so a third of these post
  // as a role other than the one their edge names.
  const aimWithRole = fc.record({ i: payableIndex, g: mostly, r: mostly });
  const submit = aimWithRole.map((c) => new Advance('submit', 'pending_approval', c.i, c.g, c.r));
  const approve = aimWithRole.map((c) => new Advance('approve', 'approved', c.i, c.g, c.r));
  const certify = aimWithRole.map((c) => new Advance('certify', 'certified', c.i, c.g, c.r));
  const grade = fc
    .record({
      i: payableIndex,
      g: mostly,
      letter: fc.constantFrom('AAA' as const, 'AA' as const, 'A' as const),
    })
    .map((c) => new Grade(c.i, c.letter, c.g));
  const issue = fc
    .record({ i: payableIndex, w: walletIndex, g: mostly, r: mostly })
    .map((c) => new Issue(c.i, c.w, c.g, c.r));
  const acceptReceipt = aim.map((c) => new Receipt('accept_receipt', c.i, c.g));
  const rejectReceipt = aim.map((c) => new Receipt('reject_receipt', c.i, c.g));
  const topUp = fc
    .record({ w: walletIndex, a: fc.oneof(fc.constant(0n), fc.bigInt({ min: 1n, max: 50_000n })) })
    .map((p) => new TopUp(p.w, p.a));
  const transfer = fc
    .record({
      i: payableIndex, from: walletIndex, to: walletIndex, q: sizeMode,
      holder: mostly, g: mostly,
    })
    .map((c) => new Transfer(c.i, c.from, c.to, c.q, c.holder, c.g));
  const publish = fc
    .record({
      i: payableIndex, s: walletIndex, q: sizeMode, p: listPrice,
      holder: mostly, g: mostly,
    })
    .map((c) => new PublishListing(c.i, c.s, c.q, c.p, c.holder, c.g));
  const placeBid = fc
    .record({ i: marketIndex, b: walletIndex, p: bidPrice, open: mostly })
    .map((c) => new PlaceBid(c.i, c.b, c.p, c.open));
  // Withdrawal and acceptance draw their subject blind half the time rather
  // than two thirds: a bid on a listing whose payable has since settled is only
  // ever reachable through the blind arm, and it is the state these two say the
  // least about anywhere else.
  const withdrawBid = fc
    .record({ i: marketIndex, known: mostly, open: fc.boolean() })
    .map((c) => new WithdrawBid(c.i, c.known, c.open));
  const acceptBid = fc
    .record({ i: marketIndex, open: fc.boolean() })
    .map((c) => new AcceptBid(c.i, c.open));
  const buyNow = fc
    .record({ i: marketIndex, b: walletIndex, open: mostly })
    .map((c) => new BuyNow(c.i, c.b, c.open));
  const cancel = fc
    .record({ i: marketIndex, known: mostly, open: mostly })
    .map((c) => new CancelListing(c.i, c.known, c.open));
  // The large arm is what carries a run from its market phase into its matured
  // phase, where settle_maturity and the ADA12 refusals live.
  const clock = fc
    .oneof(
      { weight: 1, arbitrary: fc.constant(-1) },
      { weight: 5, arbitrary: fc.integer({ min: 0, max: 2 }) },
      { weight: 2, arbitrary: fc.integer({ min: 6, max: 18 }) },
    )
    .map((d) => new AdvanceClock(d));
  const settle = fc
    .record({ i: payableIndex, funded: mostly, g: mostly, r: mostly })
    .map((c) => new SettleMaturity(c.i, c.funded, c.g, c.r));

  // Repetition is the weighting: fc.commands draws uniformly from this list, so
  // the commands that move a payable along appear more than once. Without that
  // bias almost no run reaches issuance, let alone settlement, and the states
  // past 'approved' are never observed under any command.
  return [
    create,
    submit, submit, approve, approve, grade, grade, certify, certify,
    issue, issue, acceptReceipt, acceptReceipt, rejectReceipt,
    topUp, transfer, transfer,
    publish, publish, placeBid, placeBid, withdrawBid, withdrawBid,
    acceptBid, acceptBid, buyNow, cancel, cancel,
    clock, settle, settle,
  ];
}

// --- the property -----------------------------------------------------------

const SEED = 20260915;
const RUNS = 25;

describe('model-based coverage of the payable workflow', () => {
  it(
    'agrees with an executable model of the workflow after every command',
    async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.commands(commandArbitraries(), { maxCommands: 600, size: 'max' }),
          async (commands) => {
            const db = await freshWorld('model_based');
            try {
              const real = await bootReal(db);
              const model = await initialModel(real);
              await fc.asyncModelRun(() => ({ model, real }), commands);
              expect(await ledgerHealth(db.pool)).toEqual(HEALTHY);
            } finally {
              await db.close();
            }
          },
        ),
        { numRuns: RUNS, seed: SEED, verbose: true },
      );
    },
    600_000,
  );

  it('reaches every lifecycle state, every command and every reachable pair', () => {
    const unreachable = unreachablePairs();
    const reachable: string[] = [];
    for (const state of [
      'none', 'draft', 'pending_approval', 'approved', 'certified', 'issued', 'settled',
    ]) {
      for (const kind of COMMAND_KINDS) {
        const pair = `${state}:${kind}`;
        if (!unreachable.includes(pair)) reachable.push(pair);
      }
    }
    const missed = reachable.filter((p) => !coverage.pairs.has(p));
    const spurious = [...coverage.pairs].filter((p) => unreachable.includes(p));

    const lines = [
      '',
      '  model-based workflow coverage',
      `    seed ${SEED}, ${RUNS} runs, ${coverage.steps} commands executed`,
      `    lifecycle states reached : ${coverage.states.size} of 6  [${[...coverage.states].sort().join(', ')}]`,
      `    commands exercised       : ${coverage.commands.size} of ${COMMAND_KINDS.length}`,
      `    (state, command) pairs   : ${coverage.pairs.size} of ${reachable.length} reachable`,
      `    pairs ruled unreachable  : ${unreachable.length} of ${7 * COMMAND_KINDS.length} total`,
      `    outcomes                 : ${[...coverage.verdicts.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([code, n]) => `${code}x${n}`)
        .join(' ')}`,
      `    pairs never reached      : ${missed.length === 0 ? '(none)' : missed.join(', ')}`,
      '',
    ];
    process.stdout.write(`${lines.join('\n')}\n`);

    expect(spurious, 'a pair declared unreachable was reached anyway').toEqual([]);
    expect([...coverage.states].sort()).toEqual([
      'approved', 'certified', 'draft', 'issued', 'pending_approval', 'settled',
    ]);
    expect([...coverage.commands].sort()).toEqual([...COMMAND_KINDS].sort());
    expect(missed).toEqual([]);
    expect(coverage.pairs.size).toBe(75);
    expect(reachable.length).toBe(75);

    // Every verdict the model is able to reach, so that a refusal path quietly
    // falling out of the generator shows up here rather than as a silently
    // easier suite. ADA33, the programme limit, is absent on purpose: the
    // fixture anchor's limit is 250,000,000,000 base units and the generated
    // faces never come within three orders of magnitude of it.
    expect([...coverage.verdicts.keys()].sort()).toEqual([
      '23502', '23505', '23514',
      'ADA01', 'ADA11', 'ADA12', 'ADA15', 'ADA16', 'ADA17', 'ADA19', 'ADA20',
      'ADA21', 'ADA22', 'ADA23', 'ADA24', 'ADA25', 'ADA26', 'ADA34', 'ADA35',
      'ADA36', 'ADA37', 'accepted',
    ]);
  });
});

// --- what the model had to bend to fit --------------------------------------

/**
 * Ten behaviours the model predicts because the ledger does them, not because
 * they look right.
 *
 * The property above is green only because the model reproduces each of these,
 * so without this block they would be invisible: a model that agrees with a
 * defect reports no defect. Each case states what a caller would reasonably
 * expect, and each is marked `it.fails`, so the day one of them is fixed this
 * suite says so instead of quietly continuing to encode the old behaviour.
 * They are written up in tests/techniques/findings/model-based.md.
 */
describe('behaviours the model reproduces but would not choose', () => {
  let db: Database;
  let draftPayable: string;
  let listedPayable: string;
  let sellerWallet: string;
  let lenderWallet: string;

  const LISTING = '00000000-0000-4000-f000-000000000001';
  const NOWHERE = '00000000-0000-4000-f000-0000000000ee';

  beforeAll(async () => {
    db = await freshWorld('model_based_defects');
    const real = await bootReal(db);
    sellerWallet = real.wallets.find((w) => w.label === real.suppliers[0]!.name)!.address;
    lenderWallet = real.wallets.find((w) => w.institutional)!.address;

    const idOf = async (ref: string) =>
      (await db.pool.query<{ id: string }>('SELECT id::text FROM app.payable WHERE ref = $1', [ref]))
        .rows[0]!.id;
    const create = (ref: string, invoice: string) =>
      post(db.pool, {
        kind: 'create_payable',
        ref,
        supplierId: real.suppliers[0]!.id,
        invoiceRef: invoice,
        faceBase: '1000000',
        termsDays: 90,
      });

    await create('DEF-DRAFT', 'DEF-INV-1');
    draftPayable = await idOf('DEF-DRAFT');

    await create('DEF-LIVE', 'DEF-INV-2');
    listedPayable = await idOf('DEF-LIVE');
    for (const intent of [
      { kind: 'submit', payableId: listedPayable },
      { kind: 'approve', payableId: listedPayable },
      { kind: 'grade', payableId: listedPayable, grade: 'AA' },
      { kind: 'certify', payableId: listedPayable },
      { kind: 'issue_payable', payableId: listedPayable, toWallet: sellerWallet, tokenId: 7 },
      { kind: 'accept_receipt', payableId: listedPayable },
      {
        kind: 'publish_listing',
        listingId: LISTING,
        payableId: listedPayable,
        sellerWallet,
        quantityBase: '400000',
        minPriceBase: '100',
        buyNowPriceBase: '200',
      },
    ]) {
      expect(
        await post(db.pool, intent, { actorUserId: correctActor(real, intent.kind) }),
        `setup: ${intent.kind}`,
      ).toMatchObject({ ok: true });
    }
  }, 60_000);

  afterAll(async () => {
    await db.close();
  });

  it.fails('names the payable when a receipt is accepted before issuance', async () => {
    const result = await post(db.pool, { kind: 'accept_receipt', payableId: draftPayable });
    expect(result).toMatchObject({ ok: false, code: 'ADA15' });
  });

  it.fails('names the payable when a receipt is rejected before issuance', async () => {
    const result = await post(db.pool, {
      kind: 'reject_receipt',
      payableId: draftPayable,
      holderWallet: sellerWallet,
    });
    expect(result).toMatchObject({ ok: false, code: 'ADA15' });
  });

  it.fails('refuses a transfer of a payable that was never issued', async () => {
    const result = await post(db.pool, {
      kind: 'transfer',
      payableId: draftPayable,
      fromWallet: sellerWallet,
      toWallet: lenderWallet,
      quantityBase: '1',
    });
    expect(result).toMatchObject({ ok: false, code: 'ADA15' });
  });

  it.fails('refuses a cancellation of a listing that does not exist', async () => {
    const result = await post(db.pool, { kind: 'cancel_listing', listingId: NOWHERE });
    expect(result).toMatchObject({ ok: false, code: 'ADA11' });
  });

  it.fails('refuses a bid on a listing that does not exist', async () => {
    const result = await post(db.pool, {
      kind: 'place_bid',
      bidId: '00000000-0000-4000-f000-000000000002',
      listingId: NOWHERE,
      bidderWallet: lenderWallet,
      priceBase: '100',
      fundingCode: 'XUSD',
    });
    expect(result).toMatchObject({ ok: false, code: 'ADA11' });
  });

  it.fails('says which bid is missing rather than blaming the bidder', async () => {
    const result = await post(db.pool, {
      kind: 'accept_bid',
      listingId: LISTING,
      bidId: '00000000-0000-4000-f000-0000000000dd',
    });
    expect(result.ok ? '' : result.message).toContain('bid');
  });

  it.fails('refuses a second open listing with a named code rather than a raw index error', async () => {
    const result = await post(db.pool, {
      kind: 'publish_listing',
      listingId: '00000000-0000-4000-f000-000000000003',
      payableId: listedPayable,
      sellerWallet,
      quantityBase: '100000',
      minPriceBase: '100',
      buyNowPriceBase: '200',
    });
    expect(result.ok ? '' : result.code ?? '').toMatch(/^ADA/);
  });

  it.fails('refuses a bid below the minimum price the seller published', async () => {
    // PRD section 8 screen 7 has the seller "enter a minimum XUSD price". The
    // column is stored and shown, and neither place_bid nor accept_bid reads it.
    const result = await post(db.pool, {
      kind: 'place_bid',
      bidId: '00000000-0000-4000-f000-000000000004',
      listingId: LISTING,
      bidderWallet: lenderWallet,
      priceBase: '1',
      fundingCode: 'XUSD',
    });
    expect(result).toMatchObject({ ok: false, code: 'ADA11' });
  });

  it.fails('does not stamp a confirmed transaction hash on a transfer that moved nothing', async () => {
    const result = await post(db.pool, {
      kind: 'transfer',
      payableId: listedPayable,
      fromWallet: sellerWallet,
      toWallet: sellerWallet,
      quantityBase: '1000',
    });
    expect(result, 'a self-transfer is accepted').toMatchObject({ ok: true });
    const entryId = result.ok ? String(result.receipt.entryId) : '';
    const { rows } = await db.pool.query<{ legs: number; hash: string | null }>(
      `SELECT (SELECT count(*) FROM ledger.journal_leg l WHERE l.entry_id = e.id)::int AS legs,
              e.chain_tx_hash AS hash
         FROM ledger.journal_entry e WHERE e.id = $1`,
      [entryId],
    );
    expect(rows[0]).toEqual({ legs: 0, hash: null });
  });

  it.fails('names maturity when a draft is issued after its own maturity date', async () => {
    // Its own database: the clock is global and monotone, and advancing it here
    // would decide the outcome of every case above for the wrong reason.
    const own = await freshWorld('model_based_late_issue');
    try {
      const real = await bootReal(own);
      const wallet = real.wallets.find((w) => w.label === real.suppliers[0]!.name)!.address;
      await post(own.pool, {
        kind: 'create_payable',
        ref: 'LATE-1',
        supplierId: real.suppliers[0]!.id,
        invoiceRef: 'LATE-INV-1',
        faceBase: '1000000',
        termsDays: 2,
      });
      const payableId = (await own.pool.query<{ id: string }>(
        `SELECT id::text FROM app.payable WHERE ref = 'LATE-1'`,
      )).rows[0]!.id;
      for (const intent of [
        { kind: 'submit', payableId },
        { kind: 'approve', payableId },
        { kind: 'grade', payableId, grade: 'A' },
        { kind: 'certify', payableId },
        { kind: 'advance_clock', days: 30 },
      ]) {
        expect(
          await post(own.pool, intent, { actorUserId: correctActor(real, intent.kind) }),
          `setup: ${intent.kind}`,
        ).toMatchObject({ ok: true });
      }
      const result = await post(own.pool, {
        kind: 'issue_payable',
        payableId,
        toWallet: wallet,
        tokenId: 11,
      }, { actorUserId: correctActor(real, 'issue_payable') });
      expect(result).toMatchObject({ ok: false, code: 'ADA12' });
    } finally {
      await own.close();
    }
  }, 60_000);

  it('leaves the books balanced after every one of those refusals', async () => {
    expect(await ledgerHealth(db.pool)).toEqual(HEALTHY);
  });
});
