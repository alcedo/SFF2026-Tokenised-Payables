import Link from 'next/link';

import type { NextAction } from '@/core/next-action';

export function NextActionStrip({ action }: { action: NextAction }) {
  if (action.kind === 'yours') {
    return (
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-[4px] border border-accent/25 bg-accent-soft px-3 py-2.5">
        <div className="min-w-0">
          <div className="text-[10.5px] font-semibold tracking-wide text-accent uppercase">
            Your next step
          </div>
          <p className="mt-0.5 text-[12.5px] text-ink">{action.detail}</p>
        </div>
        <Link
          href={action.href}
          className="inline-flex shrink-0 items-center rounded-[3px] bg-accent px-3 py-1.5 text-[12px] font-medium text-white hover:bg-accent-hover"
        >
          {action.verb}
        </Link>
      </div>
    );
  }

  if (action.kind === 'waiting') {
    return (
      <div className="rounded-[4px] border border-caution/30 bg-caution-soft px-3 py-2.5">
        <div className="text-[10.5px] font-semibold tracking-wide text-caution uppercase">
          {action.heading}
        </div>
        <p className="mt-0.5 text-[12.5px] text-ink">{action.detail}</p>
      </div>
    );
  }

  return (
    <div className="rounded-[4px] border border-rule bg-surface px-3 py-2.5">
      <div className="text-[10.5px] font-semibold tracking-wide text-ink-muted uppercase">
        {action.heading}
      </div>
      {action.detail ? <p className="mt-0.5 text-[12.5px] text-ink-muted">{action.detail}</p> : null}
    </div>
  );
}
