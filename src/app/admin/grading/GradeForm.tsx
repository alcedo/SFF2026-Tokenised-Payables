'use client';

import { useState } from 'react';

import { ActionButton } from '@/components/ActionButton';
import { gradePayable } from '@/app/actions';

const GRADES = ['AAA', 'AA', 'A'] as const;

/** PRD §15 requires a rationale alongside every grade, so the form demands one. */
export function GradeForm({ payableId, payableRef }: { payableId: string; payableRef: string }) {
  const [grade, setGrade] = useState<(typeof GRADES)[number]>('AA');
  const [rationale, setRationale] = useState(
    'Anchor obligor investment grade. Sample value assigned by StraitsX, not an external rating.',
  );

  return (
    <div className="flex flex-wrap items-end gap-2">
      <label className="flex flex-col gap-0.5">
        <span className="text-[10.5px] tracking-wide text-ink-muted uppercase">Grade</span>
        <div className="flex gap-1">
          {GRADES.map((g) => (
            <button
              key={g}
              type="button"
              onClick={() => setGrade(g)}
              className={`rounded-[3px] border px-2 py-1 font-mono text-[12px] ${
                g === grade
                  ? 'border-accent bg-accent-soft font-semibold text-accent'
                  : 'border-rule-strong bg-surface text-ink-muted hover:bg-surface-sunken'
              }`}
            >
              {g}
            </button>
          ))}
        </div>
      </label>
      <label className="flex min-w-[320px] flex-1 flex-col gap-0.5">
        <span className="text-[10.5px] tracking-wide text-ink-muted uppercase">Rationale</span>
        <input
          className="w-full rounded-[3px] border border-rule-strong bg-surface px-2 py-1.5 text-[12px]"
          value={rationale}
          aria-label={`Grade rationale for ${payableRef}`}
          onChange={(e) => setRationale(e.target.value)}
        />
      </label>
      <ActionButton
        label="Assign grade"
        disabled={rationale.trim().length < 10}
        disabledReason="A grade needs a rationale."
        action={gradePayable}
        args={[payableId, grade, rationale.trim()]}
      />
    </div>
  );
}
