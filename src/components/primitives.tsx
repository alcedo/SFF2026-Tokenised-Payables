/**
 * Display primitives shared by every screen.
 *
 * These exist because the PRD pins specific presentation rules that must not
 * drift between screens: two decimals in summary views and four in detail
 * (section 6), "Due" or "Overdue" in place of a forward yield at maturity
 * (section 6), and every mock chain reference clearly labelled as simulated
 * (section 10). Each rule is implemented once here rather than restated per
 * screen.
 */

import type { ReactNode } from 'react';

import { type Asset, type BaseUnits, formatUnits } from '@/core/money';
import { formatDaysRemaining } from '@/core/clock';
import { type LifecycleStatus, STATUS_LABELS } from '@/core/lifecycle';
import { formatPercent } from '@/core/pricing';

/** An XUSD or funding-asset figure, right-aligned with tabular numerals. */
export function Amount({
  value,
  asset,
  decimals = 2,
  showAsset = false,
  className = '',
}: {
  value: BaseUnits;
  asset?: Asset;
  decimals?: number;
  showAsset?: boolean;
  className?: string;
}) {
  return (
    <span className={`num ${className}`}>
      {formatUnits(value, decimals)}
      {showAsset && asset ? <span className="ml-1 text-ink-faint">{asset}</span> : null}
    </span>
  );
}

/**
 * A derived percentage. A null value renders as an em dash, which is how the
 * PRD wants a yield shown at or after maturity.
 */
export function Percent({ value, decimals = 2 }: { value: number | null; decimals?: number }) {
  return <span className="num">{formatPercent(value, decimals)}</span>;
}

export function DaysRemaining({ days }: { days: number }) {
  const tone = days > 0 ? '' : days === 0 ? 'text-caution' : 'text-critical';
  return <span className={`num ${tone}`}>{formatDaysRemaining(days)}</span>;
}

const STATUS_TONE: Record<LifecycleStatus, string> = {
  draft: 'bg-surface-raised text-ink-muted border-rule-strong',
  pending_approval: 'bg-caution-soft text-caution border-caution/30',
  approved: 'bg-accent-soft text-accent border-accent/25',
  certified: 'bg-accent-soft text-accent border-accent/25',
  issued: 'bg-positive-soft text-positive border-positive/25',
  matured: 'bg-caution-soft text-caution border-caution/30',
  settled: 'bg-surface-raised text-ink-muted border-rule-strong',
  overdue: 'bg-critical-soft text-critical border-critical/30',
};

export function StatusChip({ status }: { status: LifecycleStatus }) {
  return (
    <span
      className={`inline-flex items-center rounded-[3px] border px-1.5 py-0.5 text-[11px] font-medium whitespace-nowrap ${STATUS_TONE[status]}`}
    >
      {STATUS_LABELS[status]}
    </span>
  );
}

/**
 * Market status is separate from obligation status (PRD section 7), so it gets
 * its own chip rather than being folded into the lifecycle one.
 */
export function MarketChip({ listed }: { listed: boolean }) {
  if (!listed) return null;
  return (
    <span className="inline-flex items-center rounded-[3px] border border-accent/25 bg-accent-soft px-1.5 py-0.5 text-[11px] font-medium text-accent">
      Listed
    </span>
  );
}

/**
 * PRD section 15 warns against presenting a grade as an external rating or
 * guarantee, so the badge always carries the "Sample" qualifier.
 */
export function GradeBadge({ grade }: { grade: string }) {
  return (
    <span className="inline-flex items-center gap-1 whitespace-nowrap">
      <span className="rounded-[3px] border border-rule-strong bg-surface-raised px-1.5 py-0.5 font-mono text-[11px] font-semibold text-ink">
        {grade}
      </span>
      <span className="text-[10px] tracking-wide text-ink-faint uppercase">Sample</span>
    </span>
  );
}

/** A simulated wallet address, truncated the way the PRD writes it. */
export function Address({ value, full = false }: { value: string; full?: boolean }) {
  const shown = full || value.length <= 13 ? value : `${value.slice(0, 6)}…${value.slice(-4)}`;
  return (
    <span className="addr" title={value}>
      {shown}
    </span>
  );
}

/**
 * PRD section 10: "Label every hash, block number, and receipt as simulated."
 * The label is part of the component so a screen cannot render a hash without it.
 */
