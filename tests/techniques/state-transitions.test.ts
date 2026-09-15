/**
 * State-transition testing for the payment and account lifecycles.
 *
 * The technique is complete coverage of a transition matrix, not a walk down
 * the happy path. Each machine below enumerates the full cross product of
 * (state, state) or (state, event) and asserts every cell in one comparison,
 * so a missing refusal shows up as a diff rather than as a case nobody wrote.
 *
 * Where the system stores its own machine, the matrix is derived from that
 * storage: the obligation states come from `pg_enum` and the legal edges from
 * `app.lifecycle_edge`, so adding an edge to the table changes what this suite
 * expects instead of silently passing. The literal shape of both is asserted
 * first, so deriving from data cannot degrade into asserting nothing.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Pool } from 'pg';
import {
  freshDatabase,
  post,
  actors,
  ledgerHealth,
  HEALTHY,
  type Database,
  type PostResult,
} from '../support/database';
import { TRANSITIONS, type LifecycleEvent } from '@/core/lifecycle';

type ObligationState =
  | 'draft'
  | 'pending_approval'
  | 'approved'
  | 'certified'
  | 'issued'
  | 'settled';

const LIFECYCLE_ORDER: readonly ObligationState[] = [
  'draft',
  'pending_approval',
  'approved',
  'certified',
  'issued',
  'settled',
];

const FACE_BASE = 1_000_000;

/** A term long enough that no clock advance in this suite reaches it. */
const LONG_TERM = 200;
/** A term the suite deliberately runs past, to reach `settled` and `matured`. */
const SHORT_TERM = 1;

// --- shared helpers ---------------------------------------------------------

/**
 * The enum members as the database holds them, so a matrix built from this
 * list gains a row and a column the moment someone adds a member.
 */
async function enumLabels(pool: Pool, qualifiedType: string): Promise<string[]> {
  const { rows } = await pool.query<{ label: string }>(
    `SELECT e.enumlabel AS label
       FROM pg_enum e
       JOIN pg_type t ON t.oid = e.enumtypid
       JOIN pg_namespace n ON n.oid = t.typnamespace
      WHERE n.nspname || '.' || t.typname = $1
      ORDER BY e.enumsortorder`,
    [qualifiedType],
  );
  return rows.map((row) => row.label);
}

/** One string per cell, so a whole matrix is a single literal comparison. */
function outcome(result: PostResult): string {
  return result.ok ? 'accepted' : `${result.code}: ${result.message}`;
}

interface World {
  pool: Pool;
  preparer: string;
  checker: string;
  admin: string;
  supplier: string;
  supplierId: string;
  supplierWallet: string;
  anchorId: string;
  buyer: string;
  buyerWallet: string;
  rivalWallet: string;
}

async function openWorld(pool: Pool): Promise<World> {
  const byRole = await actors(pool);
  const { rows } = await pool.query<{
    name: string;
    kind: string;
    entity_id: string;
    address: string;
  }>(
    `SELECT e.name, e.entity_type::text AS kind, e.id::text AS entity_id, w.address
       FROM app.entity e
       JOIN app.wallet w ON w.entity_id = e.id
      ORDER BY e.entity_type, e.name`,
  );
  const suppliers = rows.filter((row) => row.kind === 'supplier');
  const lenders = rows.filter((row) => row.kind === 'lender');
  const anchor = rows.find((row) => row.kind === 'anchor')!;
  return {
    pool,
    preparer: byRole.adata_preparer!,
    checker: byRole.adata_checker!,
    admin: byRole.straitsx_admin!,
    supplier: byRole.supplier!,
    supplierId: suppliers[0]!.entity_id,
    supplierWallet: suppliers[0]!.address,
    anchorId: anchor.entity_id,
    buyer: byRole.lender!,
    buyerWallet: lenders[0]!.address,
    rivalWallet: lenders[1]!.address,
  };
}

let tokenSeq = 0;

async function createDraft(world: World, ref: string, termsDays: number): Promise<string> {
  // No `payableId` in the intent: `ledger.post` writes the idempotency row,
  // including `payable_id`, before `create_payable` inserts the payable, so a
  // caller-chosen id fails the journal's foreign key. See the findings file.
  const created = await post(
    world.pool,
    {
      kind: 'create_payable',
      ref,
      supplierId: world.supplierId,
      invoiceRef: `INV-${ref}`,
      faceBase: FACE_BASE,
      termsDays,
    },
    { actorUserId: world.preparer },
  );
  if (!created.ok) throw new Error(`could not create ${ref}: ${created.code} ${created.message}`);
  const { rows } = await world.pool.query<{ id: string }>(
    'SELECT id::text FROM app.payable WHERE ref = $1',
    [ref],
  );
  return rows[0]!.id;
}

/**
 * Drive a payable to `target` through the commands a person would use, which
 * is both the honest way to reach a starting state and a second exercise of
 * every command in the chain. `settled` stops at `issued`, since settlement
 * needs the world clock past maturity and that is a decision for the caller.
 *
 * Each edge posts as the role app.lifecycle_edge names for it, or ledger.post
 * refuses it with ADA36. grade is not a lifecycle edge, so it carries no role
 * of its own; it is posted alongside certify as the straitsx_admin.
 */
async function park(
  world: World,
  ref: string,
  target: ObligationState,
  termsDays: number,
): Promise<string> {
  const payableId = await createDraft(world, ref, termsDays);
  const stop = LIFECYCLE_ORDER.indexOf(target === 'settled' ? 'issued' : target);
  for (let step = 1; step <= stop; step += 1) {
    tokenSeq += 1;
    const state = LIFECYCLE_ORDER[step];
    const actor =
      state === 'pending_approval'
        ? world.preparer
        : state === 'approved'
          ? world.checker
          : world.admin;
    const intents: Record<string, unknown>[] =
      state === 'pending_approval'
        ? [{ kind: 'submit', payableId }]
        : state === 'approved'
          ? [{ kind: 'approve', payableId }]
          : state === 'certified'
            ? [
                { kind: 'grade', payableId, grade: 'AAA', gradeRationale: 'matrix fixture' },
                { kind: 'certify', payableId },
              ]
            : [
                {
                  kind: 'issue_payable',
                  payableId,
                  toWallet: world.supplierWallet,
                  tokenId: 900_000 + tokenSeq,
                },
              ];
    for (const intent of intents) {
      const done = await post(world.pool, intent, { actorUserId: actor });
      if (!done.ok) {
        throw new Error(`could not park ${ref} at ${state}: ${done.code} ${done.message}`);
      }
    }
  }
  return payableId;
}

async function lifecycleOf(pool: Pool, payableId: string): Promise<string> {
  const { rows } = await pool.query<{ lifecycle_status: string }>(
    'SELECT lifecycle_status::text FROM app.payable WHERE id = $1',
    [payableId],
  );
  return rows[0]!.lifecycle_status;
}

async function receiptOf(pool: Pool, payableId: string): Promise<string> {
  const { rows } = await pool.query<{ receipt_status: string | null }>(
    'SELECT receipt_status::text FROM app.payable WHERE id = $1',
    [payableId],
  );
  return rows[0]!.receipt_status ?? 'null';
}

async function listingStatusOf(pool: Pool, listingId: string): Promise<string> {
  const { rows } = await pool.query<{ status: string }>(
    'SELECT status::text FROM app.listing WHERE id = $1',
    [listingId],
  );
  return rows[0]!.status;
}

