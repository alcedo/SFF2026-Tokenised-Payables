import { ActionButton } from '@/components/ActionButton';
import {
  Amount,
  EmptyState,
  GradeBadge,
  LedgerScroll,
  Notice,
  Panel,
  StatusChip,
} from '@/components/primitives';
import { GradeForm } from '@/app/admin/grading/GradeForm';
import {
  approvePayable,
  cancelPayable,
  certifyPayable,
  issuePayable,
  submitPayable,
} from '@/app/actions';
import { currentPersona } from '@/app/session';
import { attempt, pendingStep, ROLE_LABELS } from '@/core/lifecycle';
import { readEvents, readPayables, readPersonas, readWorld } from '@/db/read';

/** The journal kinds that make up a payable's approval trail. */
const HISTORY_KINDS = [
  'payable_created',
  'submitted_for_approval',
  'approved',
  'certified',
  'graded',
  'issuance',
];

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

  // A payable the supplier refused is issued and stuck: it cannot trade, it
  // cannot be redeemed, and the clock will carry it to maturity regardless. The
  // checker who approved it is the one who withdraws it. See
  // docs/ASSUMPTIONS.md; the PRD does not say what becomes of a rejection.
  const refused = payables.filter((p) => p.storedStatus === 'issued' && p.receipt === 'rejected');

  // Whose move each one is, and the sentence that says so, decided once. The
  // header count and the notice on each row are the same question asked at two
  // altitudes, and deriving it twice is how the number and the rows drift.
  const queue = inFlight.map((p) => {
    const step = pendingStep(p.storedStatus);
    if (!step) return { payable: p, yourTurn: false, notice: null };

    const yourTurn = step.actors.includes(persona.role);
    const holders = personas.filter((x) => step.actors.includes(x.role)).map((x) => x.name);
    const ask =
      p.storedStatus === 'approved' && p.grade === null
        ? 'assign a grade, then certify it'
        : step.action;
    return {
      payable: p,
      yourTurn,
      notice: {
        heading: yourTurn
          ? 'Your turn'
          : `Waiting on the ${listOf(step.actors.map((r) => ROLE_LABELS[r]))}`,
        // `holders` can be empty. The admin may remove the last person holding
        // a role (PRD §5 permits zero StraitsX admins, only not two), and a row
        // that then says "must certify it" with nobody named is a dead end the
        // presenter cannot read their way out of.
        detail: yourTurn
          ? `You are ${persona.name}, ${ROLE_LABELS[persona.role]}. Next step: ${ask}.`
          : holders.length > 0
            ? `${listOf(holders)} must ${ask}. Switch persona in the demo controls to act as them.`
            : `No active account holds that role, so nobody can ${ask} yet. Add one on the accounts screen.`,
      },
    };
  });
  const mine = queue.filter((q) => q.yourTurn).length;

  // One pass over the journal rather than a scan per payable. The predicate
  // used to re-find the payable for every event it tested, which on the seeded
  // catalogue is tens of thousands of comparisons for a page of thirty rows.
  const historyByRef = new Map<string, typeof events>();
  for (const e of events) {
    if (e.payableRef === null || !HISTORY_KINDS.includes(e.kind)) continue;
    const seen = historyByRef.get(e.payableRef);
    if (seen) seen.push(e);
    else historyByRef.set(e.payableRef, [e]);
  }

  return (
    <div className="space-y-3">
      <div>
        <h1 className="text-[15px] font-semibold">Approval queue</h1>
        <p className="text-[11.5px] text-ink-muted">
          A payable moves draft → pending approval → approved → certified → issued. The preparer who
          submits cannot approve; StraitsX certifies and issues.
        </p>
        {inFlight.length > 0 ? (
          <p className="mt-1 text-[11.5px]">
            {mine > 0 ? (
              <span className="font-medium text-accent">
                {mine} of {inFlight.length} {mine === 1 ? 'is' : 'are'} waiting on you,{' '}
                {persona.name}.
              </span>
            ) : (
              <span className="text-ink-muted">
                Nothing here is waiting on {persona.name}, {ROLE_LABELS[persona.role]}. Switch
                persona in the demo controls to take the next step.
              </span>
            )}
          </p>
        ) : null}
      </div>

      {inFlight.length === 0 ? (
        <Panel dense>
          <EmptyState
            title="Nothing awaiting approval."
            hint="Create a payable from the ERP inbox to start one through the queue."
          />
        </Panel>
      ) : (
        queue.map(({ payable: p, yourTurn, notice }) => {
          const canSubmit = attempt(p.storedStatus, 'submit', persona.role).ok;
          const canApprove = attempt(p.storedStatus, 'approve', persona.role).ok;
          const canCertify = attempt(p.storedStatus, 'certify', persona.role).ok;
          const canIssue = attempt(p.storedStatus, 'issue', persona.role).ok;
          const supplierWallet = personas.find((x) => x.entityName === p.supplierName)?.wallet;
          const history = historyByRef.get(p.ref) ?? [];

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
              <div className="grid min-w-0 gap-4 md:grid-cols-[minmax(0,1fr)_300px]">
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
                            · <span className="text-ink">{e.actorName}</span> ({ROLE_LABELS[e.actorRole]})
                          </li>
                        ))}
                      </ul>
                    </div>
                  ) : null}
                </div>

                <div className="space-y-2">
                  {notice ? (
                    <Notice tone={yourTurn ? 'accent' : 'caution'}>
                      <span className="block text-[11px] font-semibold tracking-wide uppercase">
                        {notice.heading}
                      </span>
                      <span className="mt-0.5 block text-[11.5px] text-ink-muted">
                        {notice.detail}
                      </span>
                    </Notice>
                  ) : null}
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
                    persona.role === 'straitsx_admin' && p.grade === null ? (
                      <GradeForm payableId={p.id} payableRef={p.ref} />
                    ) : (
                      <ActionButton
                        label="Certify"
                        disabled={!canCertify || p.grade === null}
                        disabledReason={
                          p.grade === null
                            ? 'Assign a grade before certifying.'
                            : 'Only the StraitsX admin may certify a payable under the programme.'
                        }
                        action={certifyPayable}
                        args={[p.id]}
                      />
                    )
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
                </div>
              </div>
            </Panel>
          );
        })
      )}

      {refused.length > 0 ? (
        <Panel title="Refused by their supplier">
          <p className="mb-2 text-[11.5px] text-ink-muted">
            The supplier rejected delivery of these, so nobody may trade them and ADATA may not
            settle them. Cancelling burns the tokens back out of the supplier&apos;s wallet and
            closes the obligation. The {ROLE_LABELS.adata_checker} does it, as with the approval.
          </p>
          <div className="space-y-2">
            {refused.map((p) => (
              <div
                key={p.id}
                className="flex flex-wrap items-center justify-between gap-2 border-b border-rule py-2 last:border-b-0"
              >
                <div className="min-w-0">
                  <span className="text-[12.5px] font-medium">{p.ref}</span>
                  <span className="ml-2 text-[11.5px] text-ink-muted">
                    {p.supplierName} · {p.invoiceRef} ·{' '}
                    <Amount value={p.faceBase} decimals={2} showAsset asset="XUSD" />
                  </span>
                </div>
                <ActionButton
                  label="Cancel payable"
                  variant="danger"
                  disabled={!attempt(p.storedStatus, 'cancel', persona.role).ok}
                  disabledReason={`Only the ${ROLE_LABELS.adata_checker} may cancel a refused payable.`}
                  confirm={
                    <>
                      Burns the full face of {p.ref} out of {p.supplierName}&apos;s wallet and
                      closes the obligation. There is no way back from cancelled.
                    </>
                  }
                  action={cancelPayable}
                  args={[p.id]}
                />
              </div>
            ))}
          </div>
        </Panel>
      ) : null}
    </div>
  );
}

/**
 * "a, b, or c". The issue step admits three roles, and a bare comma list reads
 * as a requirement for all of them rather than any one.
 */
const LIST = new Intl.ListFormat('en', { type: 'disjunction' });
function listOf(parts: readonly string[]): string {
  return LIST.format(parts);
}
