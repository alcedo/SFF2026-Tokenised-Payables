/**
 * Decision tables for the business and compliance rules in db/post.sql.
 *
 * Each rule is declared as data: the conditions the rule reads, one row per
 * combination of those conditions, and the literal outcome that row expects.
 * A runner executes every feasible row against a database of that table's own.
 * A combination the system cannot be put into carries the reason it cannot and
 * is reported as a skipped row rather than dropped, so the grid a reviewer
 * reads is the whole grid, and each table asserts its own row counts.
 *
 * An outcome is a SQLSTATE plus the exact message, together with the end state
 * the command leaves behind. Messages carry {placeholders} the runner fills
 * from the row's own world, because that text reaches users and a refusal
 * naming the wrong payable is a defect this suite should catch.
 *
 * Where a table's outcome lookup is keyed on fewer conditions than the table
 * enumerates, the missing conditions are the finding: table 2's outcome is
 * keyed on the lifecycle edge alone, and table 4's ignores receipt_status.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { attempt } from '@/core/lifecycle';
import {
  freshDatabase,
  post,
  actors,
  ledgerHealth,
  HEALTHY,
  type Database,
  type PostResult,
  type Role,
} from '../support/database';

// --- outcomes ---------------------------------------------------------------

type Expected =
  | { readonly outcome: 'accepted'; readonly endState: string }
  | {
      readonly outcome: 'refused';
      readonly code: string;
      readonly message: string;
      readonly endState: string;
    };

function accepted(endState: string): Expected {
  return { outcome: 'accepted', endState };
}

function refused(code: string, message: string, endState: string): Expected {
  return { outcome: 'refused', code, message, endState };
}

function fill(template: string, vars: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (_match, name: string) => {
    const value = vars[name];
    if (value === undefined) throw new Error(`the table has no {${name}} for "${template}"`);
    return value;
  });
}

function resolve(expected: Expected, vars: Record<string, string>): Expected {
  return expected.outcome === 'accepted'
    ? accepted(fill(expected.endState, vars))
    : refused(expected.code, fill(expected.message, vars), fill(expected.endState, vars));
}

function observe(result: PostResult, endState: string): Expected {
  return result.ok
    ? accepted(endState)
    : refused(result.code ?? 'no SQLSTATE', result.message, endState);
}

function summarise(expected: Expected): string {
  return expected.outcome === 'accepted'
    ? `accepted, ends ${expected.endState}`
    : `${expected.code}, stays ${expected.endState}`;
}

interface TableRow {
  readonly conditions: string;
  readonly expected: Expected;
  readonly infeasible?: string;
}

function shapeOf(rows: readonly TableRow[]): {
  rows: number;
  feasible: number;
  infeasible: number;
} {
  const infeasible = rows.filter((r) => r.infeasible !== undefined).length;
  return { rows: rows.length, feasible: rows.length - infeasible, infeasible };
}

// --- posting helpers --------------------------------------------------------

async function must(
  pool: Pool,
  intent: Record<string, unknown>,
  actorUserId?: string,
): Promise<void> {
  const result = await post(pool, intent, actorUserId ? { actorUserId } : {});
  if (!result.ok) {
    throw new Error(
      `setting up "${String(intent.kind)}" was refused with ${result.code}: ${result.message}`,
    );
  }
}

async function scalar<T>(pool: Pool, sql: string, params: readonly unknown[] = []): Promise<T> {
  const { rows } = await pool.query<{ value: T }>(sql, params as unknown[]);
  return rows[0].value;
}

async function lifecycleOf(pool: Pool, payableId: string): Promise<string> {
  return scalar<string>(pool,
    'SELECT lifecycle_status::text AS value FROM app.payable WHERE id = $1',
    [payableId],
  );
}

// --- the fixture world ------------------------------------------------------

interface Party {
  readonly id: string;
  readonly name: string;
  readonly wallet: string;
}

interface World {
  readonly anchor: Party;
  readonly platform: Party;
  readonly suppliers: readonly Party[];
  readonly lenders: readonly Party[];
  readonly users: Record<Role, string>;
}

async function loadWorld(pool: Pool): Promise<World> {
  const { rows } = await pool.query<{
    id: string;
    name: string;
    entity_type: string;
    wallet: string | null;
  }>(`
    SELECT e.id::text AS id, e.name, e.entity_type::text AS entity_type,
           (SELECT w.address FROM app.wallet w WHERE w.entity_id = e.id ORDER BY w.address LIMIT 1)
             AS wallet
      FROM app.entity e
     ORDER BY e.entity_type, e.name`);

  const pick = (kind: string): Party[] =>
    rows
      .filter((r) => r.entity_type === kind)
      .map((r) => ({ id: r.id, name: r.name, wallet: r.wallet ?? '' }));

  const byRole = await actors(pool);
  const users = {} as Record<Role, string>;
  for (const role of [
    'adata_preparer',
    'adata_checker',
    'supplier',
    'lender',
    'straitsx_admin',
  ] as const) {
    const id = byRole[role];
    if (!id) throw new Error(`the fixture world has no ${role} to post as`);
    users[role] = id;
  }

  return {
    anchor: pick('anchor')[0],
    platform: pick('platform')[0],
    suppliers: pick('supplier'),
    lenders: pick('lender'),
    users,
  };
}

// --- building payables ------------------------------------------------------

const LIFECYCLE_ORDER = ['draft', 'pending_approval', 'approved', 'certified', 'issued'] as const;
type BuildTarget = (typeof LIFECYCLE_ORDER)[number];

let refSeq = 0;
let tokenSeq = 0;

interface BuiltPayable {
  readonly id: string;
  readonly ref: string;
}

interface BuildSpec {
  readonly supplierId: string;
  readonly faceBase: number;
  readonly termsDays: number;
  readonly upTo: BuildTarget;
  readonly toWallet?: string;
  readonly submitAs?: string;
}

async function buildPayable(pool: Pool, spec: BuildSpec): Promise<BuiltPayable> {
  refSeq += 1;
  const ref = `TP-DT-${String(refSeq).padStart(5, '0')}`;
  const reached = (state: BuildTarget): boolean =>
    LIFECYCLE_ORDER.indexOf(spec.upTo) >= LIFECYCLE_ORDER.indexOf(state);

  // The id is read back rather than supplied. Supplying one is refused by a
  // foreign key at the idempotency gate. The case below records that defect.
  await must(pool, {
    kind: 'create_payable',
    ref,
    supplierId: spec.supplierId,
    invoiceRef: `INV-DT-${String(refSeq).padStart(5, '0')}`,
    faceBase: spec.faceBase,
    termsDays: spec.termsDays,
  });
  const id = await scalar<string>(
    pool,
    'SELECT id::text AS value FROM app.payable WHERE ref = $1',
    [ref],
  );

  if (reached('pending_approval')) await must(pool, { kind: 'submit', payableId: id }, spec.submitAs);
  if (reached('approved')) await must(pool, { kind: 'approve', payableId: id });
  if (reached('certified')) {
    // The graded_before_certified CHECK refuses an ungraded payable at
    // 'certified', and a bare constraint violation carries no ADA code, so the
    // grade has to land before the certification in every build.
    await must(pool, {
      kind: 'grade',
      payableId: id,
      grade: 'AAA',
      gradeRationale: 'decision table fixture',
    });
    await must(pool, { kind: 'certify', payableId: id });
  }
  if (reached('issued')) {
    tokenSeq += 1;
    await must(pool, {
      kind: 'issue_payable',
      payableId: id,
      toWallet: spec.toWallet,
      tokenId: tokenSeq,
    });
  }

  return { id, ref };
}

async function onboard(
  pool: Pool,
  entityType: 'supplier' | 'lender',
): Promise<Party> {
  refSeq += 1;
  const name = `DT Counterparty ${String(refSeq).padStart(5, '0')}`;
  await must(pool, {
    kind: 'onboard_entity',
    name,
    entityType,
    userName: `DT Operator ${String(refSeq).padStart(5, '0')}`,
    role: entityType,
  });
  const { rows } = await pool.query<{ id: string; wallet: string }>(
    `SELECT e.id::text AS id, w.address AS wallet
       FROM app.entity e JOIN app.wallet w ON w.entity_id = e.id
      WHERE e.name = $1`,
    [name],
  );
  return { id: rows[0].id, name, wallet: rows[0].wallet };
}

async function xusdBalance(pool: Pool, wallet: string): Promise<bigint> {
  return scalar<bigint>(pool,
    `SELECT COALESCE((
       SELECT b.balance FROM ledger.account_balance b
         JOIN ledger.account a ON a.id = b.account_id
         JOIN ledger.asset s ON s.id = b.asset_id
        WHERE a.wallet_address = $1 AND a.purpose = 'wallet_free'
          AND s.kind = 'cash' AND s.cash_code = 'XUSD'), 0) AS value`,
    [wallet],
  );
}

async function tokenBalance(pool: Pool, wallet: string, payableId: string): Promise<bigint> {
  return scalar<bigint>(pool,
    `SELECT COALESCE((
       SELECT b.balance FROM ledger.account_balance b
         JOIN ledger.account a ON a.id = b.account_id
         JOIN ledger.asset s ON s.id = b.asset_id
        WHERE a.wallet_address = $1 AND a.purpose = 'wallet_free'
          AND s.kind = 'payable' AND s.payable_id = $2), 0) AS value`,
    [wallet, payableId],
  );
}

// ============================================================================
// Table 1: issuance, certification against programme limit
// ============================================================================

type IssuerStatus = 'uncertified' | 'certified' | 'suspended';
type LimitSet = 'null' | 'number';
type Headroom = 'under' | 'at' | 'over' | 'n/a';

interface IssuanceRow extends TableRow {
  readonly lifecycleCertified: boolean;
  readonly issuerStatus: IssuerStatus;
  readonly limitSet: LimitSet;
  readonly headroom: Headroom;
}

const NOT_CERTIFIED = refused(
  'ADA15',
  'payable {ref} is draft and must be certified before issuance',
  'draft',
);
const ISSUER_REFUSED = refused(
  'ADA32',
  '{anchor} is {issuerStatus} and cannot issue under this programme',
  'certified',
);
const OVER_LIMIT = refused(
  'ADA33',
  'issuing {ref} would take {anchor} to {total} outstanding, over its {limit} programme limit',
  'certified',
);
const ISSUED = accepted('issued');

const NO_LIMIT_NO_COMPARISON =
  'programme_limit_base is NULL, so post.sql never reaches the headroom comparison';
const LIMIT_ALWAYS_COMPARED =
  'a programme limit is set, so the headroom comparison always runs and n/a cannot be observed';

function issuanceRow(
  lifecycleCertified: boolean,
  issuerStatus: IssuerStatus,
  limitSet: LimitSet,
  headroom: Headroom,
  outcome: Expected | string,
): IssuanceRow {
  const conditions =
    `lifecycle ${lifecycleCertified ? 'certified' : 'draft'}` +
    ` | issuer ${issuerStatus} | limit ${limitSet} | total vs limit ${headroom}`;
  return typeof outcome === 'string'
    ? { conditions, lifecycleCertified, issuerStatus, limitSet, headroom, expected: ISSUED, infeasible: outcome }
    : { conditions, lifecycleCertified, issuerStatus, limitSet, headroom, expected: outcome };
}

const ISSUANCE_TABLE: readonly IssuanceRow[] = [
  issuanceRow(true, 'certified', 'null', 'under', NO_LIMIT_NO_COMPARISON),
  issuanceRow(true, 'certified', 'null', 'at', NO_LIMIT_NO_COMPARISON),
  issuanceRow(true, 'certified', 'null', 'over', NO_LIMIT_NO_COMPARISON),
  issuanceRow(true, 'certified', 'null', 'n/a', ISSUED),
  issuanceRow(true, 'certified', 'number', 'under', ISSUED),
  issuanceRow(true, 'certified', 'number', 'at', ISSUED),
  issuanceRow(true, 'certified', 'number', 'over', OVER_LIMIT),
  issuanceRow(true, 'certified', 'number', 'n/a', LIMIT_ALWAYS_COMPARED),

  issuanceRow(true, 'uncertified', 'null', 'under', NO_LIMIT_NO_COMPARISON),
  issuanceRow(true, 'uncertified', 'null', 'at', NO_LIMIT_NO_COMPARISON),
  issuanceRow(true, 'uncertified', 'null', 'over', NO_LIMIT_NO_COMPARISON),
  issuanceRow(true, 'uncertified', 'null', 'n/a', ISSUER_REFUSED),
  issuanceRow(true, 'uncertified', 'number', 'under', ISSUER_REFUSED),
  issuanceRow(true, 'uncertified', 'number', 'at', ISSUER_REFUSED),
  issuanceRow(true, 'uncertified', 'number', 'over', ISSUER_REFUSED),
  issuanceRow(true, 'uncertified', 'number', 'n/a', LIMIT_ALWAYS_COMPARED),

  issuanceRow(true, 'suspended', 'null', 'under', NO_LIMIT_NO_COMPARISON),
  issuanceRow(true, 'suspended', 'null', 'at', NO_LIMIT_NO_COMPARISON),
  issuanceRow(true, 'suspended', 'null', 'over', NO_LIMIT_NO_COMPARISON),
  issuanceRow(true, 'suspended', 'null', 'n/a', ISSUER_REFUSED),
  issuanceRow(true, 'suspended', 'number', 'under', ISSUER_REFUSED),
  issuanceRow(true, 'suspended', 'number', 'at', ISSUER_REFUSED),
  issuanceRow(true, 'suspended', 'number', 'over', ISSUER_REFUSED),
  issuanceRow(true, 'suspended', 'number', 'n/a', LIMIT_ALWAYS_COMPARED),

  issuanceRow(false, 'certified', 'null', 'under', NO_LIMIT_NO_COMPARISON),
  issuanceRow(false, 'certified', 'null', 'at', NO_LIMIT_NO_COMPARISON),
  issuanceRow(false, 'certified', 'null', 'over', NO_LIMIT_NO_COMPARISON),
  issuanceRow(false, 'certified', 'null', 'n/a', NOT_CERTIFIED),
  issuanceRow(false, 'certified', 'number', 'under', NOT_CERTIFIED),
  issuanceRow(false, 'certified', 'number', 'at', NOT_CERTIFIED),
  issuanceRow(false, 'certified', 'number', 'over', NOT_CERTIFIED),
  issuanceRow(false, 'certified', 'number', 'n/a', LIMIT_ALWAYS_COMPARED),

  issuanceRow(false, 'uncertified', 'null', 'under', NO_LIMIT_NO_COMPARISON),
  issuanceRow(false, 'uncertified', 'null', 'at', NO_LIMIT_NO_COMPARISON),
  issuanceRow(false, 'uncertified', 'null', 'over', NO_LIMIT_NO_COMPARISON),
  issuanceRow(false, 'uncertified', 'null', 'n/a', NOT_CERTIFIED),
  issuanceRow(false, 'uncertified', 'number', 'under', NOT_CERTIFIED),
  issuanceRow(false, 'uncertified', 'number', 'at', NOT_CERTIFIED),
  issuanceRow(false, 'uncertified', 'number', 'over', NOT_CERTIFIED),
  issuanceRow(false, 'uncertified', 'number', 'n/a', LIMIT_ALWAYS_COMPARED),

  issuanceRow(false, 'suspended', 'null', 'under', NO_LIMIT_NO_COMPARISON),
  issuanceRow(false, 'suspended', 'null', 'at', NO_LIMIT_NO_COMPARISON),
  issuanceRow(false, 'suspended', 'null', 'over', NO_LIMIT_NO_COMPARISON),
  issuanceRow(false, 'suspended', 'null', 'n/a', NOT_CERTIFIED),
  issuanceRow(false, 'suspended', 'number', 'under', NOT_CERTIFIED),
  issuanceRow(false, 'suspended', 'number', 'at', NOT_CERTIFIED),
  issuanceRow(false, 'suspended', 'number', 'over', NOT_CERTIFIED),
  issuanceRow(false, 'suspended', 'number', 'n/a', LIMIT_ALWAYS_COMPARED),
];

describe('table 1: issuance against certification and programme limit', () => {
  const FACE = 1_000_000;
  let db: Database;
  let world: World;

  beforeAll(async () => {
    db = await freshDatabase('dt_issuance', 'fixtures');
    world = await loadWorld(db.pool);
  });

  afterAll(async () => {
    await db?.close();
  });

  it('declares every combination of its four conditions', () => {
    expect(shapeOf(ISSUANCE_TABLE)).toEqual({ rows: 48, feasible: 24, infeasible: 24 });
  });

  it('treats a limit of zero as a cap of zero and a NULL limit as uncapped', async () => {
    const supplier = world.suppliers[1];
    await must(db.pool, {
      kind: 'set_certification',
      entityId: world.anchor.id,
      status: 'certified',
    });

    const capped = await buildPayable(db.pool, {
      supplierId: supplier.id,
      faceBase: FACE,
      termsDays: 90,
      upTo: 'certified',
    });
    await must(db.pool, {
      kind: 'set_programme_limit',
      entityId: world.anchor.id,
      limitBase: '0',
    });
    const outstanding = await scalar<bigint>(
      db.pool,
      `SELECT COALESCE(SUM(sup.outstanding_base), 0)::bigint AS value
         FROM app.payable p
         JOIN ledger.v_payable_supply sup ON sup.payable_id = p.id
        WHERE p.anchor_id = $1`,
      [world.anchor.id],
    );
    tokenSeq += 1;
    const atZero = await post(db.pool, {
      kind: 'issue_payable',
      payableId: capped.id,
      toWallet: supplier.wallet,
      tokenId: tokenSeq,
    });
    expect(observe(atZero, await lifecycleOf(db.pool, capped.id))).toEqual(
      refused(
        'ADA33',
        `issuing ${capped.ref} would take ${world.anchor.name} to ${
          outstanding + BigInt(FACE)
        } outstanding, over its 0 programme limit`,
        'certified',
      ),
    );

    await must(db.pool, {
      kind: 'set_programme_limit',
      entityId: world.anchor.id,
      limitBase: null,
    });
    tokenSeq += 1;
    const uncapped = await post(db.pool, {
      kind: 'issue_payable',
      payableId: capped.id,
      toWallet: supplier.wallet,
      tokenId: tokenSeq,
    });
    expect(observe(uncapped, await lifecycleOf(db.pool, capped.id))).toEqual(accepted('issued'));
    expect(await ledgerHealth(db.pool)).toEqual(HEALTHY);
  });

  for (const row of ISSUANCE_TABLE) {
    if (row.infeasible !== undefined) {
      it.skip(`${row.conditions} -> infeasible: ${row.infeasible}`, () => {});
      continue;
    }

    it(`${row.conditions} -> ${summarise(row.expected)}`, async () => {
      const supplier = world.suppliers[0];
      const payable = await buildPayable(db.pool, {
        supplierId: supplier.id,
        faceBase: FACE,
        termsDays: 90,
        upTo: row.lifecycleCertified ? 'certified' : 'draft',
      });

      await must(db.pool, {
        kind: 'set_certification',
        entityId: world.anchor.id,
        status: row.issuerStatus,
      });

      const outstanding = await scalar<bigint>(db.pool,
        `SELECT COALESCE(SUM(sup.outstanding_base), 0)::bigint AS value
           FROM app.payable p
           JOIN ledger.v_payable_supply sup ON sup.payable_id = p.id
          WHERE p.anchor_id = $1`,
        [world.anchor.id],
      );
      const total = outstanding + BigInt(FACE);
      const limit =
        row.limitSet === 'null'
          ? null
          : row.headroom === 'under'
            ? total + 1n
            : row.headroom === 'at'
              ? total
              : total - 1n;
      await must(db.pool, {
        kind: 'set_programme_limit',
        entityId: world.anchor.id,
        limitBase: limit === null ? null : limit.toString(),
      });

      tokenSeq += 1;
      const result = await post(db.pool, {
        kind: 'issue_payable',
        payableId: payable.id,
        toWallet: supplier.wallet,
        tokenId: tokenSeq,
      });

      const endState = await lifecycleOf(db.pool, payable.id);
      expect(observe(result, endState)).toEqual(
        resolve(row.expected, {
          ref: payable.ref,
          anchor: world.anchor.name,
          issuerStatus: row.issuerStatus,
          total: total.toString(),
          limit: limit === null ? 'null' : limit.toString(),
        }),
      );
      expect(await ledgerHealth(db.pool)).toEqual(HEALTHY);
    });
  }
});

// ============================================================================
// Table 2: maker-checker approval
// ============================================================================

const LIFECYCLES = [
  'draft',
  'pending_approval',
  'approved',
  'certified',
  'issued',
  'settled',
] as const;
type Lifecycle = (typeof LIFECYCLES)[number];

const ROLES: readonly Role[] = [
  'adata_preparer',
  'adata_checker',
  'supplier',
  'lender',
  'straitsx_admin',
];

/**
 * The outcome of `approve` is keyed on the lifecycle edge and nothing else.
 *
 * The role and the identity of the actor are enumerated by the rows below and
 * never appear in this lookup, because `ledger.post()` never reads either one.
 * That absence is the finding, not an omission in the table.
 */