async function bidStatusOf(pool: Pool, bidId: string): Promise<string> {
  const { rows } = await pool.query<{ status: string }>(
    'SELECT status::text FROM app.bid WHERE id = $1',
    [bidId],
  );
  return rows[0]?.status ?? 'absent';
}

// ============================================================================
// MACHINE 1: the obligation lifecycle, app.payable.lifecycle_status
// ============================================================================

/**
 * Companion columns the row CHECKs demand of each target state, so a forced
 * transition can only ever be refused by the edge trigger. Without this an
 * illegal edge and a missing grade would be indistinguishable in the matrix.
 */
const NEEDS_GRADE = new Set<string>(['certified', 'issued', 'settled']);
const NEEDS_ISSUANCE_COLUMNS = new Set<string>(['issued', 'settled']);

const FORCE_LIFECYCLE = `
  UPDATE app.payable
     SET lifecycle_status = $2::app.obligation_state,
         grade = CASE WHEN $3::boolean THEN COALESCE(grade, 'AAA'::app.credit_grade) ELSE grade END,
         issue_date = CASE WHEN $4::boolean THEN COALESCE(issue_date, maturity_date - 1) ELSE issue_date END,
         receipt_status = CASE WHEN $4::boolean
                               THEN COALESCE(receipt_status, 'pending'::app.receipt_status)
                               ELSE NULL END
   WHERE id = $1`;

/**
 * Attempt a transition and undo it, so one parked payable can serve a whole
 * row of the matrix. The state is read back inside the transaction, before the
 * rollback, so an accepted cell is confirmed against the table rather than
 * against the absence of an error.
 */
async function forceTransition(
  pool: Pool,
  payableId: string,
  to: string,
): Promise<{ cell: string; landed: string }> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(FORCE_LIFECYCLE, [
      payableId,
      to,
      NEEDS_GRADE.has(to),
      NEEDS_ISSUANCE_COLUMNS.has(to),
    ]);
    const { rows } = await client.query<{ lifecycle_status: string }>(
      'SELECT lifecycle_status::text FROM app.payable WHERE id = $1',
      [payableId],
    );
    const landed = rows[0]!.lifecycle_status;
    await client.query('ROLLBACK');
    return { cell: `accepted -> ${landed}`, landed };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    const err = error as { code?: string; message?: string };
    return { cell: `${err.code}: ${err.message}`, landed: 'unchanged' };
  } finally {
    client.release();
  }
}

