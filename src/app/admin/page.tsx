import {
  Amount,
  DaysRemaining,
  GradeBadge,
  Notice,
  Panel,
  Stat,
  StatusChip,
} from '@/components/primitives';
import { formatUnits } from '@/core/money';
import { readPayables, readProgrammeTotals, readWorld } from '@/db/read';

/**
 * PRD §8 screen 16. Programme oversight.
 *
 * "Issued, financed, settled, and overdue totals, with access to event history
 * and the sample recovery case."
 *
 * The books panel is the one thing here that is not in the PRD. It earns its
 * place because this design derives every balance from an append-only journal,
 * and being able to show a bank that the figures on screen are a fold of the
 * transaction log, checked live, is the strongest thing the architecture has to
 * say for itself.
 */
export default async function AdminPage() {
  const world = await readWorld();
  const [totals, payables] = await Promise.all([
    readProgrammeTotals(world),
    readPayables(world, { includeSeriesMembers: true }),
  ]);
  const overdue = payables.filter((p) => p.status === 'overdue');

  return (
    <div className="space-y-3">
      <div>
        <h1 className="text-[15px] font-semibold">Programme oversight</h1>
        <p className="text-[11.5px] text-ink-muted">
          StraitsX platform view of the ADATA tokenised payables programme.
        </p>
      </div>

      <div className="grid grid-cols-2 gap-2 md:grid-cols-5">
        <Stat label="Issued" value={formatUnits(totals.issuedFaceBase, 2)} hint={`${totals.issuedCount} payables`} />
        <Stat label="Financed" value={formatUnits(totals.financedFaceBase, 2)} hint="sold to lenders" />
        <Stat label="Unfinanced" value={formatUnits(totals.unfinancedFaceBase, 2)} hint="held by suppliers" />
        <Stat label="Settled" value={formatUnits(totals.settledFaceBase, 2)} hint="paid at maturity" />
        <Stat
          label="Overdue"
          value={formatUnits(totals.overdueFaceBase, 2)}
          tone={totals.overdueFaceBase > 0n ? 'critical' : 'default'}
        />
      </div>

      <Panel title="Books">
        {totals.bookDrift === 0 ? (
          <Notice tone="positive">
            Every balance on every screen reconciles to the journal, checked just now across all
            accounts and assets. Balances here are not stored and edited; they are a fold of an
            append-only transaction log.
          </Notice>
        ) : (
          <Notice tone="critical">
            {totals.bookDrift} account balances disagree with the journal. This should never happen
            and indicates a write that bypassed the ledger.
          </Notice>
        )}
      </Panel>

      <Panel title="All payables" dense>
        <div className="overflow-x-auto">
          <table className="ledger">
            <thead>
              <tr>
                <th>Reference</th>
                <th>Supplier</th>
                <th>Grade</th>
                <th className="num">Face</th>
                <th className="num">Outstanding</th>
                <th>Maturity</th>
                <th className="num">Days</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {payables.map((p) => (
                <tr key={p.id}>
                  <td className="font-medium">{p.ref}</td>
                  <td className="text-ink-muted">{p.supplierName}</td>
                  <td>{p.grade ? <GradeBadge grade={p.grade} /> : '—'}</td>
                  <td><Amount value={p.faceBase} decimals={2} /></td>
                  <td><Amount value={p.outstandingBase} decimals={2} /></td>
                  <td className="num">{p.maturityDate}</td>
                  <td><DaysRemaining days={p.daysRemaining} /></td>
                  <td><StatusChip status={p.status} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>

      {overdue.map((p) => (
        <Panel key={p.id} title={`Recovery case — ${p.ref}`}>
          <div className="space-y-2">
            <Notice tone="caution">
              Read-only scenario. There is no operational recovery workflow behind this screen, and
              nothing here can be actioned.
            </Notice>
            <dl className="grid gap-x-6 gap-y-1 text-[12.5px] md:grid-cols-2">
              <Row label="Obligor">{p.anchorName}</Row>
              <Row label="Original supplier">{p.supplierName}</Row>
              <Row label="Face">{formatUnits(p.faceBase, 2)} XUSD</Row>
              <Row label="Due date">{p.maturityDate}</Row>
              <Row label="Days past due">{Math.abs(p.daysRemaining)}</Row>
              <Row label="Grace period">Expired</Row>
              <Row label="Recovery status">Referred to appointed liquidator</Row>
              <Row label="Appointed liquidator">Tseng &amp; Partners Restructuring (fictional)</Row>
            </dl>
            <p className="text-[11px] text-ink-faint">
              Every name and figure in this case is invented for the demo. Invoice disputes,
              cancellation, and live default handling are out of scope.
            </p>
          </div>
        </Panel>
      ))}
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-rule py-1">
      <dt className="text-ink-muted">{label}</dt>
      <dd className="text-right">{children}</dd>
    </div>
  );
}
