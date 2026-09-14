'use client';

/**
 * The marketplace filter bar. PRD §8 screen 9.
 *
 * Every control writes to the URL rather than to component state, so a
 * filtered marketplace is a link someone can send, the back button undoes a
 * filter, and the server does the filtering with the same pricing code that
 * rendered the numbers. There is no client-side copy of the listing list.
 */

import { useRouter, useSearchParams } from 'next/navigation';
import { useTransition } from 'react';

import { GRADES, type Grade, SORTS, SORT_LABEL, type Sort } from '@/core/market';

const TENORS: { label: string; min: number | null; max: number | null }[] = [
  { label: 'Any tenor', min: null, max: null },
  { label: '30 days or less', min: null, max: 30 },
  { label: '31 to 60 days', min: 31, max: 60 },
  { label: '61 to 90 days', min: 61, max: 90 },
  { label: 'Over 90 days', min: 91, max: null },
];

const SIZES: { label: string; min: number | null; max: number | null }[] = [
  { label: 'Any size', min: null, max: null },
  { label: 'Under 100k', min: null, max: 100_000 },
  { label: '100k to 500k', min: 100_000, max: 500_000 },
  { label: '500k to 2m', min: 500_000, max: 2_000_000 },
  { label: 'Over 2m', min: 2_000_000, max: null },
];

const YIELDS = [
  { label: 'Any yield', value: null },
  { label: '6% or more', value: 6 },
  { label: '8% or more', value: 8 },
  { label: '10% or more', value: 10 },
  { label: '12% or more', value: 12 },
];

export function MarketFilters({ shown, total }: { shown: number; total: number }) {
  const router = useRouter();
  const params = useSearchParams();
  const [pending, startTransition] = useTransition();

  /** Rewrite the query and navigate. An empty value removes the key entirely. */
  function set(changes: Record<string, string | null>) {
    const next = new URLSearchParams(params.toString());
    for (const [key, value] of Object.entries(changes)) {
      if (value === null || value === '') next.delete(key);
      else next.set(key, value);
    }
    const qs = next.toString();
    startTransition(() => router.replace(qs ? `/lender?${qs}` : '/lender', { scroll: false }));
  }

  const grades = (params.get('grade') ?? '').split(',').filter(Boolean) as Grade[];
  const tenorKey = `${params.get('tmin') ?? ''}:${params.get('tmax') ?? ''}`;
  const sizeKey = `${params.get('smin') ?? ''}:${params.get('smax') ?? ''}`;
  const filtered = shown !== total;

  return (
    <div className="rounded-[4px] border border-rule bg-surface-raised px-3 py-2">
      <div className="flex flex-wrap items-end gap-x-4 gap-y-2">
        <Field label="Grade">
          <div className="flex gap-1">
            {GRADES.map((g) => {
              const on = grades.includes(g);
              return (
                <button
                  key={g}
                  type="button"
                  aria-pressed={on}
                  className={`rounded-[3px] border px-1.5 py-1 text-[11.5px] font-medium ${
                    on
                      ? 'border-accent bg-accent-soft text-accent'
                      : 'border-rule-strong bg-surface text-ink-muted hover:bg-surface-sunken'
                  }`}
                  onClick={() => {
                    const next = on ? grades.filter((x) => x !== g) : [...grades, g];
                    set({ grade: next.join(',') });
                  }}
                >
                  {g}
                </button>
              );
            })}
          </div>
        </Field>

        <Field label="Tenor">
          <Select
            value={tenorKey}
            aria-label="Tenor"
            options={TENORS.map((t) => ({
              value: `${t.min ?? ''}:${t.max ?? ''}`,
              label: t.label,
            }))}
            onChange={(v) => {
              const [min, max] = v.split(':');
              set({ tmin: min || null, tmax: max || null });
            }}
          />
        </Field>

        <Field label="Ticket size">
          <Select
            value={sizeKey}
            aria-label="Ticket size"
            options={SIZES.map((s) => ({
              value: `${s.min ?? ''}:${s.max ?? ''}`,
              label: s.label,
            }))}
            onChange={(v) => {
              const [min, max] = v.split(':');
              set({ smin: min || null, smax: max || null });
            }}
          />
        </Field>

        <Field label="Yield">
          <Select
            value={params.get('ymin') ?? ''}
            aria-label="Yield"
            options={YIELDS.map((y) => ({ value: y.value === null ? '' : String(y.value), label: y.label }))}
            onChange={(v) => set({ ymin: v || null })}
          />
        </Field>

        <Field label="Matures by">
          <input
            type="date"
            aria-label="Matures by"
            className="rounded-[3px] border border-rule-strong bg-surface px-1.5 py-1 text-[12px]"
            value={params.get('by') ?? ''}
            onChange={(e) => set({ by: e.target.value || null })}
          />
        </Field>

        <Field label="Sort">
          <Select
            value={params.get('sort') ?? 'yield'}
            aria-label="Sort"
            options={SORTS.map((s) => ({ value: s, label: SORT_LABEL[s as Sort] }))}
            onChange={(v) => set({ sort: v === 'yield' ? null : v })}
          />
        </Field>

        <div className="ml-auto flex items-center gap-2 pb-1">
          {pending ? <span className="text-[11px] text-ink-faint">filtering…</span> : null}
          <span className="text-[11.5px] text-ink-muted">
            {filtered ? `${shown} of ${total} lots` : `${total} lots`}
          </span>
          {filtered || params.toString() ? (
            <button
              type="button"
              className="text-[11.5px] text-accent hover:underline"
              onClick={() => startTransition(() => router.replace('/lender', { scroll: false }))}
            >
              Clear
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-[10px] font-medium tracking-wide text-ink-muted uppercase">{label}</span>
      {children}
    </div>
  );
}

function Select({
  value,
  options,
  onChange,
  ...rest
}: {
  value: string;
  options: { value: string; label: string }[];
  onChange: (value: string) => void;
} & Omit<React.SelectHTMLAttributes<HTMLSelectElement>, 'value' | 'onChange'>) {
  return (
    <select
      className="rounded-[3px] border border-rule-strong bg-surface px-1.5 py-1 text-[12px]"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      {...rest}
    >
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}
