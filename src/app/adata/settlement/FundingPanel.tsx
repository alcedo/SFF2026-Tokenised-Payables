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
import { Field, Notice } from '@/components/primitives';
import { settleMaturity } from '@/app/actions';
import { convert, formatRate } from '@/core/fx';
import { type Asset, type BaseUnits, formatUnits } from '@/core/money';

export function FundingPanel({
  payableId,
  outstandingBase,
  holderCount,
  balances,
  xsgdPerXusdE6,
}: {
  payableId: string;
  outstandingBase: string;
  holderCount: number;
  balances: Record<string, string>;
  xsgdPerXusdE6: string;
}) {
  const [asset, setAsset] = useState<Asset>('XUSD');

  const outstanding = BigInt(outstandingBase) as BaseUnits;
  const rate = BigInt(xsgdPerXusdE6);
  const debit = convert(outstanding, asset, rate).sourceDebit;
  const available = BigInt(balances[asset] ?? '0') as BaseUnits;
  const short = available < debit;
  const decimals = asset === 'XSGD' ? 4 : 2;
  const holders = holderCount === 1 ? 'the holder' : `all ${holderCount} holders`;

  return (
    <>
      <div className="py-1.5">
        <AssetPicker value={asset} onChange={setAsset} />
      </div>
      {asset === 'XSGD' ? <Field label="Conversion">{formatRate(rate)}</Field> : null}
      <Field label="Source debit">
        <strong>{formatUnits(debit, decimals)}</strong> {asset}
      </Field>
      <Field label={`ADATA ${asset} balance`}>
        <span className={short ? 'text-critical' : ''}>
          {formatUnits(available, 2)} {asset}
        </span>
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
              Debits ADATA {formatUnits(debit, decimals)} {asset} and credits {holders}{' '}
              {formatUnits(outstanding, 2)} XUSD in one operation. The payable is then settled
              and cannot move again.
            </>
          }
          disabled={short}
          disabledReason={`ADATA does not hold enough ${asset}. Use Simulate top-up.`}
          action={settleMaturity}
          args={[payableId, asset]}
        />
      </div>
    </>
  );
}
