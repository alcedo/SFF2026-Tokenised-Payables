'use client';

/**
 * PRD §8 screen 14's "configurable programme limits", and §5's "certify ADATA
 * / tokenised payable issuer, set programme limits".
 *
 * Both controls change what the programme can actually do next: a suspended
 * issuer cannot issue, and an issuance that would breach the limit is refused
 * at the ledger. So each one states its consequence before it is armed, rather
 * than presenting itself as a setting.
 */

import { useState } from 'react';

import { ActionButton } from '@/components/ActionButton';
import { Notice } from '@/components/primitives';
import { setCertification, setProgrammeLimit } from '@/app/actions';
import { BASE_UNITS_PER_UNIT, formatUnits, type BaseUnits } from '@/core/money';

const STATUS: { value: string; label: string; effect: string }[] = [
  { value: 'certified', label: 'Certified', effect: 'can issue under this programme' },
  { value: 'suspended', label: 'Suspended', effect: 'cannot issue; existing payables are unaffected' },
  { value: 'uncertified', label: 'Uncertified', effect: 'cannot issue; not yet admitted' },
];

export function IssuerControls({
  entityId,
  name,
  status,
  limitBase,
  outstandingBase,
}: {
  entityId: string;
  name: string;
  status: string;
  limitBase: string | null;
  outstandingBase: string;
}) {
  const outstanding = BigInt(outstandingBase);
  const current = limitBase === null ? null : BigInt(limitBase);

  const [limit, setLimit] = useState(
    current === null ? '' : formatUnits(current as BaseUnits, 0).replace(/,/g, ''),
  );
  const [nextStatus, setNextStatus] = useState(status);

  const typed = limit.trim();
  const wholeUnits = Number(typed.replace(/,/g, ''));
  const parsed =
    typed === ''
      ? null
      : Number.isFinite(wholeUnits) && wholeUnits >= 0
        ? BigInt(Math.round(wholeUnits * Number(BASE_UNITS_PER_UNIT)))
        : undefined;

  const limitValid = parsed !== undefined;
  const limitChanged = limitValid && parsed !== current;
  // Lowering below what is already outstanding is allowed and sometimes
  // intended, but it stops all issuance until the book unwinds, so say so.
  const wouldBreach = limitValid && parsed !== null && parsed < outstanding;

  const statusChanged = nextStatus !== status;
  const chosen = STATUS.find((s) => s.value === nextStatus);

  return (
    <div className="space-y-3 border-t border-rule p-3">
      <div className="grid gap-4 md:grid-cols-2">
        <div className="space-y-2">
          <label className="block">
            <span className="mb-0.5 block text-[10.5px] tracking-wide text-ink-muted uppercase">
              Programme limit, XUSD of outstanding face
            </span>
            <input
              aria-label="Programme limit"
              inputMode="decimal"
              autoComplete="off"
              placeholder="leave blank for no limit"
              className="num w-full rounded-[3px] border border-rule-strong bg-surface px-2 py-1.5 text-[13px]"
              value={limit}
              onChange={(e) => setLimit(e.target.value)}
            />
          </label>

          {!limitValid ? (
            <Notice tone="critical">Enter a whole XUSD amount, or leave it blank.</Notice>
          ) : wouldBreach ? (
            <Notice tone="caution">
              That is below the {formatUnits(outstanding as BaseUnits, 2)} XUSD already
              outstanding. Existing payables stand, but nothing new can be issued until the book
              falls under the limit.
            </Notice>
          ) : null}

          {limitChanged ? (
            <ActionButton
              label="Set limit"
              confirm={
                parsed === null ? (
                  <>
                    Removes {name}&apos;s programme limit entirely. Issuance will no longer be
                    capped.
                  </>
                ) : (
                  <>
                    Caps {name} at {formatUnits(parsed as BaseUnits, 2)} XUSD of outstanding face.
                    An issuance that would take it over is refused. Redemption frees headroom
                    again.
                  </>
                )
              }
              action={setProgrammeLimit}
              args={[entityId, parsed === null ? null : parsed.toString()]}
            />
          ) : (
            <p className="text-[10.5px] text-ink-faint">
              {current === null
                ? 'No limit is set. Issuance is uncapped.'
                : `Currently capped at ${formatUnits(current as BaseUnits, 2)} XUSD.`}
            </p>
          )}
        </div>

        <div className="space-y-2">
          <label className="block">
            <span className="mb-0.5 block text-[10.5px] tracking-wide text-ink-muted uppercase">
              Certification status
            </span>
            <select
              aria-label="Certification status"
              className="w-full rounded-[3px] border border-rule-strong bg-surface px-2 py-1.5 text-[13px]"
              value={nextStatus}
              onChange={(e) => setNextStatus(e.target.value)}
            >
              {STATUS.map((s) => (
                <option key={s.value} value={s.value}>
                  {s.label}
                </option>
              ))}
            </select>
          </label>

          <p className="text-[11px] text-ink-muted">
            {chosen ? `${chosen.label}: ${chosen.effect}.` : null}
          </p>

          {statusChanged ? (
            <ActionButton
              label="Change status"
              variant={nextStatus === 'certified' ? 'primary' : 'danger'}
              confirm={
                <>
                  Marks {name} {chosen?.label.toLowerCase()}.{' '}
                  {nextStatus === 'certified'
                    ? 'It can issue under this programme again.'
                    : 'No new payable can be issued against it. Payables already issued are untouched and still settle at maturity.'}
                </>
              }
              action={setCertification}
              args={[entityId, nextStatus]}
            />
          ) : null}
        </div>
      </div>

      <p className="text-[10.5px] text-ink-faint">
        Both are enforced when a payable is issued, not only shown here. Every change is recorded
        in the journal, so who raised a limit and when is answerable from the explorer.
      </p>
    </div>
  );
}