const APPROVE_OUTCOME: Readonly<Record<Lifecycle, Expected>> = {
  draft: refused('ADA01', 'illegal lifecycle transition draft -> approved', 'draft'),
  pending_approval: accepted('approved'),
  approved: accepted('approved'),
  certified: refused('ADA01', 'illegal lifecycle transition certified -> approved', 'certified'),
  issued: refused('ADA01', 'illegal lifecycle transition issued -> approved', 'issued'),
  settled: refused('ADA01', 'illegal lifecycle transition settled -> approved', 'settled'),
};

interface ApprovalRow extends TableRow {
  readonly lifecycle: Lifecycle;
  readonly role: Role;
  readonly sameAsSubmitter: boolean;
}

const APPROVAL_TABLE: readonly ApprovalRow[] = LIFECYCLES.flatMap((lifecycle) =>
  ROLES.flatMap((role) =>
    [true, false].map((sameAsSubmitter): ApprovalRow => {
      const conditions = `${lifecycle} | acting as ${role} | ${
        sameAsSubmitter ? 'same user who submitted' : 'a different user'
      }`;
      const infeasible =
        lifecycle === 'draft' && sameAsSubmitter
          ? 'a draft has never been submitted, so no user is its submitter'
          : undefined;
      return {
        conditions,
        lifecycle,
        role,
        sameAsSubmitter,
        expected: APPROVE_OUTCOME[lifecycle],
        ...(infeasible ? { infeasible } : {}),
      };
    }),
  ),
);

