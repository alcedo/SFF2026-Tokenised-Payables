'use client';

import { useState } from 'react';

import { ActionButton } from '@/components/ActionButton';
import { Notice } from '@/components/primitives';
import { createPayableManually } from '@/app/actions';
import { addDays, parseIsoDate } from '@/core/clock';
import { parseAmount, parseTermsDays } from '@/core/input';
import { formatUnits, type BaseUnits } from '@/core/money';

export interface SupplierOption {
  id: string;
  name: string;
  certification: string;
}

export function ManualEntry({
  suppliers,
  worldDate,
  payableRef,
  suggestedInvoiceRef,
}: {
  suppliers: SupplierOption[];
  worldDate: string;
  payableRef: string;
  suggestedInvoiceRef: string;
}) {
  const [supplierId, setSupplierId] = useState(suppliers[0]?.id ?? '');
  const [override, setOverride] = useState<string | null>(null);
  const invoiceRef = override ?? suggestedInvoiceRef;
  const [amount, setAmount] = useState('');
  const [terms, setTerms] = useState('90');

  const supplier = suppliers.find((s) => s.id === supplierId) ?? null;

  const parsedFace = parseAmount(amount);
  const faceBase = parsedFace.ok ? parsedFace.value : null;
  const parsedTerms = parseTermsDays(terms);
  const termsOk = parsedTerms.ok;
  const termsDays = parsedTerms.ok ? parsedTerms.value : 0;
  const maturity = termsOk ? addDays(parseIsoDate(worldDate), termsDays) : null;

  const ready = supplier !== null && invoiceRef.trim() !== '' && faceBase !== null && termsOk;

  return (
    <div className="p-3">
      <div className="grid gap-3 md:grid-cols-2">
        <label className="block">
          <span className="mb-0.5 block text-[10.5px] tracking-wide text-ink-muted uppercase">
            Supplier
          </span>
          <select
            aria-label="Supplier"
            className="w-full rounded-[3px] border border-rule-strong bg-surface px-2 py-1.5 text-[13px]"
            value={supplierId}
            onChange={(e) => setSupplierId(e.target.value)}
          >
            {suppliers.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
                {s.certification === 'certified' ? '' : ` (${s.certification})`}
              </option>
            ))}
          </select>
        </label>

        <label className="block">
          <span className="mb-0.5 block text-[10.5px] tracking-wide text-ink-muted uppercase">
            Invoice reference
          </span>
          <input
            aria-label="Invoice reference"
            placeholder="INV-TW-00000"
            autoComplete="off"
            className="w-full rounded-[3px] border border-rule-strong bg-surface px-2 py-1.5 text-[13px]"
            value={invoiceRef}
            onChange={(e) => setOverride(e.target.value)}
          />
          <span className="mt-0.5 block text-[10.5px] text-ink-faint">
            {override === null
              ? `Suggested: the next free number after the ones already on the books. Type over it with the supplier's own reference.`
              : 'Must not already be financed for this supplier.'}
          </span>
        </label>

        <label className="block">
          <span className="mb-0.5 block text-[10.5px] tracking-wide text-ink-muted uppercase">
            Invoice face, XUSD
          </span>
          <input
            aria-label="Invoice face"
            inputMode="decimal"
            placeholder="250000"
            autoComplete="off"
            className="num w-full rounded-[3px] border border-rule-strong bg-surface px-2 py-1.5 text-[13px]"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
          />
        </label>

        <label className="block">
          <span className="mb-0.5 block text-[10.5px] tracking-wide text-ink-muted uppercase">
            Payment terms, days
          </span>
          <input
            aria-label="Payment terms"
            inputMode="numeric"
            className="num w-full rounded-[3px] border border-rule-strong bg-surface px-2 py-1.5 text-[13px]"
            value={terms}
            onChange={(e) => setTerms(e.target.value)}
          />
        </label>
      </div>

      <dl className="mt-3 grid gap-x-6 gap-y-1 rounded-[4px] border border-rule bg-surface-sunken p-2.5 text-[12.5px] md:grid-cols-2">
        <Row label="New reference">{payableRef}</Row>
        <Row label="Anchor obligor">ADATA Technology Co., Ltd.</Row>
        <Row label="Face value">
          {faceBase === null ? (
            <span className="text-ink-faint">enter an amount</span>
          ) : (
            `${formatUnits(faceBase as BaseUnits, 4)} XUSD`
          )}
        </Row>
        <Row label="Issue date">{worldDate}</Row>
        <Row label="Maturity date">
          {maturity ?? <span className="text-ink-faint">enter 1 to 365 days</span>}
        </Row>
        <Row label="Denomination">XUSD, fixed</Row>
      </dl>

      <div className="mt-3">
        {ready ? (
          <ActionButton
            label="Create payable"
            confirm={
              <>
                Creates {payableRef} as a draft against {supplier.name}&apos;s invoice{' '}
                {invoiceRef.trim()} for {formatUnits(faceBase as BaseUnits, 2)} XUSD, maturing{' '}
                {maturity}. It then needs a checker&apos;s approval and StraitsX certification
                before it can be issued.
              </>
            }
            action={createPayableManually}
            args={[payableRef, supplierId, invoiceRef.trim(), String(faceBase), String(termsDays)]}
          />
        ) : (
          <Notice tone="info">
            Enter a supplier, an invoice reference, a face value above zero, and payment terms
            between 1 and 365 days.
          </Notice>
        )}
      </div>
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