describe('machine 1: the obligation lifecycle', () => {
  let db: Database;
  let world: World;
  let edges: { from: string; to: string; role: string }[];
  let edgeKeys: Set<string>;
  const parked: Record<ObligationState, string> = {} as Record<ObligationState, string>;
  const cellPayable = new Map<string, { id: string; ref: string }>();

  const COMMANDS = ['submit', 'approve', 'certify', 'issue_payable', 'settle_maturity'] as const;
  type Command = (typeof COMMANDS)[number];

  const TARGET_OF: Record<string, ObligationState> = {
    submit: 'pending_approval',
    approve: 'approved',
    certify: 'certified',
    issue_payable: 'issued',
    settle_maturity: 'settled',
  };

  /** A cell reaches the clock-gated commands only if its payable has matured. */
  function termsFor(from: ObligationState, command: Command): number {
    return from === 'settled' || command === 'settle_maturity' ? SHORT_TERM : LONG_TERM;
  }

  beforeAll(async () => {
    db = await freshDatabase('st_lifecycle', 'fixtures');
    world = await openWorld(db.pool);

    const { rows } = await db.pool.query<{ from_state: string; to_state: string; actor_role: string }>(
      'SELECT from_state::text, to_state::text, actor_role::text FROM app.lifecycle_edge ORDER BY from_state, to_state',
    );
    edges = rows.map((row) => ({ from: row.from_state, to: row.to_state, role: row.actor_role }));
    edgeKeys = new Set(edges.map((edge) => `${edge.from}->${edge.to}`));

    for (const state of LIFECYCLE_ORDER) {
      parked[state] = await park(
        world,
        `MX-${state}`,
        state,
        state === 'settled' ? SHORT_TERM : LONG_TERM,
      );
    }

    for (const from of LIFECYCLE_ORDER) {
      for (const command of COMMANDS) {
        const ref = `CM-${from}-${command}`;
        cellPayable.set(`${from}/${command}`, {
          id: await park(world, ref, from, termsFor(from, command)),
          ref,
        });
      }
    }

    const advanced = await post(
      db.pool,
      { kind: 'advance_clock', days: SHORT_TERM },
      { actorUserId: world.admin },
    );
    if (!advanced.ok) throw new Error(`clock: ${advanced.code} ${advanced.message}`);

    const toSettle = [
      parked.settled,
      ...COMMANDS.map((command) => cellPayable.get(`settled/${command}`)!.id),
    ];
    for (const payableId of toSettle) {
      const settled = await post(
        db.pool,
        { kind: 'settle_maturity', payableId, fundingCode: 'XUSD' },
        { actorUserId: world.preparer },
      );
      if (!settled.ok) throw new Error(`could not settle: ${settled.code} ${settled.message}`);
    }
  });

  afterAll(async () => {
    await db?.close();
  });

  // ledger.post() refuses an edge driven by the wrong role with ADA36, reading
  // app.lifecycle_edge. src/core/lifecycle.ts decides whether to draw the
  // button. Two statements of one rule drift silently, and a wider list in
  // TypeScript renders a control the database then refuses, so tie them here.
  it('agrees with src/core/lifecycle about who may drive each edge', () => {
    const EVENT_OF: Record<string, LifecycleEvent> = {
      'draft->pending_approval': 'submit',
      'pending_approval->approved': 'approve',
      'approved->certified': 'certify',
      'certified->issued': 'issue',
      'issued->settled': 'settle',
    };
    expect(
      edges.map((e) => `${e.from}->${e.to}: ${e.role}`).sort(),
    ).toEqual(
      edges
        .map((e) => `${e.from}->${e.to}: ${TRANSITIONS[EVENT_OF[`${e.from}->${e.to}`]!].actors.join(',')}`)
        .sort(),
    );
  });

  it('stores exactly six obligation states and exactly five legal edges', async () => {
    expect(await enumLabels(db.pool, 'app.obligation_state')).toEqual([
      'draft',
      'pending_approval',
      'approved',
      'certified',
      'issued',
      'settled',
    ]);
    expect(edges).toEqual([
      { from: 'approved', to: 'certified', role: 'straitsx_admin' },
      { from: 'certified', to: 'issued', role: 'straitsx_admin' },
      { from: 'draft', to: 'pending_approval', role: 'adata_preparer' },
      { from: 'issued', to: 'settled', role: 'adata_preparer' },
      { from: 'pending_approval', to: 'approved', role: 'adata_checker' },
    ]);
    expect(await ledgerHealth(db.pool)).toEqual(HEALTHY);
  });

  it('parks one payable in each of the six states through ordinary commands', async () => {
    const landed: Record<string, string> = {};
    for (const state of LIFECYCLE_ORDER) landed[state] = await lifecycleOf(db.pool, parked[state]);
    expect(landed).toEqual({
      draft: 'draft',
      pending_approval: 'pending_approval',
      approved: 'approved',
      certified: 'certified',
      issued: 'issued',
      settled: 'settled',
    });
    expect(await ledgerHealth(db.pool)).toEqual(HEALTHY);
  });

  it('accepts the five stored edges and refuses the other twenty-five with ADA01', async () => {
    const observed: Record<string, string> = {};
    const expected: Record<string, string> = {};

    for (const from of LIFECYCLE_ORDER) {
      for (const to of LIFECYCLE_ORDER) {
        if (from === to) continue;
        const key = `${from}->${to}`;
        observed[key] = (await forceTransition(db.pool, parked[from], to)).cell;
        expected[key] = edgeKeys.has(key)
          ? `accepted -> ${to}`
          : `ADA01: illegal lifecycle transition ${from} -> ${to}`;
      }
    }

    expect(Object.keys(observed)).toHaveLength(30);
    expect(Object.values(expected).filter((cell) => cell.startsWith('accepted'))).toHaveLength(5);
    expect(observed).toEqual(expected);
    expect(await ledgerHealth(db.pool)).toEqual(HEALTHY);
  });

  it('treats a same-state write as a free no-op on all six diagonal cells', async () => {
    const observed: Record<string, string> = {};
    const expected: Record<string, string> = {};
    for (const state of LIFECYCLE_ORDER) {
      observed[`${state}->${state}`] = (await forceTransition(db.pool, parked[state], state)).cell;
      expected[`${state}->${state}`] = `accepted -> ${state}`;
    }
    expect(observed).toEqual(expected);
    expect(await ledgerHealth(db.pool)).toEqual(HEALTHY);
  });

  it('lets a write that never mentions lifecycle_status through the trigger', async () => {
    await db.pool.query('UPDATE app.payable SET grade_rationale = $2 WHERE id = $1', [
      parked.issued,
      'annotated without touching the lifecycle',
    ]);
    const { rows } = await db.pool.query<{ lifecycle_status: string; grade_rationale: string }>(
      'SELECT lifecycle_status::text, grade_rationale FROM app.payable WHERE id = $1',
      [parked.issued],
    );
    expect(rows[0]).toEqual({
      lifecycle_status: 'issued',
      grade_rationale: 'annotated without touching the lifecycle',
    });
    expect(await ledgerHealth(db.pool)).toEqual(HEALTHY);
  });

  it('covers the full state by command matrix and records which guard wins', async () => {
    const observed: Record<string, string> = {};
    const expected: Record<string, string> = {};
    // Every command below posts as world.admin (straitsx_admin), so a cell
    // whose edge names a different role now names its own ADA36 refusal
    // instead of landing.
    const roleFor = new Map(edges.map((edge) => [`${edge.from}->${edge.to}`, edge.role]));

    for (const from of LIFECYCLE_ORDER) {
      for (const command of COMMANDS) {
        const key = `${from}/${command}`;
        const { id, ref } = cellPayable.get(key)!;
        tokenSeq += 1;
        const intent: Record<string, unknown> =
          command === 'issue_payable'
            ? {
                kind: command,
                payableId: id,
                toWallet: world.supplierWallet,
                tokenId: 700_000 + tokenSeq,
              }
            : command === 'settle_maturity'
              ? { kind: command, payableId: id, fundingCode: 'XUSD' }
              : command === 'certify'
                ? { kind: command, payableId: id, grade: 'AAA' }
                : { kind: command, payableId: id };

        const result = await post(db.pool, intent, { actorUserId: world.admin });
        observed[key] = `${outcome(result)} -> ${await lifecycleOf(db.pool, id)}`;

        const to = TARGET_OF[command];
        const graded =
          LIFECYCLE_ORDER.indexOf(from) >= LIFECYCLE_ORDER.indexOf('certified');
        if (command === 'certify' && !graded) {
          expected[key] = `ADA35: payable ${ref} has no grade yet -> ${from}`;
        } else if (command === 'issue_payable' && from !== 'certified') {
          expected[key] =
            `ADA15: payable ${ref} is ${from} and must be certified before issuance -> ${from}`;
        } else if (command === 'settle_maturity' && from === 'settled') {
          expected[key] = `ADA16: payable ${ref} is already settled -> settled`;
        } else if (edgeKeys.has(`${from}->${to}`) && roleFor.get(`${from}->${to}`) !== 'straitsx_admin') {
          expected[key] =
            `ADA36: payable ${ref} moves from ${from} to ${to} on the ${roleFor.get(`${from}->${to}`)}, not the straitsx_admin -> ${from}`;
        } else if (from === to || edgeKeys.has(`${from}->${to}`)) {
          expected[key] = `accepted -> ${to}`;
        } else {
          expected[key] = `ADA01: illegal lifecycle transition ${from} -> ${to} -> ${from}`;
        }
      }
    }

    expect(Object.keys(observed)).toHaveLength(30);
    expect(observed).toEqual(expected);
    expect(await ledgerHealth(db.pool)).toEqual(HEALTHY);
  });

  it('refuses an ungraded certify by name, ahead of both the trigger and the CHECK', async () => {
    const payableId = await park(world, 'GUARD-ungraded', 'approved', LONG_TERM);
    const refused = await post(
      db.pool,
      { kind: 'certify', payableId },
      { actorUserId: world.admin },
    );
    expect(refused).toEqual({
      ok: false,
      code: 'ADA35',
      message: 'payable GUARD-ungraded has no grade yet',
    });
    expect(await lifecycleOf(db.pool, payableId)).toBe('approved');

    // The grade is its own command, so an inline grade on certify is refused
    // too: the guard reads the stored column, not the intent.
    const inline = await post(
      db.pool,
      { kind: 'certify', payableId, grade: 'AA', gradeRationale: 'graded on the retry' },
      { actorUserId: world.admin },
    );
    expect(inline).toMatchObject({ ok: false, code: 'ADA35' });
    expect(await lifecycleOf(db.pool, payableId)).toBe('approved');

    const graded = await post(
      db.pool,
      { kind: 'grade', payableId, grade: 'AA', gradeRationale: 'graded on the retry' },
      { actorUserId: world.admin },
    );
    expect(graded).toMatchObject({ ok: true });
    expect(
      await post(db.pool, { kind: 'certify', payableId }, { actorUserId: world.admin }),
    ).toMatchObject({ ok: true });
    expect(await lifecycleOf(db.pool, payableId)).toBe('certified');
    expect(await ledgerHealth(db.pool)).toEqual(HEALTHY);
  });

  it('lets the maturity guard win over the edge trigger for an unmatured payable', async () => {
    const payableId = await park(world, 'GUARD-unmatured', 'draft', LONG_TERM);
    const refused = await post(
      db.pool,
      { kind: 'settle_maturity', payableId, fundingCode: 'XUSD' },
      { actorUserId: world.preparer },
    );
    expect(refused).toEqual({
      ok: false,
      code: 'ADA12',
      message: 'payable GUARD-unmatured has not matured',
    });
    expect(await lifecycleOf(db.pool, payableId)).toBe('draft');
    expect(await ledgerHealth(db.pool)).toEqual(HEALTHY);
  });

  it('refuses settle_maturity without a fundingCode before it looks at the state', async () => {
    const refused = await post(
      db.pool,
      { kind: 'settle_maturity', payableId: parked.settled },
      { actorUserId: world.preparer },
    );
    expect(refused).toEqual({
      ok: false,
      code: 'ADA17',
      message: 'settle_maturity needs a fundingCode naming the asset the anchor pays from',
    });
    expect(await ledgerHealth(db.pool)).toEqual(HEALTHY);
  });

  it('names the ADA36 refusal for every legal edge driven by the wrong role', async () => {
    // lifecycle_edge.actor_role names a role per edge and ledger.post() now
    // reads it, refusing the wrong actor with ADA36 before the edge fires. A
    // supplier holds none of the five required roles, so driving each edge as
    // a supplier is still the cheapest proof, only now the proof is a named
    // refusal instead of a walk that lands anyway.
    const edgeCases: {
      from: ObligationState;
      to: ObligationState;
      role: string;
      intent: (payableId: string) => Record<string, unknown>;
    }[] = [
      {
        from: 'draft',
        to: 'pending_approval',
        role: 'adata_preparer',
        intent: (payableId) => ({ kind: 'submit', payableId }),
      },
      {
        from: 'pending_approval',
        to: 'approved',
        role: 'adata_checker',
        intent: (payableId) => ({ kind: 'approve', payableId }),
      },
      {
        from: 'approved',
        to: 'certified',
        role: 'straitsx_admin',
        intent: (payableId) => ({ kind: 'certify', payableId }),
      },
      {
        from: 'certified',
        to: 'issued',
        role: 'straitsx_admin',
        intent: (payableId) => {
          tokenSeq += 1;
          return {
            kind: 'issue_payable',
            payableId,
            toWallet: world.supplierWallet,
            tokenId: 800_000 + tokenSeq,
          };
        },
      },
      {
        from: 'issued',
        to: 'settled',
        role: 'adata_preparer',
        intent: (payableId) => ({ kind: 'settle_maturity', payableId, fundingCode: 'XUSD' }),
      },
    ];

    for (const edgeCase of edgeCases) {
      const ref = `ROLE-wrong-${edgeCase.from}`;
      const payableId = await park(world, ref, edgeCase.from, SHORT_TERM);
      if (edgeCase.from === 'approved') {
        // grade is not a lifecycle edge, so it is setup here rather than a
        // step; park() stops at approved ungraded and certify needs a grade.
        expect(
          await post(db.pool, { kind: 'grade', payableId, grade: 'A' }, { actorUserId: world.admin }),
        ).toMatchObject({ ok: true });
      }
      if (edgeCase.to === 'settled') {
        expect(
          await post(db.pool, { kind: 'advance_clock', days: SHORT_TERM }, { actorUserId: world.admin }),
        ).toMatchObject({ ok: true });
      }

      const result = await post(db.pool, edgeCase.intent(payableId), { actorUserId: world.supplier });
      expect(result).toEqual({
        ok: false,
        code: 'ADA36',
        message: `payable ${ref} moves from ${edgeCase.from} to ${edgeCase.to} on the ${edgeCase.role}, not the supplier`,
      });
      expect(await lifecycleOf(db.pool, payableId)).toBe(edgeCase.from);
    }
    expect(await ledgerHealth(db.pool)).toEqual(HEALTHY);
  });
});

