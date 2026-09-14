import { GradeForm } from './GradeForm';
import { Amount, EmptyState, GradeBadge, Notice, Panel, StatusChip } from '@/components/primitives';
import { readPayables, readWorld } from '@/db/read';

/**
 * PRD §8 screen 15. Grading.
 *
 * "Assign AAA / AA / A with a sample rationale. Only certified, graded payables
 * can be listed. An advance-rate/LTV mapping is pending definition (§16); do
 * not present it as an external rating or guarantee."
 *
 * So there is no advance rate anywhere on this screen, and every grade carries
 * its Sample qualifier and its rationale.
 */
export default async function GradingPage() {
  const world = await readWorld();
  const payables = await readPayables(world);

  const ungraded = payables.filter((p) => p.grade === null);
  const graded = payables.filter((p) => p.grade !== null);

  return (
    <div className="space-y-3">
      <div>
        <h1 className="text-[15px] font-semibold">Grading</h1>
        <p className="text-[11.5px] text-ink-muted">
          Grades are assigned by StraitsX for this demo. They describe the anchor obligation, not
          the supplier.
        </p>
      </div>

      <Notice tone="caution">
        Sample values only. These are not external credit ratings, not an opinion of any rating
        agency, and carry no guarantee. No advance rate or loan-to-value mapping is published.
      </Notice>

      <Panel title={`Awaiting a grade (${ungraded.length})`}>
        {ungraded.length === 0 ? (
          <EmptyState title="Everything is graded." />
        ) : (
          <div className="space-y-3">
            {ungraded.map((p) => (
              <div key={p.id} className="border-b border-rule pb-3 last:border-b-0 last:pb-0">
                <div className="mb-1.5 flex items-center gap-2">
                  <span className="text-[13px] font-medium">{p.ref}</span>
                  <StatusChip status={p.storedStatus} />
                  <span className="text-[11.5px] text-ink-muted">
                    {p.supplierName} · <Amount value={p.faceBase} decimals={2} /> XUSD ·{' '}
                    {p.maturityDate}
                  </span>
                </div>
                <GradeForm payableId={p.id} payableRef={p.ref} />
              </div>
            ))}
          </div>
        )}
      </Panel>

      <Panel title="Graded" dense>
        <table className="ledger">
          <thead>
            <tr>
              <th>Reference</th>
              <th>Grade</th>
              <th>Rationale</th>
              <th className="num">Face</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {graded.map((p) => (
              <tr key={p.id}>
                <td className="font-medium">{p.ref}</td>
                <td>{p.grade ? <GradeBadge grade={p.grade} /> : '—'}</td>
                <td className="max-w-md text-ink-muted">{p.gradeRationale}</td>
                <td><Amount value={p.faceBase} decimals={2} /></td>
                <td><StatusChip status={p.status} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </Panel>
    </div>
  );
}
