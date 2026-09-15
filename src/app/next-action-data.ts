import { deriveNextAction, type NextAction, type NextActionSnapshot } from '@/core/next-action';
import { readHoldings, readMarketplace, readPayables, type Persona, type World } from '@/db/read';

export async function loadNextActionSnapshot(persona: Persona, world: World): Promise<NextActionSnapshot> {
  const [payables, holdings, listings] = await Promise.all([
    readPayables(world),
    readHoldings(persona.wallet, world),
    readMarketplace(world),
  ]);
  return {
    actor: { role: persona.role, name: persona.name, wallet: persona.wallet },
    payables: payables.map((p) => ({
      id: p.id,
      ref: p.ref,
      storedStatus: p.storedStatus,
      status: p.status,
      daysRemaining: p.daysRemaining,
      grade: p.grade,
    })),
    holdings: holdings.map((h) => ({
      receipt: h.receipt,
      freeBase: h.freeBase,
      payable: {
        id: h.payable.id,
        ref: h.payable.ref,
        status: h.payable.status,
        daysRemaining: h.payable.daysRemaining,
      },
    })),
    listings: listings.map((l) => ({
      id: l.id,
      targetRef: l.targetRef,
      sellerWallet: l.sellerWallet,
      bidCount: l.bidCount,
    })),
  };
}

export async function loadNextAction(persona: Persona, world: World): Promise<NextAction> {
  return deriveNextAction(await loadNextActionSnapshot(persona, world));
}