// ============================================================================
// MACHINE 2: app.listing_status
// ============================================================================

interface Lot {
  payableId: string;
  listingId: string;
  bidId: string;
}

async function publishLot(world: World, ref: string): Promise<Lot> {
  const payableId = await park(world, ref, 'issued', LONG_TERM);
  const accepted = await post(
    world.pool,
    { kind: 'accept_receipt', payableId },
    { actorUserId: world.supplier },
  );
  if (!accepted.ok) throw new Error(`receipt ${ref}: ${accepted.code} ${accepted.message}`);

  const { rows } = await world.pool.query<{ listing_id: string; bid_id: string }>(
    'SELECT gen_random_uuid()::text AS listing_id, gen_random_uuid()::text AS bid_id',
  );
  const listingId = rows[0]!.listing_id;
  const bidId = rows[0]!.bid_id;

  const published = await post(
    world.pool,
    {
      kind: 'publish_listing',
      listingId,
      payableId,
      sellerWallet: world.supplierWallet,
      quantityBase: FACE_BASE,
      minPriceBase: 900_000,
      buyNowPriceBase: 990_000,
    },
    { actorUserId: world.supplier },
  );
  if (!published.ok) throw new Error(`publish ${ref}: ${published.code} ${published.message}`);

  const bid = await post(
    world.pool,
    {
      kind: 'place_bid',
      bidId,
      listingId,
      bidderWallet: world.buyerWallet,
      priceBase: 910_000,
      fundingCode: 'XUSD',
    },
    { actorUserId: world.buyer },
  );
  if (!bid.ok) throw new Error(`bid ${ref}: ${bid.code} ${bid.message}`);

  return { payableId, listingId, bidId };
}

