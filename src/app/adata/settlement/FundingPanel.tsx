'use client';

/**
 * PRD §8 screen 4. Fund settlement.
 *
 * "Fund settlement opens the funding-asset picker, conversion, source debit,
 * and per-holder XUSD credits before confirmation." Redemption is denominated
 * in XUSD (§3 question 13) and the asset is chosen only for payment, so the
 * choice made here changes what leaves ADATA's wallet and nothing about what
 * each holder receives.
 */

import { useState } from 'react';

import { ActionButton } from '@/components/ActionButton';
import { AssetPicker } from '@/components/AssetPicker';
import { Amount, Field, Notice } from '@/components/primitives';
import { settleMaturity } from '@/app/actions';
import { convert, formatRate } from '@/core/fx';
import { attempt, type Role } from '@/core/lifecycle';
import { type Asset, type BaseUnits, formatUnits } from '@/core/money';
import type { SerialBalances } from '@/db/read';

export function FundingPanel({
  actorRole,
  payableId,
  outstandingBase,
  holderCount,
  balances,
  xsgdPerXusdE6,
}: {
  actorRole: Role;
  payableId: string;
  outstandingBase: string;
  holderCount: number;
  balances: SerialBalances;
  xsgdPerXusdE6: string;
}) {
  const [asset, setAsset] = useState<Asset>('XUSD');

  const outstanding = BigInt(outstandingBase) as BaseUnits;
  const conversion = convert(outstanding, asset, BigInt(xsgdPerXusdE6));
  const debit = conversion.sourceDebit;
  const available = BigInt(balances[asset]) as BaseUnits;
  const short = available < debit;
  const holders = holderCount === 1 ? 'the holder' : `all ${holderCount} holders`;
  const permitted = attempt('matured', 'settle', actorRole);

  return (
    <>
      <div className="py-1.5">
        <AssetPicker value={asset} onChange={setAsset} />
      </div>
      {conversion.rate === null ? null : <Field label="Conversion">{formatRate(conversion.rate)}</Field>}
      <Field label="Source debit">
        <strong>
          <Amount value={debit} decimals={4} />
        </strong>{' '}
        {asset}
      </Field>
      <Field label={`ADATA ${asset} balance`}>
        <Amount value={available} decimals={2} className={short ? 'text-critical' : ''} /> {asset}
      </Field>

      {short ? (
        <Notice tone="critical">
          ADATA holds less {asset} than this settlement costs. Switch funding asset, or use
          Simulate top-up in the demo controls.
        </Notice>
      ) : null}

      <div className="pt-1">
        <ActionButton
          label="Fund settlement"
          confirm={
            <>
              Debits ADATA {formatUnits(debit, 4)} {asset} and credits {holders}{' '}
              {formatUnits(outstanding, 4)} XUSD in one operation. The payable is then settled
              and cannot move again.
            </>
          }
          disabled={short || !permitted.ok}
          disabledReason={
            permitted.ok
              ? `ADATA does not hold enough ${asset}. Use Simulate top-up.`
              : permitted.reason
          }
          action={settleMaturity}
          args={[payableId, asset]}
        />
      </div>
    </>
  );
}