describe('table 2: maker-checker approval', () => {
  const FACE = 1_000_000;
  let db: Database;
  let world: World;

  beforeAll(async () => {
    db = await freshDatabase('dt_maker_checker', 'fixtures');
    world = await loadWorld(db.pool);
  });

  afterAll(async () => {
    await db?.close();
  });

  it('declares every combination of lifecycle, role and submitter identity', () => {
    expect(shapeOf(APPROVAL_TABLE)).toEqual({ rows: 60, feasible: 55, infeasible: 5 });
  });

  it('carries an actor_role on every lifecycle edge that the write path never reads', async () => {
    const { rows } = await db.pool.query<{
      from_state: string;
      to_state: string;
      actor_role: string;
    }>('SELECT from_state::text, to_state::text, actor_role::text FROM app.lifecycle_edge ORDER BY from_state');
    expect(rows).toEqual([
      { from_state: 'approved', to_state: 'certified', actor_role: 'straitsx_admin' },
      { from_state: 'certified', to_state: 'issued', actor_role: 'straitsx_admin' },
      { from_state: 'draft', to_state: 'pending_approval', actor_role: 'adata_preparer' },
      { from_state: 'issued', to_state: 'settled', actor_role: 'adata_preparer' },
      { from_state: 'pending_approval', to_state: 'approved', actor_role: 'adata_checker' },
    ]);

    const sources = await db.pool.query<{ name: string; body: string }>(`
      SELECT p.proname AS name, pg_get_functiondef(p.oid) AS body
        FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE (n.nspname, p.proname) IN (('app', 'enforce_lifecycle_edge'), ('ledger', 'post'))
       ORDER BY p.proname`);
    expect(sources.rows.map((r) => r.name)).toEqual(['enforce_lifecycle_edge', 'post']);
    expect(sources.rows.map((r) => r.body.includes('actor_role'))).toEqual([false, false]);
    expect(sources.rows.map((r) => r.body.includes('lifecycle_edge'))).toEqual([true, false]);
  });

  it('accepts an approval from the supplier who submitted, which core/lifecycle refuses', async () => {
    const supplier = world.users.supplier;
    expect(attempt('pending_approval', 'approve', 'supplier')).toEqual({
      ok: false,
      reason: 'supplier may not approve a payable',
    });

    const payable = await buildPayable(db.pool, {
      supplierId: world.suppliers[0].id,
      faceBase: FACE,
      termsDays: 90,
      upTo: 'pending_approval',
      submitAs: supplier,
    });

    const result = await post(
      db.pool,
      { kind: 'approve', payableId: payable.id },
      { actorUserId: supplier },
    );
    expect(result.ok).toBe(true);
    expect(await lifecycleOf(db.pool, payable.id)).toBe('approved');
    expect(
      await scalar<string>(
        db.pool,
        `SELECT (u.role::text || $2 || (e.actor_user_id = $3)::text) AS value
           FROM ledger.journal_entry e JOIN app.app_user u ON u.id = e.actor_user_id
          WHERE e.payable_id = $1 AND e.kind = 'approved'`,
        [payable.id, '/', supplier],
      ),
    ).toBe('supplier/true');
    expect(await ledgerHealth(db.pool)).toEqual(HEALTHY);
  });

  it('re-approves an approved payable as a silent no-op that still writes an audit event', async () => {
    const payable = await buildPayable(db.pool, {
      supplierId: world.suppliers[1].id,
      faceBase: FACE,
      termsDays: 90,
      upTo: 'approved',
    });

    const result = await post(db.pool, { kind: 'approve', payableId: payable.id });
    expect(result.ok).toBe(true);
    expect(await lifecycleOf(db.pool, payable.id)).toBe('approved');
    expect(
      await scalar<bigint>(
        db.pool,
        `SELECT count(*) AS value FROM ledger.journal_entry
          WHERE payable_id = $1 AND kind = 'approved'`,
        [payable.id],
      ),
    ).toBe(2n);
    expect(await ledgerHealth(db.pool)).toEqual(HEALTHY);
  });

  for (const row of APPROVAL_TABLE) {
    if (row.infeasible !== undefined) {
      it.skip(`${row.conditions} -> infeasible: ${row.infeasible}`, () => {});
      continue;
    }

    it(`${row.conditions} -> ${summarise(row.expected)}`, async () => {
      const actor = world.users[row.role];
      const other =
        row.role === 'adata_preparer' ? world.users.adata_checker : world.users.adata_preparer;
      const submitter = row.sameAsSubmitter ? actor : other;
      const supplier = world.suppliers[0];
      // A settled payable needs the clock past its own maturity, so it is built
      // on one-day terms and the clock is nudged after issuance. The clock only
      // moves forward, and every payable here is built just before it is used,
      // so a later row never finds an earlier row's payable matured under it.
      const shortTerms = row.lifecycle === 'settled';

      const payable = await buildPayable(db.pool, {
        supplierId: supplier.id,
        faceBase: FACE,
        termsDays: shortTerms ? 1 : 90,
        upTo: row.lifecycle === 'settled' ? 'issued' : row.lifecycle,
        toWallet: supplier.wallet,
        submitAs: submitter,
      });

      if (row.lifecycle === 'settled') {
        await must(db.pool, { kind: 'advance_clock', days: 1 });
        await must(db.pool, {
          kind: 'settle_maturity',
          payableId: payable.id,
          fundingCode: 'XUSD',
        });
      }

      expect(await lifecycleOf(db.pool, payable.id)).toBe(row.lifecycle);

      const result = await post(
        db.pool,
        { kind: 'approve', payableId: payable.id },
        { actorUserId: actor },
      );
      const endState = await lifecycleOf(db.pool, payable.id);
      expect(observe(result, endState)).toEqual(resolve(row.expected, {}));
      expect(await ledgerHealth(db.pool)).toEqual(HEALTHY);
    });
  }
});