describe('machine 2: app.listing_status', () => {
  let db: Database;
  let world: World;
  const lots = new Map<string, Lot>();

  const LISTING_STATUSES = ['open', 'filled', 'cancelled', 'closed_by_transfer'] as const;
  const LISTING_COMMANDS = ['cancel_listing', 'place_bid', 'accept_bid', 'buy_now'] as const;
  type ListingCommand = (typeof LISTING_COMMANDS)[number];

  const LANDS_AT: Record<ListingCommand, string> = {
    cancel_listing: 'cancelled',
    place_bid: 'open',
    accept_bid: 'filled',
    buy_now: 'filled',
  };

  beforeAll(async () => {
    db = await freshDatabase('st_listing', 'fixtures');
    world = await openWorld(db.pool);

    for (const status of LISTING_STATUSES) {
      for (const command of LISTING_COMMANDS) {
        const lot = await publishLot(world, `LS-${status}-${command}`);
        if (status === 'filled') {
          const filled = await post(
            db.pool,
            { kind: 'accept_bid', listingId: lot.listingId, bidId: lot.bidId },
            { actorUserId: world.supplier },
          );
          if (!filled.ok) throw new Error(`fill: ${filled.code} ${filled.message}`);
        } else if (status === 'cancelled' || status === 'closed_by_transfer') {
          const cancelled = await post(
            db.pool,
            { kind: 'cancel_listing', listingId: lot.listingId },
            { actorUserId: world.supplier },
          );
          if (!cancelled.ok) throw new Error(`cancel: ${cancelled.code} ${cancelled.message}`);
        }
        if (status === 'closed_by_transfer') {
          // No code path writes this member, so the only way to hold a listing
          // in it is to write it here. Coming from `cancelled` keeps the escrow
          // invariant satisfied, since neither status escrows anything.
          await db.pool.query(
            "UPDATE app.listing SET status = 'closed_by_transfer' WHERE id = $1",
            [lot.listingId],
          );
        }
        lots.set(`${status}/${command}`, lot);
      }
    }
  });

  afterAll(async () => {
    await db?.close();
  });

  it('stores exactly four listing statuses', async () => {
    expect(await enumLabels(db.pool, 'app.listing_status')).toEqual([
      'open',
      'filled',
      'cancelled',
      'closed_by_transfer',
    ]);
    expect(await ledgerHealth(db.pool)).toEqual(HEALTHY);
  });

  it('starts every listing at open and parks the other three statuses', async () => {
    const observed: Record<string, string> = {};
    for (const status of LISTING_STATUSES) {
      observed[status] = await listingStatusOf(db.pool, lots.get(`${status}/cancel_listing`)!.listingId);
    }
    expect(observed).toEqual({
      open: 'open',
      filled: 'filled',
      cancelled: 'cancelled',
      closed_by_transfer: 'closed_by_transfer',
    });
    expect(await ledgerHealth(db.pool)).toEqual(HEALTHY);
  });

  it('covers the full listing status by command matrix', async () => {
    const observed: Record<string, string> = {};
    const expected: Record<string, string> = {};

    for (const status of LISTING_STATUSES) {
      for (const command of LISTING_COMMANDS) {
        const key = `${status}/${command}`;
        const lot = lots.get(key)!;
        const intent: Record<string, unknown> =
          command === 'cancel_listing'
            ? { kind: command, listingId: lot.listingId }
            : command === 'place_bid'
              ? {
                  kind: command,
                  listingId: lot.listingId,
                  bidderWallet: world.rivalWallet,
                  priceBase: 915_000,
                  fundingCode: 'XUSD',
                }
              : command === 'accept_bid'
                ? { kind: command, listingId: lot.listingId, bidId: lot.bidId }
                : {
                    kind: command,
                    listingId: lot.listingId,
                    buyerWallet: world.rivalWallet,
                    fundingCode: 'XUSD',
                  };

        const result = await post(db.pool, intent, { actorUserId: world.buyer });
        observed[key] = `${outcome(result)} -> ${await listingStatusOf(db.pool, lot.listingId)}`;
        expected[key] =
          status === 'open'
            ? `accepted -> ${LANDS_AT[command]}`
            : `ADA11: listing is ${status} -> ${status}`;
      }
    }

    expect(Object.keys(observed)).toHaveLength(16);
    expect(Object.values(expected).filter((cell) => cell.startsWith('accepted'))).toHaveLength(4);
    expect(observed).toEqual(expected);
    expect(await ledgerHealth(db.pool)).toEqual(HEALTHY);
  });

  it('never writes closed_by_transfer from any command path', async () => {
    const lot = await publishLot(world, 'LS-dead-enum');
    const reached: string[] = [await listingStatusOf(db.pool, lot.listingId)];

    const bought = await post(
      db.pool,
      {
        kind: 'buy_now',
        listingId: lot.listingId,
        buyerWallet: world.rivalWallet,
        fundingCode: 'USDC',
      },
      { actorUserId: world.buyer },
    );
    expect(bought).toMatchObject({ ok: true });
    reached.push(await listingStatusOf(db.pool, lot.listingId));

    const second = await publishLot(world, 'LS-dead-enum-2');
    const cancelled = await post(
      db.pool,
      { kind: 'cancel_listing', listingId: second.listingId },
      { actorUserId: world.supplier },
    );
    expect(cancelled).toMatchObject({ ok: true });
    reached.push(await listingStatusOf(db.pool, second.listingId));

    const third = await publishLot(world, 'LS-dead-enum-3');
    const accepted = await post(
      db.pool,
      { kind: 'accept_bid', listingId: third.listingId, bidId: third.bidId },
      { actorUserId: world.supplier },
    );
    expect(accepted).toMatchObject({ ok: true });
    reached.push(await listingStatusOf(db.pool, third.listingId));

    // settle_maturity is the fourth and last writer of listing.status.
    const matured = await publishLot(world, 'LS-dead-enum-4');
    await db.pool.query('UPDATE app.payable SET maturity_date = maturity_date WHERE id = $1', [
      matured.payableId,
    ]);
    const advanced = await post(
      db.pool,
      { kind: 'advance_clock', days: LONG_TERM },
      { actorUserId: world.admin },
    );
    expect(advanced).toMatchObject({ ok: true });
    const settled = await post(
      db.pool,
      { kind: 'settle_maturity', payableId: matured.payableId, fundingCode: 'XUSD' },
      { actorUserId: world.preparer },
    );
    expect(settled).toMatchObject({ ok: true });
    reached.push(await listingStatusOf(db.pool, matured.listingId));

    expect([...new Set(reached)].sort()).toEqual(['cancelled', 'filled', 'open']);
    expect(await enumLabels(db.pool, 'app.listing_status')).toContain('closed_by_transfer');
    expect(await ledgerHealth(db.pool)).toEqual(HEALTHY);
  });

  it('cannot reach the transfer cascade closed_by_transfer was named for', async () => {
    // PRD section 9: "A transfer that would reduce the holding below the listed
    // quantity must close the listing and expire its bids as part of the
    // transfer." Escrow is a real account, so the listed quantity has already
    // left the free balance and no transfer can undercut it. The cascade has
    // nothing to cascade from, which is why nothing writes the enum member.
    const payableId = await park(world, 'LS-transfer', 'issued', LONG_TERM);
    expect(
      await post(db.pool, { kind: 'accept_receipt', payableId }, { actorUserId: world.supplier }),
    ).toMatchObject({ ok: true });

    const { rows } = await db.pool.query<{ listing_id: string }>(
      'SELECT gen_random_uuid()::text AS listing_id',
    );
    const listingId = rows[0]!.listing_id;
    expect(
      await post(
        db.pool,
        {
          kind: 'publish_listing',
          listingId,
          payableId,
          sellerWallet: world.supplierWallet,
          quantityBase: 600_000,
          minPriceBase: 500_000,
        },
        { actorUserId: world.supplier },
      ),
    ).toMatchObject({ ok: true });

    const overreach = await post(
      db.pool,
      {
        kind: 'transfer',
        payableId,
        fromWallet: world.supplierWallet,
        toWallet: world.buyerWallet,
        quantityBase: 500_000,
      },
      { actorUserId: world.supplier },
    );
    expect(overreach).toEqual({
      ok: false,
      code: 'ADA21',
      message: `wallet ${world.supplierWallet} holds 400000 unlisted, needs 500000`,
    });
    expect(await listingStatusOf(db.pool, listingId)).toBe('open');

    const within = await post(
      db.pool,
      {
        kind: 'transfer',
        payableId,
        fromWallet: world.supplierWallet,
        toWallet: world.buyerWallet,
        quantityBase: 400_000,
      },
      { actorUserId: world.supplier },
    );
    expect(within).toMatchObject({ ok: true });
    expect(await listingStatusOf(db.pool, listingId)).toBe('open');
    expect(await ledgerHealth(db.pool)).toEqual(HEALTHY);
  });

  it('refuses a second open listing for the same seller and target with a bare unique violation', async () => {
    const lot = await publishLot(world, 'LS-duplicate');
    const again = await post(
      db.pool,
      {
        kind: 'publish_listing',
        payableId: lot.payableId,
        sellerWallet: world.supplierWallet,
        quantityBase: 1,
        minPriceBase: 1,
      },
      { actorUserId: world.supplier },
    );
    expect(again).toMatchObject({ ok: false, code: '23505' });
    expect((again as { message: string }).message).toContain('one_open_listing_per_seller_target');
    expect(await listingStatusOf(db.pool, lot.listingId)).toBe('open');
    expect(await ledgerHealth(db.pool)).toEqual(HEALTHY);
  });
});

// ============================================================================
// MACHINE 3: app.bid_status
// ============================================================================

