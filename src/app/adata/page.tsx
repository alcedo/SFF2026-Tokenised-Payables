import Link from 'next/link';

import {
  Amount,
  DaysRemaining,
  GradeBadge,
  LedgerScroll,
  Panel,
  Stat,
  StatusChip,
} from '@/components/primitives';
import { NextActionStrip } from '@/components/NextActionStrip';
import { currentPersona } from '@/app/session';
import { deriveNextAction } from '@/core/next-action';
import { formatUnits } from '@/core/money';
import { readPayables, readProgrammeTotals, readWorld } from '@/db/read';

/**
 * PRD §8 screen 1. ADATA's view of what it owes.
 *
 * The framing matters: ADATA receives no financing proceeds in this flow (§5).
 * It is looking at obligations it will discharge on their due dates, so the
 * headline figures are outstanding face and the next settlement date, not
 * anything resembling revenue.
 */
export default async function AdataDashboard() {
  const world = await readWorld();
  const [persona, totals, payables] = await Promise.all([
    currentPersona(),
    readProgrammeTotals(world),
    readPayables(world),
  ]);
  const next = deriveNextAction({
    actor: { role: persona.role, name: persona.name, wallet: persona.wallet },
    payables: payables.map((p) => ({
      id: p.id,
      ref: p.ref,
      storedStatus: p.storedStatus,
      status: p.status,
      daysRemaining: p.daysRemaining,
      grade: p.grade,
    })),
    holdings: [],
    listings: [],
  });

  const live = payables.filter(
    (p) => p.status === 'issued' || p.status === 'matured' || p.status === 'overdue',
  );
  const dueNow = live.filter((p) => p.daysRemaining <= 0);

  return (
    <div className="space-y-3">
      <div>
        <h1 className="text-[15px] font-semibold">Outstanding obligations</h1>
        <p className="text-[11.5px] text-ink-muted">
          ADATA Technology Co., Ltd. as anchor buyer. Every payable below is an obligation to pay
          face value at maturity, to whoever holds it then.
        </p>
      </div>

      <NextActionStrip action={next} />

      <div className="grid grid-cols-2 gap-2 md:grid-cols-5">
        <Stat label="Outstanding" value={totals.issuedCount} hint="payables" />
        <Stat label="Outstanding face" value={formatUnits(totals.issuedFaceBase, 2)} hint="XUSD" />
        <Stat
          label="Financed"
          value={formatUnits(totals.financedFaceBase, 2)}
          hint="face sold to lenders"
        />
        <Stat
          label="Unfinanced"
          value={formatUnits(totals.unfinancedFaceBase, 2)}
          hint="still with suppliers"
        />
        <Stat
          label="Next settlement"
          value={totals.nextSettlementDate ?? '—'}
          tone={dueNow.length > 0 ? 'caution' : 'default'}
          hint={dueNow.length > 0 ? `${dueNow.length} due now` : 'nothing due yet'}
        />
      </div>

      {dueNow.length > 0 ? (
        <Panel
          title="Due for settlement"
          action={
            <Link href="/adata/settlement" className="text-[12px] text-accent hover:underline">
              Fund settlement →
            </Link>
          }
          dense
        >
          <PayableTable rows={dueNow} />
        </Panel>
      ) : null}

      <Panel title="All outstanding payables" dense>
        <PayableTable rows={live} />
      </Panel>

      <p className="text-[11px] text-ink-faint">
        A series counts its members once. Split holdings still count as one payable. Grades are
        sample values and are not external ratings.
      </p>
    </div>
  );
}

function PayableTable({ rows }: { rows: Awaited<ReturnType<typeof readPayables>> }) {
  return (
    <LedgerScroll label="Payables">
      <table className="ledger">
        <thead>
          <tr>
            <th>Reference</th>
            <th>Invoice</th>
            <th>Original supplier</th>
            <th>Grade</th>
            <th className="num">Face</th>
            <th className="num">Outstanding</th>
            <th>Maturity</th>
            <th className="num">Days</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((p) => (
            <tr key={p.id}>
              <td className="font-medium">{p.ref}</td>
              <td className="text-ink-muted">{p.invoiceRef}</td>
              <td className="text-ink-muted">{p.supplierName}</td>
              <td>{p.grade ? <GradeBadge grade={p.grade} /> : '—'}</td>
              <td>
                <Amount value={p.faceBase} decimals={2} />
              </td>
              <td>
                <Amount value={p.outstandingBase} decimals={2} />
              </td>
              <td className="num">{p.maturityDate}</td>
              <td>
                <DaysRemaining days={p.daysRemaining} />
              </td>
              <td>
                <StatusChip status={p.status} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </LedgerScroll>
  );
}