// ============================================================================
// Table 3: bid acceptance, shared by accept_bid and buy_now
// ============================================================================

type Verb = 'accept_bid' | 'buy_now';
const VERBS: readonly Verb[] = ['accept_bid', 'buy_now'];

type Gate =
  | 'listing_missing'
  | 'listing_filled'
  | 'listing_cancelled'
  | 'no_buy_now_price'
  | 'bid_withdrawn'
  | 'bid_superseded'
  | 'bid_missing'
  | 'bid_below_min_price'
  | 'none';

const GATES: readonly Gate[] = [
  'listing_missing',
  'listing_filled',
  'listing_cancelled',
  'no_buy_now_price',
  'bid_withdrawn',
  'bid_superseded',
  'bid_missing',
  'bid_below_min_price',
  'none',
];

const NO_SUCH_LISTING = refused('ADA11', 'no such listing', 'absent');
const LISTING_FILLED = refused('ADA11', 'listing is filled', 'filled');
const LISTING_CANCELLED = refused('ADA11', 'listing is cancelled', 'cancelled');
const NO_BUY_NOW = refused('ADA11', 'this listing has no buy-now price', 'open');
const BID_WITHDRAWN = refused('ADA11', 'bid is withdrawn', 'open');
const BID_SUPERSEDED = refused('ADA11', 'bid is superseded', 'open');
const SELF_TRADE = refused('ADA11', 'a seller cannot buy their own listing', 'open');
const BUYER_NOT_INSTITUTIONAL = refused(
  'ADA34',
  'only institutional lender accounts can buy',
  'open',
);
const LOT_MATURED = refused('ADA12', 'payable {ref} has reached maturity', 'open');
const BUYER_SHORT = refused(
  'ADA20',
  'wallet {buyer} is short {shortfall} of the funding asset',
  'open',
);
const TRADED = accepted('filled');

const BID_MISSING_READS_AS_INELIGIBLE = refused(
  'ADA34',
  'only institutional lender accounts can buy',
  'open',
);

interface GateRow extends TableRow {
  readonly verb: Verb;
  readonly gate: Gate;
}

const GATE_OUTCOME: Readonly<Record<Gate, Expected>> = {
  listing_missing: NO_SUCH_LISTING,
  listing_filled: LISTING_FILLED,
  listing_cancelled: LISTING_CANCELLED,
  no_buy_now_price: NO_BUY_NOW,
  bid_withdrawn: BID_WITHDRAWN,
  bid_superseded: BID_SUPERSEDED,
  bid_missing: BID_MISSING_READS_AS_INELIGIBLE,
  bid_below_min_price: TRADED,
  none: TRADED,
};

const BUY_NOW_MAKES_ITS_OWN_BID =
  'buy_now creates and accepts its own bid in one command, so no pre-existing bid status applies';
const SUPERSEDED_NEEDS_A_CLOSED_LISTING =
  'a bid only becomes superseded when its listing is filled or cancelled in the same command, and the listing status is checked first';

const GATE_TABLE: readonly GateRow[] = VERBS.flatMap((verb) =>
  GATES.map((gate): GateRow => {
    const conditions = `${verb} | ${gate}`;
    const bidGate =
      gate === 'bid_withdrawn' ||
      gate === 'bid_superseded' ||
      gate === 'bid_missing' ||
      gate === 'bid_below_min_price';
    const infeasible =
      verb === 'buy_now' && bidGate
        ? BUY_NOW_MAKES_ITS_OWN_BID
        : gate === 'bid_superseded'
          ? SUPERSEDED_NEEDS_A_CLOSED_LISTING
          : undefined;
    const expected =
      verb === 'accept_bid' && gate === 'no_buy_now_price' ? TRADED : GATE_OUTCOME[gate];
    return { conditions, verb, gate, expected, ...(infeasible ? { infeasible } : {}) };
  }),
);

interface TailConditions {
  readonly selfTrade: boolean;
  readonly institutional: boolean;
  readonly matured: boolean;
  readonly funded: boolean;
}

interface TailRow extends TableRow, TailConditions {
  readonly verb: Verb;
}

function tailKey(c: TailConditions): string {
  return `${c.selfTrade ? 'self' : 'other'}/${c.institutional ? 'inst' : 'retail'}/${
    c.matured ? 'matured' : 'live'
  }/${c.funded ? 'funded' : 'broke'}`;
}

const TAIL_OUTCOME: Readonly<Record<string, Expected>> = {
  'self/inst/matured/funded': SELF_TRADE,
  'self/inst/matured/broke': SELF_TRADE,
  'self/inst/live/funded': SELF_TRADE,
  'self/inst/live/broke': SELF_TRADE,
  'self/retail/matured/funded': SELF_TRADE,
  'self/retail/matured/broke': SELF_TRADE,
  'self/retail/live/funded': SELF_TRADE,
  'self/retail/live/broke': SELF_TRADE,
  'other/retail/matured/funded': BUYER_NOT_INSTITUTIONAL,
  'other/retail/matured/broke': BUYER_NOT_INSTITUTIONAL,
  'other/retail/live/funded': BUYER_NOT_INSTITUTIONAL,
  'other/retail/live/broke': BUYER_NOT_INSTITUTIONAL,
  'other/inst/matured/funded': LOT_MATURED,
  'other/inst/matured/broke': LOT_MATURED,
  'other/inst/live/broke': BUYER_SHORT,
  'other/inst/live/funded': TRADED,
};

const RETAIL_BID_CANNOT_EXIST =
  'place_bid refuses a non-institutional wallet (ADA34) and every user of a lender entity is institutional_eligible, so no placed bid can have an ineligible bidder';

const TAIL_TABLE: readonly TailRow[] = VERBS.flatMap((verb) =>
  [true, false].flatMap((selfTrade) =>
    [true, false].flatMap((institutional) =>
      [true, false].flatMap((matured) =>
        [true, false].map((funded): TailRow => {
          const c = { selfTrade, institutional, matured, funded };
          const conditions = `${verb} | ${tailKey(c)}`;
          const infeasible =
            verb === 'accept_bid' && !institutional ? RETAIL_BID_CANNOT_EXIST : undefined;
          return {
            conditions,
            verb,
            ...c,
            expected: TAIL_OUTCOME[tailKey(c)],
            ...(infeasible ? { infeasible } : {}),
          };
        }),
      ),
    ),
  ),
);