describe('machine 3: app.bid_status', () => {
  let db: Database;
  let world: World;
  const lots = new Map<string, Lot>();

  const BID_STATUSES = ['placed', 'accepted', 'withdrawn', 'superseded', 'absent'] as const;
  const BID_COMMANDS = ['accept_bid', 'withdraw_bid'] as const;

  const ABSENT_BID = '99999999-9999-4999-8999-999999999999';

  beforeAll(async () => {
    db = await freshDatabase('st_bid', 'fixtures');
    world = await openWorld(db.pool);

    for (const status of BID_STATUSES) {
      for (const command of BID_COMMANDS) {
        const lot = await publishLot(world, `BD-${status}-${command}`);
        if (status === 'withdrawn') {
          const withdrawn = await post(
            db.pool,
            { kind: 'withdraw_bid', bidId: lot.bidId },
            { actorUserId: world.buyer },
          );
          if (!withdrawn.ok) throw new Error(`withdraw: ${withdrawn.code} ${withdrawn.message}`);
        } else if (status === 'accepted' || status === 'superseded') {
          // Reaching either through a command would also take the listing out
          // of `open`, and the listing guard runs first. Writing the bid status
          // directly is the only way to put the bid guard under test at all.
          await db.pool.query('UPDATE app.bid SET status = $2::app.bid_status WHERE id = $1', [
            lot.bidId,
            status,
          ]);
        }
        lots.set(`${status}/${command}`, { ...lot, bidId: status === 'absent' ? ABSENT_BID : lot.bidId });
      }
    }
  });

  afterAll(async () => {
    await db?.close();
  });

  it('stores exactly four bid statuses', async () => {
    expect(await enumLabels(db.pool, 'app.bid_status')).toEqual([
      'placed',
      'accepted',
      'withdrawn',
      'superseded',
    ]);
    expect(await ledgerHealth(db.pool)).toEqual(HEALTHY);
  });

  it('place_bid lands a bid at placed on an open listing', async () => {
    const lot = await publishLot(world, 'BD-entry');
    expect(await bidStatusOf(db.pool, lot.bidId)).toBe('placed');
    expect(await listingStatusOf(db.pool, lot.listingId)).toBe('open');
    expect(await ledgerHealth(db.pool)).toEqual(HEALTHY);
  });

  it('covers the full bid status by command matrix against an open listing', async () => {
    const observed: Record<string, string> = {};
    const expected: Record<string, string> = {
      'placed/accept_bid': 'accepted -> accepted',
      'placed/withdraw_bid': 'accepted -> withdrawn',
      'accepted/accept_bid': 'ADA11: bid is accepted -> accepted',
      'accepted/withdraw_bid': 'accepted -> accepted',
      'withdrawn/accept_bid': 'ADA11: bid is withdrawn -> withdrawn',
      'withdrawn/withdraw_bid': 'accepted -> withdrawn',
      'superseded/accept_bid': 'ADA11: bid is superseded -> superseded',
      'superseded/withdraw_bid': 'accepted -> superseded',
      'absent/accept_bid': 'ADA34: only institutional lender accounts can buy -> absent',
      'absent/withdraw_bid': 'accepted -> absent',
    };

    for (const status of BID_STATUSES) {
      for (const command of BID_COMMANDS) {
        const key = `${status}/${command}`;
        const lot = lots.get(key)!;
        const intent =
          command === 'accept_bid'
            ? { kind: command, listingId: lot.listingId, bidId: lot.bidId }
            : { kind: command, bidId: lot.bidId };
        const result = await post(db.pool, intent, { actorUserId: world.supplier });
        observed[key] = `${outcome(result)} -> ${await bidStatusOf(db.pool, lot.bidId)}`;
      }
    }

    expect(Object.keys(observed)).toHaveLength(10);
    expect(observed).toEqual(expected);
    expect(await ledgerHealth(db.pool)).toEqual(HEALTHY);
  });

  it('supersedes every rival placed bid when one is accepted', async () => {
    const lot = await publishLot(world, 'BD-rivals');
    const { rows } = await db.pool.query<{ a: string; b: string }>(
      'SELECT gen_random_uuid()::text AS a, gen_random_uuid()::text AS b',
    );
    const rival = rows[0]!.a;
    const stale = rows[0]!.b;
    for (const [bidId, priceBase] of [
      [rival, 915_000],
      [stale, 905_000],
    ] as const) {
      const placed = await post(
        db.pool,
        {
          kind: 'place_bid',
          bidId,
          listingId: lot.listingId,
          bidderWallet: world.rivalWallet,
          priceBase,
          fundingCode: 'XUSD',
        },
        { actorUserId: world.buyer },
      );
      expect(placed).toMatchObject({ ok: true });
    }

    const accepted = await post(
      db.pool,
      { kind: 'accept_bid', listingId: lot.listingId, bidId: lot.bidId },
      { actorUserId: world.supplier },
    );
    expect(accepted).toMatchObject({ ok: true });
    expect({
      winner: await bidStatusOf(db.pool, lot.bidId),
      rival: await bidStatusOf(db.pool, rival),
      stale: await bidStatusOf(db.pool, stale),
      listing: await listingStatusOf(db.pool, lot.listingId),
    }).toEqual({
      winner: 'accepted',
      rival: 'superseded',
      stale: 'superseded',
      listing: 'filled',
    });
    expect(await ledgerHealth(db.pool)).toEqual(HEALTHY);
  });

  it('supersedes placed bids when the listing is cancelled', async () => {
    const lot = await publishLot(world, 'BD-cancel');
    const cancelled = await post(
      db.pool,
      { kind: 'cancel_listing', listingId: lot.listingId },
      { actorUserId: world.supplier },
    );
    expect(cancelled).toMatchObject({ ok: true });
    expect({
      bid: await bidStatusOf(db.pool, lot.bidId),
      listing: await listingStatusOf(db.pool, lot.listingId),
    }).toEqual({ bid: 'superseded', listing: 'cancelled' });
    expect(await ledgerHealth(db.pool)).toEqual(HEALTHY);
  });

  it('leaves a withdrawn bid withdrawn when the listing is later cancelled', async () => {
    const lot = await publishLot(world, 'BD-cancel-after-withdraw');
    const withdrawn = await post(
      db.pool,
      { kind: 'withdraw_bid', bidId: lot.bidId },
      { actorUserId: world.buyer },
    );
    expect(withdrawn).toMatchObject({ ok: true });
    const cancelled = await post(
      db.pool,
      { kind: 'cancel_listing', listingId: lot.listingId },
      { actorUserId: world.supplier },
    );
    expect(cancelled).toMatchObject({ ok: true });
    expect(await bidStatusOf(db.pool, lot.bidId)).toBe('withdrawn');
    expect(await ledgerHealth(db.pool)).toEqual(HEALTHY);
  });

  it('supersedes placed bids when the payable is settled at maturity', async () => {
    const payableId = await park(world, 'BD-settle', 'issued', SHORT_TERM);
    const accepted = await post(
      db.pool,
      { kind: 'accept_receipt', payableId },
      { actorUserId: world.supplier },
    );
    expect(accepted).toMatchObject({ ok: true });

    const { rows } = await db.pool.query<{ listing_id: string; bid_id: string }>(
      'SELECT gen_random_uuid()::text AS listing_id, gen_random_uuid()::text AS bid_id',
    );
    const listingId = rows[0]!.listing_id;
    const bidId = rows[0]!.bid_id;
    expect(
      await post(
        db.pool,
        {
          kind: 'publish_listing',
          listingId,
          payableId,
          sellerWallet: world.supplierWallet,
          quantityBase: FACE_BASE,
          minPriceBase: 900_000,
        },
        { actorUserId: world.supplier },
      ),
    ).toMatchObject({ ok: true });
    expect(
      await post(
        db.pool,
        {
          kind: 'place_bid',
          bidId,
          listingId,
          bidderWallet: world.buyerWallet,
          priceBase: 910_000,
          fundingCode: 'XUSD',
        },
        { actorUserId: world.buyer },
      ),
    ).toMatchObject({ ok: true });

    expect(
      await post(db.pool, { kind: 'advance_clock', days: SHORT_TERM }, { actorUserId: world.admin }),
    ).toMatchObject({ ok: true });
    expect(
      await post(
        db.pool,
        { kind: 'settle_maturity', payableId, fundingCode: 'XUSD' },
        { actorUserId: world.preparer },
      ),
    ).toMatchObject({ ok: true });

    expect({
      bid: await bidStatusOf(db.pool, bidId),
      listing: await listingStatusOf(db.pool, listingId),
      payable: await lifecycleOf(db.pool, payableId),
    }).toEqual({ bid: 'superseded', listing: 'cancelled', payable: 'settled' });
    expect(await ledgerHealth(db.pool)).toEqual(HEALTHY);
  });

  it('journals a bid_withdrawn entry even when no bid row was touched', async () => {
    const before = await db.pool.query<{ n: bigint }>(
      "SELECT count(*) AS n FROM ledger.journal_entry WHERE kind = 'bid_withdrawn'",
    );
    const phantom = await post(
      db.pool,
      { kind: 'withdraw_bid', bidId: ABSENT_BID },
      { actorUserId: world.buyer },
    );
    expect(phantom).toMatchObject({ ok: true });

    const after = await db.pool.query<{ n: bigint }>(
      "SELECT count(*) AS n FROM ledger.journal_entry WHERE kind = 'bid_withdrawn'",
    );
    expect(Number(after.rows[0]!.n)).toBe(Number(before.rows[0]!.n) + 1);

    const { rows } = await db.pool.query<{ bid_id: string | null; legs: bigint }>(
      `SELECT e.bid_id::text,
              (SELECT count(*) FROM ledger.journal_leg l WHERE l.entry_id = e.id) AS legs
         FROM ledger.journal_entry e
        WHERE e.kind = 'bid_withdrawn'
        ORDER BY e.seq DESC LIMIT 1`,
    );
    expect(rows[0]).toEqual({ bid_id: null, legs: 0n });
    expect(await ledgerHealth(db.pool)).toEqual(HEALTHY);
  });

  it.fails('should refuse accept_bid for a bid id that does not exist', async () => {
    expect(await ledgerHealth(db.pool)).toEqual(HEALTHY);
    const lot = await publishLot(world, 'BD-should-refuse-accept');
    const result = await post(
      db.pool,
      { kind: 'accept_bid', listingId: lot.listingId, bidId: ABSENT_BID },
      { actorUserId: world.supplier },
    );
    expect(result).toMatchObject({ ok: false, code: 'ADA11' });
  });

  it.fails('should refuse withdraw_bid for a bid id that does not exist', async () => {
    expect(await ledgerHealth(db.pool)).toEqual(HEALTHY);
    const result = await post(
      db.pool,
      { kind: 'withdraw_bid', bidId: ABSENT_BID },
      { actorUserId: world.buyer },
    );
    expect(result).toMatchObject({ ok: false, code: 'ADA11' });
  });

  it.fails('should refuse withdraw_bid for a bid that has already been accepted', async () => {
    expect(await ledgerHealth(db.pool)).toEqual(HEALTHY);
    const lot = await publishLot(world, 'BD-should-refuse-withdraw');
    expect(
      await post(
        db.pool,
        { kind: 'accept_bid', listingId: lot.listingId, bidId: lot.bidId },
        { actorUserId: world.supplier },
      ),
    ).toMatchObject({ ok: true });
    const result = await post(
      db.pool,
      { kind: 'withdraw_bid', bidId: lot.bidId },
      { actorUserId: world.buyer },
    );
    expect(result).toMatchObject({ ok: false, code: 'ADA11' });
  });
});