export function MockTxRef({ hash, block }: { hash: string; block?: number }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className="addr">{hash.length > 13 ? `${hash.slice(0, 10)}…${hash.slice(-6)}` : hash}</span>
      {block !== undefined ? <span className="text-[10px] text-ink-faint">block {block}</span> : null}
      <span className="rounded-[3px] border border-caution/30 bg-caution-soft px-1 py-px text-[10px] font-medium text-caution">
        Simulated
      </span>
    </span>
  );
}

export function Panel({
  title,
  action,
  children,
  dense = false,
}: {
  title?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
  dense?: boolean;
}) {
  return (
    <section className="min-w-0 rounded-[4px] border border-rule bg-surface">
      {title ? (
        <header className="panel-head border-b border-rule px-3 py-2">
          <h2 className="min-w-0 text-[12px] font-semibold tracking-wide text-ink uppercase">{title}</h2>
          {action}
        </header>
      ) : null}
      <div className={dense ? 'panel-body' : 'panel-body p-3'}>{children}</div>
    </section>
  );
}

/** Local clip for `table.ledger`. Wide columns scroll here, not the document. */
export function LedgerScroll({
  children,
  label,
}: {
  children: ReactNode;
  label?: string;
}) {
  return (
    <div className="ledger-clip" role="region" aria-label={label} tabIndex={0}>
      {children}
    </div>
  );
}

/** A labelled figure for a dashboard strip. */
export function Stat({
  label,
  value,
  hint,
  tone = 'default',
}: {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  tone?: 'default' | 'positive' | 'caution' | 'critical';
}) {
  const toneClass = {
    default: 'text-ink',
    positive: 'text-positive',
    caution: 'text-caution',
    critical: 'text-critical',
  }[tone];
  return (
    <div className="rounded-[4px] border border-rule bg-surface px-3 py-2.5">
      <div className="text-[10.5px] font-medium tracking-wide text-ink-muted uppercase">{label}</div>
      <div className={`mt-1 text-[19px] leading-tight font-semibold ${toneClass}`} style={{ fontVariantNumeric: 'tabular-nums' }}>
        {value}
      </div>
      {hint ? <div className="mt-0.5 text-[11px] text-ink-faint">{hint}</div> : null}
    </div>
  );
}

/** A field in a detail panel. */
export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-b border-rule py-1.5 last:border-b-0">
      <dt className="shrink-0 text-[11.5px] text-ink-muted">{label}</dt>
      <dd className="min-w-0 text-right text-[12.5px] text-ink">{children}</dd>
    </div>
  );
}

export function Button({
  children,
  variant = 'primary',
  ...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'secondary' | 'quiet' | 'danger' }) {
  const base =
    'inline-flex items-center justify-center gap-1.5 rounded-[3px] px-2.5 py-1.5 text-[12px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-45';
  const styles = {
    primary: 'bg-accent text-white hover:bg-accent-hover',
    secondary: 'border border-rule-strong bg-surface text-ink hover:bg-surface-sunken',
    quiet: 'text-accent hover:bg-accent-soft',
    danger: 'border border-critical/30 bg-critical-soft text-critical hover:bg-critical/10',
  }[variant];
  return (
    <button className={`${base} ${styles}`} {...rest}>
      {children}
    </button>
  );
}

/** Inline validation feedback. PRD section 14 requires it on every refusal. */
export function Notice({
  tone = 'critical',
  children,
}: {
  tone?: 'critical' | 'caution' | 'positive' | 'info';
  children: ReactNode;
}) {
  const styles = {
    critical: 'border-critical/30 bg-critical-soft text-critical',
    caution: 'border-caution/30 bg-caution-soft text-caution',
    positive: 'border-positive/30 bg-positive-soft text-positive',
    info: 'border-rule-strong bg-surface-raised text-ink-muted',
  }[tone];
  return <div className={`rounded-[3px] border px-2.5 py-2 text-[12px] ${styles}`}>{children}</div>;
}

export function EmptyState({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="px-3 py-10 text-center">
      <p className="text-[13px] font-medium text-ink-muted">{title}</p>
      {hint ? <p className="mx-auto mt-1 max-w-md text-[12px] text-ink-faint">{hint}</p> : null}
    </div>
  );
}
