import Link from 'next/link';

import { Address, Amount, Field, MockTxRef, Notice } from '@/components/primitives';
import { fromBaseUnits } from '@/core/money';
import type { SerialReceipt } from '@/db/read';

export function ExplorerReceiptPanel({
  receipt,
  txHash,
  backHref,
}: {
  receipt: SerialReceipt | null;
  txHash: string;
  backHref: string;
}) {
  if (!receipt) {
    return (
      <div className="space-y-3">
        <Notice tone="caution">
          No simulated receipt for {txHash}. Audit-only events have no chain hash.
        </Notice>
        <Link href={backHref} scroll={false} className="text-[12px] text-accent hover:underline">
          Back to log
        </Link>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <div className="text-[10.5px] font-semibold tracking-wide text-ink-muted uppercase">
            Simulated receipt
          </div>
          <div className="mt-1">
            <MockTxRef hash={receipt.txHash} block={Number(receipt.blockNumber)} />
          </div>
        </div>
        <Link href={backHref} scroll={false} className="text-[12px] text-accent hover:underline">
          Back to log
        </Link>
      </div>

      <dl>
        <Field label="Event">{receipt.kind.replace(/_/g, ' ')}</Field>
        <Field label="Status">{receipt.status}</Field>
        <Field label="World date">{receipt.worldDate}</Field>
        <Field label="Actor">{receipt.actorName}</Field>
        <Field label="Payable">{receipt.payableRef ?? '—'}</Field>
        <Field label="Hash">
          <span className="addr break-all">{receipt.txHash}</span>
        </Field>
        {receipt.fundingAsset ? (
          <Field label={`Source debit (${receipt.fundingAsset})`}>
            <Amount value={fromBaseUnits(receipt.sourceAmountBase ?? '0')} decimals={4} />
          </Field>
        ) : null}
      </dl>

      <div>
        <h3 className="mb-1 text-[11px] font-semibold tracking-wide text-ink-muted uppercase">
          Movements
        </h3>
        <table className="ledger">
          <thead>
            <tr>
              <th>Direction</th>
              <th>Account</th>
              <th>Asset</th>
              <th className="num">Amount</th>
            </tr>
          </thead>
          <tbody>
            {receipt.movements.map((m) => (
              <tr key={m.legNo}>
                <td className="font-medium">{m.direction}</td>
                <td>
                  <div>{m.entityName ?? m.accountPurpose.replace(/_/g, ' ')}</div>
                  {m.wallet ? <Address value={m.wallet} /> : null}
                </td>
                <td>
                  {m.cashAsset ?? (m.tokenId ? `token ${m.tokenId}` : 'payable')}
                </td>
                <td>
                  <Amount value={fromBaseUnits(m.amountBase)} decimals={4} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
