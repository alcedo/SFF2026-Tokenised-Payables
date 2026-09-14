'use client';

import { ASSETS, type Asset } from '@/core/money';

/**
 * The funding-asset choice PRD §10 puts in front of every payment: one button
 * per asset a wallet can hold, with the chosen one filled in. Shared by the bid
 * panel and the settlement panel so the two payments look like one product.
 */
export function AssetPicker({ value, onChange }: { value: Asset; onChange: (asset: Asset) => void }) {
  return (
    <div>
      <span className="mb-0.5 block text-[10.5px] tracking-wide text-ink-muted uppercase">
        Funding asset
      </span>
      <div className="flex flex-wrap gap-1">
        {ASSETS.map((a) => (
          <button
            key={a}
            type="button"
            aria-pressed={a === value}
            onClick={() => onChange(a)}
            className={`rounded-[3px] border px-2 py-1 text-[12px] ${
              a === value
                ? 'border-accent bg-accent-soft font-medium text-accent'
                : 'border-rule-strong bg-surface text-ink-muted hover:bg-surface-sunken'
            }`}
          >
            {a}
          </button>
        ))}
      </div>
    </div>
  );
}
