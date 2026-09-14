'use client';

/**
 * PRD §8 screen 5 and §5's "create a user, assign a persona".
 *
 * "Company details and custodial wallet creation. Mark the account KYC
 * verified on submit. No document upload and no external wallet connection
 * required."
 *
 * So the form asks for three things and says plainly what it will do with
 * them. The wallet is minted by the platform, which is why there is no address
 * field and no connect button: a visitor should not be left looking for one.
 */

import { useState } from 'react';

import { ActionButton } from '@/components/ActionButton';
import { Notice } from '@/components/primitives';
import { onboardEntity } from '@/app/actions';

type Kind = 'supplier' | 'lender';

const KIND: Record<Kind, { label: string; blurb: string; lands: string }> = {
  supplier: {
    label: 'Supplier',
    blurb:
      'You invoice ADATA and are paid on terms. Approved invoices arrive as tokenised payables you can hold to maturity, sell in whole or in part, or transfer.',
    lands: 'My tokenised payables',
  },
  lender: {
    label: 'Lender',
    blurb:
      'You buy payables at a discount and receive face value at maturity. Bank, fund, or corporate treasury. Marketplace access here is a demo permission, not real accreditation.',
    lands: 'Marketplace',
  },
};

export function OnboardingForm() {
  const [kind, setKind] = useState<Kind>('supplier');
  const [company, setCompany] = useState('');
  const [person, setPerson] = useState('');

  const ready = company.trim() !== '' && person.trim() !== '';

  return (
    <div className="space-y-3 p-3">
      <fieldset>
        <legend className="mb-1 text-[10.5px] tracking-wide text-ink-muted uppercase">
          Account type
        </legend>
        <div className="grid gap-2 md:grid-cols-2">
          {(Object.keys(KIND) as Kind[]).map((k) => (
            <button
              key={k}
              type="button"
              aria-pressed={kind === k}
              onClick={() => setKind(k)}
              className={`rounded-[4px] border p-2.5 text-left ${
                kind === k
                  ? 'border-accent bg-accent-soft'
                  : 'border-rule-strong bg-surface hover:bg-surface-sunken'
              }`}
            >
              <div
                className={`text-[12.5px] font-semibold ${kind === k ? 'text-accent' : 'text-ink'}`}
              >
                {KIND[k].label}
              </div>
              <p className="mt-0.5 text-[11px] text-ink-muted">{KIND[k].blurb}</p>
            </button>
          ))}
        </div>
      </fieldset>

      <div className="grid gap-3 md:grid-cols-2">
        <label className="block">
          <span className="mb-0.5 block text-[10.5px] tracking-wide text-ink-muted uppercase">
            Company name
          </span>
          <input
            aria-label="Company name"
            autoComplete="off"
            placeholder={kind === 'supplier' ? 'Formosa Precision Works' : 'Northwind Credit'}
            className="w-full rounded-[3px] border border-rule-strong bg-surface px-2 py-1.5 text-[13px]"
            value={company}
            onChange={(e) => setCompany(e.target.value)}
          />
        </label>
        <label className="block">
          <span className="mb-0.5 block text-[10.5px] tracking-wide text-ink-muted uppercase">
            Your name
          </span>
          <input
            aria-label="Your name"
            autoComplete="off"
            placeholder="Lin Ya-Ting"
            className="w-full rounded-[3px] border border-rule-strong bg-surface px-2 py-1.5 text-[13px]"
            value={person}
            onChange={(e) => setPerson(e.target.value)}
          />
        </label>
      </div>

      <dl className="grid gap-x-6 gap-y-1 rounded-[4px] border border-rule bg-surface-sunken p-2.5 text-[12.5px] md:grid-cols-2">
        <Row label="Persona assigned">{KIND[kind].label}</Row>
        <Row label="KYC">
          <span className="text-positive">Verified on submit</span>
        </Row>
        <Row label="Custodial wallet">Created by the platform</Row>
        <Row label="You land on">{KIND[kind].lands}</Row>
      </dl>

      {ready ? (
        <ActionButton
          label="Create account"
          confirm={
            <>
              Creates {company.trim()} as a {KIND[kind].label.toLowerCase()} with a custodial
              wallet, adds {person.trim()} as its first user, marks the account KYC verified, and
              switches this session to it. Everything here is simulated.
            </>
          }
          action={onboardEntity}
          args={[company.trim(), kind, person.trim()]}
        />
      ) : (
        <Notice tone="info">Enter a company name and your name.</Notice>
      )}

      <p className="text-[10.5px] text-ink-faint">
        No documents are uploaded and no external wallet is connected. A real launch would require
        both; this demo marks the account verified on submit so the flow can be shown end to end.
      </p>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-rule py-1">
      <dt className="text-ink-muted">{label}</dt>
      <dd className="text-right font-medium">{children}</dd>
    </div>
  );
}