// ============================================================================
// MACHINE 4: app.payable.receipt_status
// ============================================================================

describe('machine 4: app.payable.receipt_status', () => {
  let db: Database;
  let world: World;
  const cells = new Map<string, { id: string; ref: string }>();

  const RECEIPT_STATES = ['null', 'pending', 'accepted', 'rejected'] as const;
  const RECEIPT_COMMANDS = ['accept_receipt', 'reject_receipt'] as const;

  beforeAll(async () => {
    db = await freshDatabase('st_receipt', 'fixtures');
    world = await openWorld(db.pool);

    for (const state of RECEIPT_STATES) {
      for (const command of RECEIPT_COMMANDS) {
        const ref = `RC-${state}-${command}`;
        // `null` is the pre-issuance value, so that row stops at `certified`.
        const id = await park(world, ref, state === 'null' ? 'certified' : 'issued', LONG_TERM);
        if (state === 'accepted' || state === 'rejected') {
          const settle = await post(
            db.pool,
            state === 'accepted'
              ? { kind: 'accept_receipt', payableId: id }
              : { kind: 'reject_receipt', payableId: id, holderWallet: world.supplierWallet },
            { actorUserId: world.supplier },
          );
          if (!settle.ok) throw new Error(`receipt ${ref}: ${settle.code} ${settle.message}`);
        }
        cells.set(`${state}/${command}`, { id, ref });
      }
    }
  });

  afterAll(async () => {
    await db?.close();
  });

  it('stores exactly three receipt statuses plus the nullable pre-issuance value', async () => {
    expect(await enumLabels(db.pool, 'app.receipt_status')).toEqual([
      'pending',
      'accepted',
      'rejected',
    ]);
    const { rows } = await db.pool.query<{ is_nullable: string }>(
      `SELECT is_nullable FROM information_schema.columns
        WHERE table_schema = 'app' AND table_name = 'payable' AND column_name = 'receipt_status'`,
    );
    expect(rows[0]).toEqual({ is_nullable: 'YES' });
    expect(await ledgerHealth(db.pool)).toEqual(HEALTHY);
  });

  it('issuance is the only entry into the receipt machine and it lands pending', async () => {
    const payableId = await park(world, 'RC-entry', 'certified', LONG_TERM);
    expect(await receiptOf(db.pool, payableId)).toBe('null');

    tokenSeq += 1;
    const issued = await post(
      db.pool,
      {
        kind: 'issue_payable',
        payableId,
        toWallet: world.supplierWallet,
        tokenId: 500_000 + tokenSeq,
      },
      { actorUserId: world.admin },
    );
    expect(issued).toMatchObject({ ok: true });
    expect({
      lifecycle: await lifecycleOf(db.pool, payableId),
      receipt: await receiptOf(db.pool, payableId),
    }).toEqual({ lifecycle: 'issued', receipt: 'pending' });
    expect(await ledgerHealth(db.pool)).toEqual(HEALTHY);
  });

  it('covers the full receipt status by command matrix', async () => {
    const observed: Record<string, string> = {};
    const expected: Record<string, string> = {};

    for (const state of RECEIPT_STATES) {
      for (const command of RECEIPT_COMMANDS) {
        const key = `${state}/${command}`;
        const { id } = cells.get(key)!;
        const result = await post(
          db.pool,
          command === 'accept_receipt'
            ? { kind: command, payableId: id }
            : { kind: command, payableId: id, holderWallet: world.supplierWallet },
          { actorUserId: world.supplier },
        );
        const code = result.ok ? 'accepted' : result.code;
        observed[key] = `${code} -> ${await receiptOf(db.pool, id)}`;

        if (state === 'null') {
          // The ADA15 guard tests `receipt_status <> 'pending'`, which is NULL
          // rather than true before issuance, so the row CHECK is what refuses.
          expected[key] = '23514 -> null';
        } else if (state === 'pending') {
          expected[key] = command === 'accept_receipt' ? 'accepted -> accepted' : 'accepted -> rejected';
        } else {
          expected[key] = `ADA15 -> ${state}`;
        }
      }
    }

    expect(Object.keys(observed)).toHaveLength(8);
    expect(observed).toEqual(expected);
    expect(await ledgerHealth(db.pool)).toEqual(HEALTHY);
  });

  it('names the state a second receipt decision collided with', async () => {
    const already = cells.get('accepted/accept_receipt')!;
    const twice = await post(
      db.pool,
      { kind: 'accept_receipt', payableId: already.id },
      { actorUserId: world.supplier },
    );
    expect(twice).toEqual({
      ok: false,
      code: 'ADA15',
      message: `payable ${already.ref} was already accepted`,
    });

    const rejected = cells.get('rejected/reject_receipt')!;
    const crossed = await post(
      db.pool,
      { kind: 'accept_receipt', payableId: rejected.id },
      { actorUserId: world.supplier },
    );
    expect(crossed).toEqual({
      ok: false,
      code: 'ADA15',
      message: `payable ${rejected.ref} was already rejected`,
    });
    expect(await ledgerHealth(db.pool)).toEqual(HEALTHY);
  });

  it('refuses a receipt before issuance and a cleared receipt after it', async () => {
    const draft = await park(world, 'RC-check-early', 'draft', LONG_TERM);
    const early = await db.pool
      .query("UPDATE app.payable SET receipt_status = 'pending' WHERE id = $1", [draft])
      .then(() => 'accepted')
      .catch((error: { code?: string }) => error.code);
    expect(early).toBe('23514');

    const issued = await park(world, 'RC-check-late', 'issued', LONG_TERM);
    const late = await db.pool
      .query('UPDATE app.payable SET receipt_status = NULL WHERE id = $1', [issued])
      .then(() => 'accepted')
      .catch((error: { code?: string }) => error.code);
    expect(late).toBe('23514');

    expect({
      draft: await receiptOf(db.pool, draft),
      issued: await receiptOf(db.pool, issued),
    }).toEqual({ draft: 'null', issued: 'pending' });
    expect(await ledgerHealth(db.pool)).toEqual(HEALTHY);
  });

  it('has no edge table of its own, so a direct write may walk the receipt backwards', async () => {
    const payableId = await park(world, 'RC-backwards', 'issued', LONG_TERM);
    expect(
      await post(db.pool, { kind: 'accept_receipt', payableId }, { actorUserId: world.supplier }),
    ).toMatchObject({ ok: true });
    await db.pool.query("UPDATE app.payable SET receipt_status = 'pending' WHERE id = $1", [
      payableId,
    ]);
    expect(await receiptOf(db.pool, payableId)).toBe('pending');
    expect(await ledgerHealth(db.pool)).toEqual(HEALTHY);
  });

  it.fails('should refuse accept_receipt before issuance with the ADA15 it has for the purpose', async () => {
    expect(await ledgerHealth(db.pool)).toEqual(HEALTHY);
    const payableId = await park(world, 'RC-should-refuse', 'certified', LONG_TERM);
    const result = await post(
      db.pool,
      { kind: 'accept_receipt', payableId },
      { actorUserId: world.supplier },
    );
    expect(result).toMatchObject({ ok: false, code: 'ADA15' });
  });
});