describe('table 3: bid acceptance', () => {
  const FACE = 1_000_000;
  const PRICE = 500_000;
  let db: Database;
  let world: World;

  beforeAll(async () => {
    db = await freshDatabase('dt_bid_chain', 'fixtures');
    world = await loadWorld(db.pool);
  });

  afterAll(async () => {
    await db?.close();
  });

  it('declares every gate against both verbs', () => {
    expect(shapeOf(GATE_TABLE)).toEqual({ rows: 18, feasible: 13, infeasible: 5 });
  });

  it('declares every combination of the four conditions after the gates', () => {
    expect(shapeOf(TAIL_TABLE)).toEqual({ rows: 32, feasible: 24, infeasible: 8 });
  });

  /** A payable issued to the first supplier, accepted, optionally handed on, then listed. */
  async function listLot(options: {
    seller: string;
    termsDays: number;
    minPriceBase: number;
    buyNowPriceBase: number | null;
  }): Promise<{ payableId: string; ref: string; listingId: string }> {
    const supplier = world.suppliers[0];
    const payable = await buildPayable(db.pool, {
      supplierId: supplier.id,
      faceBase: FACE,
      termsDays: options.termsDays,
      upTo: 'issued',
      toWallet: supplier.wallet,
    });
    await must(db.pool, { kind: 'accept_receipt', payableId: payable.id });
    if (options.seller !== supplier.wallet) {
      await must(db.pool, {
        kind: 'transfer',
        payableId: payable.id,
        fromWallet: supplier.wallet,
        toWallet: options.seller,
        quantityBase: FACE,
      });
    }
    const listingId = randomUUID();
    await must(db.pool, {
      kind: 'publish_listing',
      listingId,
      payableId: payable.id,
      sellerWallet: options.seller,
      quantityBase: FACE,
      minPriceBase: options.minPriceBase,
      buyNowPriceBase: options.buyNowPriceBase,
    });
    return { payableId: payable.id, ref: payable.ref, listingId };
  }

  async function listingStatus(listingId: string): Promise<string> {
    return scalar<string>(db.pool,
      `SELECT COALESCE((SELECT status::text FROM app.listing WHERE id = $1), 'absent') AS value`,
      [listingId],
    );
  }

  it('cannot hold a placed bid from an ineligible wallet, which is why those rows are infeasible', async () => {
    const seller = world.suppliers[0].wallet;
    const lot = await listLot({
      seller,
      termsDays: 90,
      minPriceBase: PRICE,
      buyNowPriceBase: PRICE,
    });
    const retail = await onboard(db.pool, 'supplier');

    const placed = await post(db.pool, {
      kind: 'place_bid',
      listingId: lot.listingId,
      bidderWallet: retail.wallet,
      priceBase: PRICE,
      fundingCode: 'XUSD',
    });
    expect(observe(placed, await listingStatus(lot.listingId))).toEqual(
      refused('ADA34', 'only institutional lender accounts can bid', 'open'),
    );

    // The other route to an ineligible bidder is revoking the bidder's
    // eligibility after the fact, which the acceptance branch says it guards
    // against. Every user of a lender entity is institutional_eligible, and the
    // last live one cannot be removed, so the revocation has no way to happen.
    const lender = await onboard(db.pool, 'lender');
    const onlyUser = await scalar<string>(
      db.pool,
      `SELECT id::text AS value FROM app.app_user WHERE entity_id = $1 AND deactivated_at IS NULL`,
      [lender.id],
    );
    const removed = await post(db.pool, { kind: 'remove_user', userId: onlyUser });
    expect(removed.ok ? '' : removed.code).toBe('ADA30');
    expect(removed.ok ? '' : removed.message).toBe(
      `that is the only account for ${lender.name}, which still holds a wallet`,
    );
    expect(await ledgerHealth(db.pool)).toEqual(HEALTHY);
  });

  it('only supersedes a bid by closing its listing, which is why that row is infeasible', async () => {
    const seller = world.suppliers[0].wallet;
    const buyer = world.lenders[0].wallet;

    const cancelled = await listLot({
      seller,
      termsDays: 90,
      minPriceBase: PRICE,
      buyNowPriceBase: PRICE,
    });
    const loserOfCancel = randomUUID();
    await must(db.pool, {
      kind: 'place_bid',
      bidId: loserOfCancel,
      listingId: cancelled.listingId,
      bidderWallet: buyer,
      priceBase: PRICE,
      fundingCode: 'XUSD',
    });
    await must(db.pool, { kind: 'cancel_listing', listingId: cancelled.listingId });

    const filled = await listLot({
      seller,
      termsDays: 90,
      minPriceBase: PRICE,
      buyNowPriceBase: PRICE,
    });
    const loserOfTrade = randomUUID();
    const winner = randomUUID();
    for (const bidId of [loserOfTrade, winner]) {
      await must(db.pool, {
        kind: 'place_bid',
        bidId,
        listingId: filled.listingId,
        bidderWallet: buyer,
        priceBase: PRICE,
        fundingCode: 'XUSD',
      });
    }
    await must(db.pool, { kind: 'accept_bid', listingId: filled.listingId, bidId: winner });

    const superseded = await db.pool.query<{ bid: string; listing: string }>(
      `SELECT b.status::text AS bid, l.status::text AS listing
         FROM app.bid b JOIN app.listing l ON l.id = b.listing_id
        WHERE b.id = ANY($1::uuid[]) ORDER BY l.status::text`,
      [[loserOfCancel, loserOfTrade]],
    );
    expect(superseded.rows).toEqual([
      { bid: 'superseded', listing: 'cancelled' },
      { bid: 'superseded', listing: 'filled' },
    ]);
    expect(await ledgerHealth(db.pool)).toEqual(HEALTHY);
  });

  for (const row of GATE_TABLE) {
    if (row.infeasible !== undefined) {
      it.skip(`${row.conditions} -> infeasible: ${row.infeasible}`, () => {});
      continue;
    }

    it(`${row.conditions} -> ${summarise(row.expected)}`, async () => {
      const seller = world.suppliers[0].wallet;
      const buyer = world.lenders[0].wallet;

      if (row.gate === 'listing_missing') {
        const result = await post(db.pool, {
          kind: row.verb,
          listingId: randomUUID(),
          bidId: randomUUID(),
          buyerWallet: buyer,
          fundingCode: 'XUSD',
        });
        expect(observe(result, 'absent')).toEqual(resolve(row.expected, {}));
        expect(await ledgerHealth(db.pool)).toEqual(HEALTHY);
        return;
      }

      const minPrice = row.gate === 'bid_below_min_price' ? 900_000 : PRICE;
      const lot = await listLot({
        seller,
        termsDays: 90,
        minPriceBase: minPrice,
        buyNowPriceBase: row.gate === 'no_buy_now_price' ? null : minPrice,
      });

      let bidId: string = randomUUID();
      const placeBid = async (price: number): Promise<void> => {
        await must(db.pool, {
          kind: 'place_bid',
          bidId,
          listingId: lot.listingId,
          bidderWallet: buyer,
          priceBase: price,
          fundingCode: 'XUSD',
        });
      };

      if (row.gate === 'listing_filled') {
        await placeBid(minPrice);
        await must(db.pool, { kind: 'accept_bid', listingId: lot.listingId, bidId });
      } else if (row.gate === 'listing_cancelled') {
        await placeBid(minPrice);
        await must(db.pool, { kind: 'cancel_listing', listingId: lot.listingId });
      } else if (row.gate === 'bid_withdrawn') {
        await placeBid(minPrice);
        await must(db.pool, { kind: 'withdraw_bid', bidId });
      } else if (row.gate === 'bid_missing') {
        bidId = randomUUID();
      } else if (row.gate === 'bid_below_min_price') {
        await placeBid(1);
      } else if (row.verb === 'accept_bid') {
        await placeBid(minPrice);
      }

      const result = await post(db.pool, {
        kind: row.verb,
        listingId: lot.listingId,
        bidId,
        buyerWallet: buyer,
        fundingCode: 'XUSD',
      });
      expect(observe(result, await listingStatus(lot.listingId))).toEqual(
        resolve(row.expected, { ref: lot.ref }),
      );

      if (row.gate === 'bid_below_min_price') {
        const paid = await scalar<bigint>(db.pool,
          `SELECT price_base AS value FROM app.bid WHERE id = $1`,
          [bidId],
        );
        expect(paid).toBe(1n);
        expect(await tokenBalance(db.pool, buyer, lot.payableId)).toBe(BigInt(FACE));
      }
      expect(await ledgerHealth(db.pool)).toEqual(HEALTHY);
    });
  }

  for (const row of TAIL_TABLE) {
    if (row.infeasible !== undefined) {
      it.skip(`${row.conditions} -> infeasible: ${row.infeasible}`, () => {});
      continue;
    }

    it(`${row.conditions} -> ${summarise(row.expected)}`, async () => {
      // A wallet that must be short of funds has to be freshly onboarded. The
      // fixture lenders are funded, and topping a wallet back down is not a
      // command this system has.
      const party: string = row.institutional
        ? row.funded
          ? world.lenders[0].wallet
          : (await onboard(db.pool, 'lender')).wallet
        : (await onboard(db.pool, 'supplier')).wallet;
      if (!row.institutional && row.funded) {
        await must(db.pool, {
          kind: 'top_up',
          wallet: party,
          cashCode: 'XUSD',
          amountBase: PRICE * 4,
        });
      }

      const seller = row.selfTrade ? party : world.suppliers[0].wallet;
      const lot = await listLot({
        seller,
        termsDays: row.matured ? 1 : 90,
        minPriceBase: PRICE,
        buyNowPriceBase: PRICE,
      });

      const bidId = randomUUID();
      if (row.verb === 'accept_bid') {
        await must(db.pool, {
          kind: 'place_bid',
          bidId,
          listingId: lot.listingId,
          bidderWallet: party,
          priceBase: PRICE,
          fundingCode: 'XUSD',
        });
      }
      if (row.matured) await must(db.pool, { kind: 'advance_clock', days: 1 });

      const sellerBefore = await xusdBalance(db.pool, seller);
      const shortfall = BigInt(PRICE) - (await xusdBalance(db.pool, party));
      const result = await post(db.pool, {
        kind: row.verb,
        listingId: lot.listingId,
        bidId,
        buyerWallet: party,
        fundingCode: 'XUSD',
      });

      expect(observe(result, await listingStatus(lot.listingId))).toEqual(
        resolve(row.expected, {
          ref: lot.ref,
          buyer: party,
          shortfall: shortfall.toString(),
        }),
      );

      if (row.expected.outcome === 'accepted') {
        expect(await tokenBalance(db.pool, party, lot.payableId)).toBe(BigInt(FACE));
        expect(await xusdBalance(db.pool, seller)).toBe(sellerBefore + BigInt(PRICE));
      }
      expect(await ledgerHealth(db.pool)).toEqual(HEALTHY);
    });
  }
});

