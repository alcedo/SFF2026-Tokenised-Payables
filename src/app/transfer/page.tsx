import { TransferForm } from './TransferForm';
import { EmptyState, Panel } from '@/components/primitives';
import { currentPersona } from '@/app/session';
import { readHoldings, readPersonas, readWorld } from '@/db/read';

/**
 * PRD §8 screen 13 and the "Send payable" item under Common to all users. Those
 * two entries describe the same flow with the same rules, so this is one screen
 * reachable by both supplier and lender, as screen 13 already says it is.
 *
 * "Enter an eligible platform wallet address and a quantity (default = full
 * holding), show the resolved recipient, confirm, and record the transfer
 * event. Reject quantities that exceed the sender's unlisted holding."
 */
export default async function TransferPage({
  searchParams,
}: {
  searchParams: Promise<{ payable?: string }>;
}) {
  const { payable } = await searchParams;
  const [persona, world] = await Promise.all([currentPersona(), readWorld()]);
  const [holdings, personas] = await Promise.all([
    readHoldings(persona.wallet, world),
    readPersonas(),
  ]);

  // Only unlisted quantity can move, and only before maturity.
  const transferable = holdings.filter((h) => h.freeBase > 0n && h.payable.daysRemaining > 0);

  const recipients = personas
    .filter((p) => p.wallet !== persona.wallet)
    .map((p) => ({ wallet: p.wallet, label: `${p.entityName} — ${p.name}` }));

  return (
    <div className="mx-auto max-w-3xl space-y-3">
      <div>
        <h1 className="text-[15px] font-semibold">Send payable</h1>
        <p className="text-[11.5px] text-ink-muted">
          Move any quantity you hold to another platform wallet. No payment changes hands; this is a
          transfer of ownership, not a sale.
        </p>
      </div>

      {transferable.length === 0 ? (
        <Panel dense>
          <EmptyState
            title="Nothing available to send."
            hint="Listed quantity is locked to its listing, and a payable at or past maturity cannot move. Withdraw a listing to free its quantity."
          />
        </Panel>
      ) : (
        <Panel>
          <TransferForm
            sender={persona.wallet}
            holdings={transferable.map((h) => ({
              payableId: h.payable.id,
              ref: h.payable.ref,
              anchorName: h.payable.anchorName,
              freeBase: h.freeBase.toString(),
              listedBase: h.listedBase.toString(),
              maturityDate: h.payable.maturityDate,
            }))}
            recipients={recipients}
            preselect={payable}
          />
        </Panel>
      )}
    </div>
  );
}