// ============================================================================
// MACHINE 5: app.certification_status on the issuer
// ============================================================================

describe('machine 5: app.certification_status', () => {
  let db: Database;
  let world: World;
  let subjectId: string;

  const CERTIFICATION_STATES = ['uncertified', 'certified', 'suspended'] as const;

  beforeAll(async () => {
    db = await freshDatabase('st_certification', 'fixtures');
    world = await openWorld(db.pool);
    subjectId = world.supplierId;
  });

  afterAll(async () => {
    await db?.close();
  });

  async function certificationOf(entityId: string): Promise<string> {
    const { rows } = await db.pool.query<{ certification_status: string }>(
      'SELECT certification_status::text FROM app.entity WHERE id = $1',
      [entityId],
    );
    return rows[0]!.certification_status;
  }

  async function setCertification(entityId: string, status: string): Promise<PostResult> {
    return post(
      db.pool,
      { kind: 'set_certification', entityId, status },
      { actorUserId: world.admin },
    );
  }

  it('stores exactly three certification statuses', async () => {
    expect(await enumLabels(db.pool, 'app.certification_status')).toEqual([
      'uncertified',
      'certified',
      'suspended',
    ]);
    expect(await ledgerHealth(db.pool)).toEqual(HEALTHY);
  });

  it('permits every cell of the three by three matrix, diagonal included', async () => {
    const observed: Record<string, string> = {};
    const expected: Record<string, string> = {};

    for (const from of CERTIFICATION_STATES) {
      for (const to of CERTIFICATION_STATES) {
        const seeded = await setCertification(subjectId, from);
        expect(seeded).toMatchObject({ ok: true });
        expect(await certificationOf(subjectId)).toBe(from);

        const result = await setCertification(subjectId, to);
        observed[`${from}->${to}`] = `${outcome(result)} -> ${await certificationOf(subjectId)}`;
        expected[`${from}->${to}`] = `accepted -> ${to}`;
      }
    }

    expect(Object.keys(observed)).toHaveLength(9);
    expect(observed).toEqual(expected);
    expect(await ledgerHealth(db.pool)).toEqual(HEALTHY);
  });

  it('refuses a value outside the enum and an entity that is not there', async () => {
    const before = await certificationOf(subjectId);
    expect(await setCertification(subjectId, 'revoked')).toEqual({
      ok: false,
      code: 'ADA19',
      message: 'unknown certification status revoked',
    });
    expect(await setCertification('99999999-9999-4999-8999-999999999999', 'certified')).toEqual({
      ok: false,
      code: 'ADA24',
      message: 'no such organisation',
    });
    expect(await certificationOf(subjectId)).toBe(before);
    expect(await ledgerHealth(db.pool)).toEqual(HEALTHY);
  });

  it('suspends issuance and restores it in one unreviewed step', async () => {
    const payableId = await park(world, 'CT-suspend', 'certified', LONG_TERM);
    expect(await setCertification(world.anchorId, 'suspended')).toMatchObject({ ok: true });

    tokenSeq += 1;
    const issue = {
      kind: 'issue_payable',
      payableId,
      toWallet: world.supplierWallet,
      tokenId: 300_000 + tokenSeq,
    };
    const blocked = await post(db.pool, issue, { actorUserId: world.admin });
    expect(blocked).toMatchObject({ ok: false, code: 'ADA32' });
    expect((blocked as { message: string }).message).toContain(
      'is suspended and cannot issue under this programme',
    );
    expect(await lifecycleOf(db.pool, payableId)).toBe('certified');

    expect(await setCertification(world.anchorId, 'uncertified')).toMatchObject({ ok: true });
    const stillBlocked = await post(db.pool, issue, { actorUserId: world.admin });
    expect(stillBlocked).toMatchObject({ ok: false, code: 'ADA32' });
    expect((stillBlocked as { message: string }).message).toContain(
      'is uncertified and cannot issue under this programme',
    );

    // No intermediate state and no second approver: suspended goes straight
    // back to certified and issuance works again on the next command.
    expect(await setCertification(world.anchorId, 'certified')).toMatchObject({ ok: true });
    const allowed = await post(db.pool, issue, { actorUserId: world.admin });
    expect(allowed).toMatchObject({ ok: true });
    expect(await lifecycleOf(db.pool, payableId)).toBe('issued');
    expect(await ledgerHealth(db.pool)).toEqual(HEALTHY);
  });
});