// ============================================================================
// Table 4: maturity settlement
// ============================================================================

type Clock = 'before' | 'on' | 'after';
type Receipt = 'pending' | 'accepted' | 'rejected';

interface SettlementConditions {
  readonly fundingCode: boolean;
  readonly alreadySettled: boolean;
  readonly clock: Clock;
  readonly anchorWallet: boolean;
  readonly anchorFunds: boolean;
}

interface SettlementRow extends TableRow, SettlementConditions {
  readonly receipt: Receipt;
}

const NEEDS_FUNDING_CODE = (endState: string): Expected =>
  refused(
    'ADA17',
    'settle_maturity needs a fundingCode naming the asset the anchor pays from',
    endState,
  );
const ALREADY_SETTLED = refused('ADA16', 'payable {ref} is already settled', 'settled');
const NOT_MATURED = refused('ADA12', 'payable {ref} has not matured', 'issued');
const ANCHOR_HAS_NO_WALLET = refused('ADA15', 'anchor for {ref} has no wallet', 'issued');
const ANCHOR_SHORT = refused(
  'ADA20',
  'wallet {anchorWallet} is short {shortfall} of the funding asset',
  'issued',
);
const SETTLED = accepted('settled');

function settlementKey(c: SettlementConditions): string {
  return [
    c.fundingCode ? 'funding' : 'no-funding',
    c.alreadySettled ? 'settled' : 'issued',
    c.clock,
    c.anchorWallet ? 'wallet' : 'no-wallet',
    c.anchorFunds ? 'funded' : 'short',
  ].join('/');
}

/**
 * Keyed on five conditions. `receipt_status` is the sixth condition the rows
 * enumerate and it is deliberately absent from this key, because settlement
 * never reads it: a rejected receipt settles exactly like an accepted one.
 */
const SETTLEMENT_OUTCOME: Readonly<Record<string, Expected>> = Object.fromEntries(
  [true, false].flatMap((fundingCode) =>
    [true, false].flatMap((alreadySettled) =>
      (['before', 'on', 'after'] as const).flatMap((clock) =>
        [true, false].flatMap((anchorWallet) =>
          [true, false].map((anchorFunds): [string, Expected] => {
            const c = { fundingCode, alreadySettled, clock, anchorWallet, anchorFunds };
            const stay = alreadySettled ? 'settled' : 'issued';
            if (!fundingCode) return [settlementKey(c), NEEDS_FUNDING_CODE(stay)];
            if (alreadySettled) return [settlementKey(c), ALREADY_SETTLED];
            if (clock === 'before') return [settlementKey(c), NOT_MATURED];
            if (!anchorWallet) return [settlementKey(c), ANCHOR_HAS_NO_WALLET];
            if (!anchorFunds) return [settlementKey(c), ANCHOR_SHORT];
            return [settlementKey(c), SETTLED];
          }),
        ),
      ),
    ),
  ),
);

const SETTLED_IMPLIES_MATURED =
  'settlement is refused before maturity and the clock never rewinds, so a settled payable is never ahead of its maturity date';
const NO_WALLET_NO_BALANCE =
  'an anchor with no wallet holds no balance, so its funds can never be sufficient';
const REJECTED_PAYS_ITSELF =
  'a rejected receipt returns the whole quantity to the anchor, so its redemption credit and debit net to zero and no shortfall is possible';
const SETTLING_PROVED_THE_FUNDS =
  'reaching settled required the anchor to fund the redemption, and no command in this table moves funds back out of its wallet';

function settlementInfeasibility(
  c: SettlementConditions,
  receipt: Receipt,
): string | undefined {
  if (c.alreadySettled && c.clock === 'before') return SETTLED_IMPLIES_MATURED;
  if (!c.anchorWallet && c.anchorFunds) return NO_WALLET_NO_BALANCE;
  if (c.alreadySettled && !c.anchorFunds) return SETTLING_PROVED_THE_FUNDS;
  if (receipt === 'rejected' && !c.anchorFunds && c.anchorWallet) return REJECTED_PAYS_ITSELF;
  return undefined;
}

const SETTLEMENT_TABLE: readonly SettlementRow[] = [true, false].flatMap((fundingCode) =>
  [true, false].flatMap((alreadySettled) =>
    (['before', 'on', 'after'] as const).flatMap((clock) =>
      [true, false].flatMap((anchorWallet) =>
        [true, false].flatMap((anchorFunds) =>
          (['pending', 'accepted', 'rejected'] as const).map((receipt): SettlementRow => {
            const c = { fundingCode, alreadySettled, clock, anchorWallet, anchorFunds };
            const infeasible = settlementInfeasibility(c, receipt);
            return {
              conditions: `${settlementKey(c)}/receipt ${receipt}`,
              ...c,
              receipt,
              expected: SETTLEMENT_OUTCOME[settlementKey(c)],
              ...(infeasible ? { infeasible } : {}),
            };
          }),
        ),
      ),
    ),
  ),
);

describe('table 4: maturity settlement', () => {
  const SMALL_FACE = 1_000_000;
  const UNAFFORDABLE_FACE = 1_000_000_000_000;
  let db: Database;
  let world: World;
  let walletlessAnchor: string;

  beforeAll(async () => {
    db = await freshDatabase('dt_settlement', 'fixtures');
    world = await loadWorld(db.pool);
    // A face larger than the anchor can pay is also larger than the fixture
    // programme limit, and issuance would refuse it first.
    await must(db.pool, {
      kind: 'set_programme_limit',
      entityId: world.anchor.id,
      limitBase: null,
    });
    // No intent creates an anchor, and none detaches a wallet, so the one
    // condition this rule reads that the command set cannot reach is built
    // directly. It is named to sort after the fixture anchor, because
    // create_payable picks its anchor with ORDER BY name LIMIT 1.
    walletlessAnchor = await scalar<string>(db.pool,
      `INSERT INTO app.entity (name, entity_type, certification_status)
       VALUES ('zz decision-table anchor without a wallet', 'anchor', 'certified')
       RETURNING id::text AS value`,
    );
  });

  afterAll(async () => {
    await db?.close();
  });

  it('declares every combination of its six conditions', () => {
    expect(shapeOf(SETTLEMENT_TABLE)).toEqual({ rows: 144, feasible: 60, infeasible: 84 });
  });

  for (const row of SETTLEMENT_TABLE) {
    if (row.infeasible !== undefined) {
      it.skip(`${row.conditions} -> infeasible: ${row.infeasible}`, () => {});
      continue;
    }

    it(`${row.conditions} -> ${summarise(row.expected)}`, async () => {
      const supplier = world.suppliers[0];
      const face = row.anchorFunds ? SMALL_FACE : UNAFFORDABLE_FACE;
      const payable = await buildPayable(db.pool, {
        supplierId: supplier.id,
        faceBase: face,
        termsDays: row.clock === 'before' ? 90 : 1,
        upTo: 'issued',
        toWallet: supplier.wallet,
      });

      if (row.receipt === 'accepted') {
        await must(db.pool, { kind: 'accept_receipt', payableId: payable.id });
      } else if (row.receipt === 'rejected') {
        await must(db.pool, {
          kind: 'reject_receipt',
          payableId: payable.id,
          holderWallet: supplier.wallet,
        });
      }

      if (row.clock === 'on') await must(db.pool, { kind: 'advance_clock', days: 1 });
      if (row.clock === 'after') await must(db.pool, { kind: 'advance_clock', days: 2 });

      if (row.alreadySettled) {
        await must(db.pool, {
          kind: 'settle_maturity',
          payableId: payable.id,
          fundingCode: 'XUSD',
        });
      }

      if (!row.anchorWallet) {
        await db.pool.query('UPDATE app.payable SET anchor_id = $1 WHERE id = $2', [
          walletlessAnchor,
          payable.id,
        ]);
      }

      const shortfall = BigInt(face) - (await xusdBalance(db.pool, world.anchor.wallet));
      const result = await post(db.pool, {
        kind: 'settle_maturity',
        payableId: payable.id,
        ...(row.fundingCode ? { fundingCode: 'XUSD' } : {}),
      });

      const endState = await lifecycleOf(db.pool, payable.id);
      expect(observe(result, endState)).toEqual(
        resolve(row.expected, {
          ref: payable.ref,
          anchorWallet: world.anchor.wallet,
          shortfall: shortfall.toString(),
        }),
      );
      expect(await ledgerHealth(db.pool)).toEqual(HEALTHY);
    });
  }

  it('settles a payable whose supplier rejected the receipt', async () => {
    const supplier = world.suppliers[1];
    const payable = await buildPayable(db.pool, {
      supplierId: supplier.id,
      faceBase: SMALL_FACE,
      termsDays: 1,
      upTo: 'issued',
      toWallet: supplier.wallet,
    });
    await must(db.pool, {
      kind: 'reject_receipt',
      payableId: payable.id,
      holderWallet: supplier.wallet,
    });
    await must(db.pool, { kind: 'advance_clock', days: 1 });

    const anchorBefore = await xusdBalance(db.pool, world.anchor.wallet);
    const result = await post(db.pool, {
      kind: 'settle_maturity',
      payableId: payable.id,
      fundingCode: 'XUSD',
    });

    expect(result.ok).toBe(true);
    expect(
      await scalar<string>(db.pool,
        'SELECT (lifecycle_status::text || $2 || receipt_status::text) AS value FROM app.payable WHERE id = $1',
        [payable.id, '/'],
      ),
    ).toBe('settled/rejected');
    expect(await xusdBalance(db.pool, world.anchor.wallet)).toBe(anchorBefore);
    expect(await ledgerHealth(db.pool)).toEqual(HEALTHY);
  });
});

