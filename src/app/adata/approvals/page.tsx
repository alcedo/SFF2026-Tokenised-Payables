import { ActionButton } from '@/components/ActionButton';
import {
  Amount,
  EmptyState,
  GradeBadge,
  LedgerScroll,
  Panel,
  StatusChip,
} from '@/components/primitives';
import { approvePayable, certifyPayable, issuePayable, submitPayable } from '@/app/actions';
import { currentPersona } from '@/app/session';
import { attempt } from '@/core/lifecycle';
import { readEvents, readPayables, readPersonas, readWorld } from '@/db/read';

/**
 * PRD §8 screen 3. Approval queue.
 *
 * "Preparer submission and separate checker approval, with actor and timestamp
 * history. Certification and issuance status remain visible after approval."
 *
 * The separation is real rather than cosmetic: the lifecycle table in the
 * database refuses an approval from the preparer role, so switching persona is
 * the only way through. Each button below is disabled with the same reason the
 * database would give, so the rule is visible before it is hit.
 */
export default async function ApprovalsPage() {
  const [persona, world] = await Promise.all([currentPersona(), readWorld()]);
  const [payables, personas, events] = await Promise.all([
    readPayables(world),
    readPersonas(),
    readEvents({ limit: 60 }),
  ]);

  const inFlight = payables.filter((p) =>
    ['draft', 'pending_approval', 'approved', 'certified'].includes(p.storedStatus),
  );

  const historyFor = (payableId: string) =>
    events.filter(
      (e) =>
        e.payableRef === payables.find((p) => p.id === payableId)?.ref &&
        ['payable_created', 'submitted_for_approval', 'approved', 'certified', 'graded', 'issuance'].includes(
          e.kind,
        ),
    );

  return (
    <div className="space-y-3">
      <div>
        <h1 className="text-[15px] font-semibold">Approval queue</h1>
        <p className="text-[11.5px] text-ink-muted">
          A payable moves draft → pending approval → approved → certified → issued. The preparer who
          submits cannot approve; StraitsX certifies and issues.
        </p>
      </div>

      {inFlight.length === 0 ? (
        <Panel dense>
          <EmptyState
            title="Nothing awaiting approval."
            hint="Create a payable from the ERP inbox to start one through the queue."
          />
        </Panel>
      ) : (
        inFlight.map((p) => {
          const canSubmit = attempt(p.storedStatus, 'submit', persona.role).ok;
          const canApprove = attempt(p.storedStatus, 'approve', persona.role).ok;
          const canCertify = attempt(p.storedStatus, 'certify', persona.role).ok;
          const canIssue = attempt(p.storedStatus, 'issue', persona.role).ok;
          const supplierWallet = personas.find((x) => x.entityName === p.supplierName)?.wallet;
          const history = historyFor(p.id);

          return (
            <Panel
              key={p.id}
              title={
                <span className="flex items-center gap-2">
                  {p.ref}
                  <StatusChip status={p.storedStatus} />
                </span>
              }
            >
              <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_300px]">
                <div className="min-w-0">
                  <LedgerScroll label="Payable facts">
                  <table className="ledger">
                    <tbody>
                      <tr>
                        <td className="text-ink-muted">Supplier</td>
                        <td>{p.supplierName}</td>
                      </tr>
                      <tr>
                        <td className="text-ink-muted">Invoice</td>
                        <td>{p.invoiceRef}</td>
                      </tr>
                      <tr>
                        <td className="text-ink-muted">Face</td>
                        <td>
                          <Amount value={p.faceBase} decimals={2} showAsset asset="XUSD" />
                        </td>
                      </tr>
                      <tr>
                        <td className="text-ink-muted">Maturity</td>
                        <td className="num">{p.maturityDate}</td>
                      </tr>
                      <tr>
                        <td className="text-ink-muted">Grade</td>
                        <td>{p.grade ? <GradeBadge grade={p.grade} /> : 'not yet graded'}</td>
                      </tr>
                    </tbody>
                  </table>
                  </LedgerScroll>

                  {history.length > 0 ? (
                    <div className="mt-3">
                      <h3 className="mb-1 text-[10.5px] tracking-wide text-ink-muted uppercase">
                        Actor history
                      </h3>
                      <ul className="space-y-0.5">
                        {history.map((e) => (
                          <li key={e.entryId} className="text-[11.5px] text-ink-muted">
                            <span className="num">{e.worldDate}</span> · {e.kind.replace(/_/g, ' ')}{' '}
                            · <span className="text-ink">{e.actorName}</span> ({e.actorRole.replace(/_/g, ' ')})
                          </li>
                        ))}
                      </ul>
                    </div>
                  ) : null}
                </div>

                <div className="space-y-2">
                  {canSubmit ? (
                    <ActionButton
                      label="Submit for approval"
                      action={submitPayable}
                      args={[p.id]}
                    />
                  ) : null}
                  {p.storedStatus === 'pending_approval' ? (
                    <ActionButton
                      label="Approve"
                      disabled={!canApprove}
                      disabledReason="Only an ADATA checker may approve, and never the preparer who submitted."
                      confirm="Approving records you as the checker. This is a separate act from the submission."
                      action={approvePayable}
                      args={[p.id]}
                    />
                  ) : null}
                  {p.storedStatus === 'approved' ? (
                    <ActionButton
                      label="Certify"
                      disabled={!canCertify}
                      disabledReason="Only the StraitsX admin may certify a payable under the programme."
                      action={certifyPayable}
                      args={[p.id]}
                    />
                  ) : null}
                  {p.storedStatus === 'certified' ? (
                    <ActionButton
                      label="Issue to supplier"
                      disabled={!canIssue || !supplierWallet}
                      disabledReason="Only StraitsX or ADATA may issue, and the supplier needs a wallet."
                      confirm={
                        <>
                          Mints the full face to {p.supplierName}&apos;s wallet. One invoice, one
                          token id.
                        </>
                      }
                      action={issuePayable}
                      args={[p.id, supplierWallet!, Number(p.ref.slice(-4))]}
                    />
                  ) : null}
                  <p className="text-[10.5px] text-ink-faint">
                    Acting as {persona.name}, {persona.role.replace(/_/g, ' ')}. Switch persona in
                    the demo controls to take the next step.
                  </p>
                </div>
              </div>
            </Panel>
          );
        })
      )}
    </div>
  );
}
