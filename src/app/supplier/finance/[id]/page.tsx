import Link from 'next/link';
import { notFound } from 'next/navigation';

import { FinanceForm } from './FinanceForm';
import { Panel } from '@/components/primitives';
import { currentPersona } from '@/app/session';
import { readHoldings, readWorld } from '@/db/read';

/**
 * PRD §8 screen 7. Request financing.
 *
 * "Choose an eligible holding and the quantity to list (default = full
 * holding), enter a minimum XUSD price or use an indicative price, and
 * optionally set buy-now. Publish in XUSD with no currency picker."
 */
export default async function FinancePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const [persona, world] = await Promise.all([currentPersona(), readWorld()]);
  const holding = (await readHoldings(persona.wallet, world)).find((h) => h.payable.id === id);
  if (!holding) notFound();

  return (
    <div className="mx-auto max-w-3xl space-y-3">
      <Link href="/supplier" className="text-[12px] text-accent hover:underline">
        ← My tokenised payables
      </Link>

      <div>
        <h1 className="text-[15px] font-semibold">Request financing</h1>
        <p className="text-[11.5px] text-ink-muted">
          {holding.payable.ref} · {holding.payable.anchorName} owes this on{' '}
          {holding.payable.maturityDate}. Listing is denominated in XUSD; the buyer chooses how they
          fund it.
        </p>
      </div>

      <Panel>
        <FinanceForm
          payableId={holding.payable.id}
          sellerWallet={persona.wallet}
          freeBase={holding.freeBase.toString()}
          faceBase={holding.payable.faceBase.toString()}
          daysRemaining={holding.payable.daysRemaining}
        />
      </Panel>
    </div>
  );
}