// ============================================================================
// Table 5: role against organisation type
// ============================================================================

type EntityType = 'anchor' | 'supplier' | 'lender' | 'platform';
const ENTITY_TYPES: readonly EntityType[] = ['anchor', 'supplier', 'lender', 'platform'];

const ROLE_FITS: Readonly<Record<EntityType, readonly Role[]>> = {
  anchor: ['adata_preparer', 'adata_checker'],
  supplier: ['supplier'],
  lender: ['lender'],
  platform: ['straitsx_admin'],
};

const ROLE_MISMATCH = (entityType: EntityType, role: Role): Expected =>
  refused('ADA29', `a ${entityType} cannot hold the ${role} role`, 'no new user');
const ADMIN_TAKEN = refused(
  'ADA29',
  'the platform already has a StraitsX administrator',
  'no new user',
);
const ONLY_COUNTERPARTIES = refused(
  'ADA29',
  'only a supplier or a lender can be onboarded here',
  'nothing created',
);
const ONBOARD_ROLE_MISMATCH = (entityType: EntityType, role: Role): Expected =>
  refused('ADA29', `a ${entityType} cannot hold the ${role} role`, 'nothing created');

interface MatchRow extends TableRow {
  readonly entityType: EntityType;
  readonly role: Role;
}

const CREATE_USER_TABLE: readonly MatchRow[] = ENTITY_TYPES.flatMap((entityType) =>
  ROLES.map((role): MatchRow => {
    const fits = ROLE_FITS[entityType].includes(role);
    const expected = !fits
      ? ROLE_MISMATCH(entityType, role)
      : entityType === 'platform'
        ? ADMIN_TAKEN
        : accepted(role);
    return { conditions: `create_user | ${entityType} | ${role}`, entityType, role, expected };
  }),
);

const ONBOARD_TABLE: readonly MatchRow[] = ENTITY_TYPES.flatMap((entityType) =>
  ROLES.map((role): MatchRow => {
    const expected =
      entityType === 'anchor' || entityType === 'platform'
        ? ONLY_COUNTERPARTIES
        : ROLE_FITS[entityType].includes(role)
          ? accepted('onboarded')
          : ONBOARD_ROLE_MISMATCH(entityType, role);
    return { conditions: `onboard_entity | ${entityType} | ${role}`, entityType, role, expected };
  }),
);

type NameCase = 'given' | 'empty' | 'whitespace';
type OrgCase = 'fresh' | 'empty' | 'whitespace' | 'duplicate' | 'duplicate other case';

const USER_NAME_REQUIRED = refused('ADA28', 'a user name is required', 'nothing created');
const ORG_NAME_REQUIRED = refused('ADA28', 'an organisation name is required', 'nothing created');
const ORG_NAME_TAKEN = refused(
  'ADA27',
  'an organisation called {orgName} is already on the platform',
  'nothing created',
);

interface NameRow extends TableRow {
  readonly userName: NameCase;
  readonly orgName: OrgCase;
}

const NAME_TABLE: readonly NameRow[] = (['given', 'empty', 'whitespace'] as const).flatMap(
  (userName) =>
    (['fresh', 'empty', 'whitespace', 'duplicate', 'duplicate other case'] as const).map(
      (orgName): NameRow => {
        const expected =
          userName !== 'given'
            ? USER_NAME_REQUIRED
            : orgName === 'empty' || orgName === 'whitespace'
              ? ORG_NAME_REQUIRED
              : orgName === 'fresh'
                ? accepted('onboarded')
                : ORG_NAME_TAKEN;
        return {
          conditions: `onboard_entity | user name ${userName} | organisation name ${orgName}`,
          userName,
          orgName,
          expected,
        };
      },
    ),
);

describe('table 5: role against organisation type', () => {
  let db: Database;
  let world: World;

  beforeAll(async () => {
    db = await freshDatabase('dt_role_match', 'fixtures');
    world = await loadWorld(db.pool);
  });

  afterAll(async () => {
    await db?.close();
  });

  it('declares the full cross product for create_user', () => {
    expect(shapeOf(CREATE_USER_TABLE)).toEqual({ rows: 20, feasible: 20, infeasible: 0 });
  });

  it('declares the full cross product for onboard_entity', () => {
    expect(shapeOf(ONBOARD_TABLE)).toEqual({ rows: 20, feasible: 20, infeasible: 0 });
  });

  it('declares every combination of the two name conditions', () => {
    expect(shapeOf(NAME_TABLE)).toEqual({ rows: 15, feasible: 15, infeasible: 0 });
  });

  function entityIdFor(entityType: EntityType): string {
    if (entityType === 'anchor') return world.anchor.id;
    if (entityType === 'platform') return world.platform.id;
    return entityType === 'supplier' ? world.suppliers[0].id : world.lenders[0].id;
  }

  for (const row of CREATE_USER_TABLE) {
    it(`${row.conditions} -> ${summarise(row.expected)}`, async () => {
      refSeq += 1;
      const userName = `DT User ${String(refSeq).padStart(5, '0')}`;
      const entityId = entityIdFor(row.entityType);
      const result = await post(db.pool, {
        kind: 'create_user',
        entityId,
        userName,
        role: row.role,
      });
      const endState = await scalar<string>(db.pool,
        `SELECT COALESCE((SELECT role::text FROM app.app_user WHERE name = $1), 'no new user') AS value`,
        [userName],
      );
      expect(observe(result, endState)).toEqual(resolve(row.expected, {}));
      expect(await ledgerHealth(db.pool)).toEqual(HEALTHY);
    });
  }

  for (const row of ONBOARD_TABLE) {
    it(`${row.conditions} -> ${summarise(row.expected)}`, async () => {
      refSeq += 1;
      const name = `DT Onboarded ${String(refSeq).padStart(5, '0')}`;
      const result = await post(db.pool, {
        kind: 'onboard_entity',
        name,
        entityType: row.entityType,
        userName: `DT Founder ${String(refSeq).padStart(5, '0')}`,
        role: row.role,
      });
      const endState = await scalar<string>(db.pool,
        `SELECT CASE WHEN EXISTS (SELECT 1 FROM app.entity WHERE name = $1)
                     THEN 'onboarded' ELSE 'nothing created' END AS value`,
        [name],
      );
      expect(observe(result, endState)).toEqual(resolve(row.expected, {}));
      expect(await ledgerHealth(db.pool)).toEqual(HEALTHY);
    });
  }

  for (const row of NAME_TABLE) {
    it(`${row.conditions} -> ${summarise(row.expected)}`, async () => {
      refSeq += 1;
      const fresh = `DT Named ${String(refSeq).padStart(5, '0')}`;
      const taken = world.suppliers[0].name;
      const orgName =
        row.orgName === 'fresh'
          ? fresh
          : row.orgName === 'empty'
            ? ''
            : row.orgName === 'whitespace'
              ? '   '
              : row.orgName === 'duplicate'
                ? taken
                : taken.toLowerCase();
      const userName =
        row.userName === 'given'
          ? `DT Named Founder ${String(refSeq).padStart(5, '0')}`
          : row.userName === 'empty'
            ? ''
            : '   ';

      const result = await post(db.pool, {
        kind: 'onboard_entity',
        name: orgName,
        entityType: 'supplier',
        userName,
        role: 'supplier',
      });
      const endState = await scalar<string>(db.pool,
        `SELECT CASE WHEN EXISTS (SELECT 1 FROM app.entity WHERE name = $1)
                     THEN 'onboarded' ELSE 'nothing created' END AS value`,
        [fresh],
      );
      expect(observe(result, endState)).toEqual(resolve(row.expected, { orgName }));
      expect(await ledgerHealth(db.pool)).toEqual(HEALTHY);
    });
  }
});

// ============================================================================
// Table 6: user removal
// ============================================================================

type UserState = 'live' | 'deactivated' | 'absent';

interface RemovalRow extends TableRow {
  readonly userState: UserState;
  readonly isAdmin: boolean;
  readonly hasLiveSibling: boolean;
}

const NO_SUCH_USER_ABSENT = refused('ADA15', 'no such user', 'absent');
const NO_SUCH_USER_DEACTIVATED = refused('ADA15', 'no such user', 'deactivated');
const ADMIN_IS_PERMANENT = refused(
  'ADA15',
  'the StraitsX administrator cannot be removed',
  'live',
);
const LAST_ACCOUNT = refused(
  'ADA30',
  'that is the only account for {entity}, which still holds a wallet',
  'live',
);
const REMOVED = accepted('deactivated');

const ABSENT_HAS_NO_ROLE = 'a user id that matches no row has no role to be the administrator';
const ABSENT_HAS_NO_ENTITY =
  'a user id that matches no row belongs to no organisation, so it has no live siblings';
const ADMIN_CANNOT_BE_DEACTIVATED =
  'remove_user refuses the straitsx_admin, and no other command deactivates a user, so a deactivated administrator cannot exist';
const DEACTIVATION_LEAVES_A_SIBLING =
  'the last live account of an organisation cannot be removed, so every deactivated user still has a live sibling';
const ADMIN_HAS_NO_SIBLING =
  'the platform entity accepts only straitsx_admin users and only one may be live, so the administrator never has a live sibling';

function removalInfeasibility(row: {
  userState: UserState;
  isAdmin: boolean;
  hasLiveSibling: boolean;
}): string | undefined {
  if (row.userState === 'absent' && row.isAdmin) return ABSENT_HAS_NO_ROLE;
  if (row.userState === 'absent' && row.hasLiveSibling) return ABSENT_HAS_NO_ENTITY;
  if (row.userState === 'deactivated' && row.isAdmin) return ADMIN_CANNOT_BE_DEACTIVATED;
  if (row.userState === 'deactivated' && !row.hasLiveSibling) return DEACTIVATION_LEAVES_A_SIBLING;
  if (row.userState === 'live' && row.isAdmin && row.hasLiveSibling) return ADMIN_HAS_NO_SIBLING;
  return undefined;
}

const REMOVAL_TABLE: readonly RemovalRow[] = (['live', 'deactivated', 'absent'] as const).flatMap(
  (userState) =>
    [true, false].flatMap((isAdmin) =>
      [true, false].map((hasLiveSibling): RemovalRow => {
        const expected =
          userState === 'absent'
            ? NO_SUCH_USER_ABSENT
            : userState === 'deactivated'
              ? NO_SUCH_USER_DEACTIVATED
              : isAdmin
                ? ADMIN_IS_PERMANENT
                : hasLiveSibling
                  ? REMOVED
                  : LAST_ACCOUNT;
        const infeasible = removalInfeasibility({ userState, isAdmin, hasLiveSibling });
        return {
          conditions: `user ${userState} | ${isAdmin ? 'administrator' : 'ordinary role'} | ${
            hasLiveSibling ? 'a live sibling' : 'no live sibling'
          }`,
          userState,
          isAdmin,
          hasLiveSibling,
          expected,
          ...(infeasible ? { infeasible } : {}),
        };
      }),
    ),
);

describe('table 6: user removal', () => {
  let db: Database;
  let world: World;

  beforeAll(async () => {
    db = await freshDatabase('dt_user_removal', 'fixtures');
    world = await loadWorld(db.pool);
  });

  afterAll(async () => {
    await db?.close();
  });

  it('declares every combination of its three conditions', () => {
    expect(shapeOf(REMOVAL_TABLE)).toEqual({ rows: 12, feasible: 5, infeasible: 7 });
  });

  for (const row of REMOVAL_TABLE) {
    if (row.infeasible !== undefined) {
      it.skip(`${row.conditions} -> infeasible: ${row.infeasible}`, () => {});
      continue;
    }

    it(`${row.conditions} -> ${summarise(row.expected)}`, async () => {
      let userId: string = randomUUID();
      let entityName = '';

      if (row.userState === 'live' && row.isAdmin) {
        userId = world.users.straitsx_admin;
        entityName = world.platform.name;
      } else if (row.userState !== 'absent') {
        const party = await onboard(db.pool, 'supplier');
        entityName = party.name;
        const first = await scalar<string>(db.pool,
          `SELECT id::text AS value FROM app.app_user WHERE entity_id = $1 AND deactivated_at IS NULL`,
          [party.id],
        );
        if (row.hasLiveSibling) {
          refSeq += 1;
          await must(db.pool, {
            kind: 'create_user',
            entityId: party.id,
            userName: `DT Sibling ${String(refSeq).padStart(5, '0')}`,
            role: 'supplier',
          });
        }
        userId = first;
        if (row.userState === 'deactivated') {
          await must(db.pool, { kind: 'remove_user', userId });
        }
      }

      const result = await post(db.pool, { kind: 'remove_user', userId });
      const endState = await scalar<string>(db.pool,
        `SELECT COALESCE((SELECT CASE WHEN deactivated_at IS NULL THEN 'live' ELSE 'deactivated' END
                            FROM app.app_user WHERE id = $1), 'absent') AS value`,
        [userId],
      );
      expect(observe(result, endState)).toEqual(resolve(row.expected, { entity: entityName }));
      expect(await ledgerHealth(db.pool)).toEqual(HEALTHY);
    });
  }
});

// ============================================================================
// Refusals the tables above could not express as rows
// ============================================================================

describe('a client-minted payable id', () => {
  let db: Database;
  let world: World;

  beforeAll(async () => {
    db = await freshDatabase('dt_client_ids', 'fixtures');
    world = await loadWorld(db.pool);
  });

  afterAll(async () => {
    await db?.close();
  });

  it('is refused by a foreign key at the idempotency gate, with no ADA code', async () => {
    const payableId = randomUUID();
    const result = await post(db.pool, {
      kind: 'create_payable',
      payableId,
      ref: 'TP-DT-CLIENT-ID',
      supplierId: world.suppliers[0].id,
      invoiceRef: 'INV-DT-CLIENT-ID',
      faceBase: 1_000_000,
      termsDays: 90,
    });

    expect(result.ok).toBe(false);
    expect(result.ok ? '' : result.code).toBe('23503');
    expect(result.ok ? '' : result.message).toBe(
      'insert or update on table "journal_entry" violates foreign key constraint "journal_entry_payable_id_fkey"',
    );
    expect(
      await scalar<string>(
        db.pool,
        `SELECT CASE WHEN EXISTS (SELECT 1 FROM app.payable WHERE id = $1)
                     THEN 'created' ELSE 'nothing created' END AS value`,
        [payableId],
      ),
    ).toBe('nothing created');
    expect(await ledgerHealth(db.pool)).toEqual(HEALTHY);
  });
});

/**
 * The rules these tables prove absent, stated as the rules a reader expects.
 *
 * Everything above pins what the system does, and does it deliberately: a
 * decision table whose outcome is keyed on fewer conditions than it enumerates
 * is how this suite shows which conditions the write path ignores. The cost of
 * that choice is that the whole file stays green while the compliance rule the
 * programme is built on is enforced nowhere, so a reader running `npm test`
 * sees nothing wrong.
 *
 * These cases close that gap. Each asserts the rule a reader would expect to
 * hold, and each is marked `it.fails`, so the day one is enforced this file
 * turns red and someone has to come and delete the case on purpose. They are
 * the same findings as tests/techniques/findings/decision-tables.md, in a form
 * the test runner can report.
 */
describe('rules the write path does not enforce', () => {
  const FACE = 1_000_000;
  let db: Database;
  let world: World;

  beforeAll(async () => {
    db = await freshDatabase('decision_absent_rules', 'fixtures');
    world = await loadWorld(db.pool);
  });

  afterAll(async () => {
    await db?.close();
  });

  it.fails('refuses an approval from the same user who submitted the payable', async () => {
    const preparer = world.users.adata_preparer;
    const payable = await buildPayable(db.pool, {
      supplierId: world.suppliers[0].id,
      faceBase: FACE,
      termsDays: 90,
      upTo: 'pending_approval',
      submitAs: preparer,
    });

    const result = await post(db.pool, { kind: 'approve', payableId: payable.id }, { actorUserId: preparer });
    expect(result).toMatchObject({ ok: false });
    expect(await lifecycleOf(db.pool, payable.id)).toBe('pending_approval');
  });

  it.fails('refuses an approval from a role the lifecycle edge does not name', async () => {
    const payable = await buildPayable(db.pool, {
      supplierId: world.suppliers[0].id,
      faceBase: FACE,
      termsDays: 90,
      upTo: 'pending_approval',
    });

    const result = await post(
      db.pool,
      { kind: 'approve', payableId: payable.id },
      { actorUserId: world.users.supplier },
    );
    expect(result).toMatchObject({ ok: false });
    expect(await lifecycleOf(db.pool, payable.id)).toBe('pending_approval');
  });
});
