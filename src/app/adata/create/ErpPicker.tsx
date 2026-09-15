'use client';

import { useState } from 'react';

import { ActionButton } from '@/components/ActionButton';
import { LedgerScroll, Notice } from '@/components/primitives';
import { createPayableFromErp } from '@/app/actions';
import { addDays, parseIsoDate } from '@/core/clock';
import { type BaseUnits, formatUnits } from '@/core/money';

interface ErpRow {
  id: string;
  docNo: string;
  supplierName: string;
  invoiceRef: string;
  amountBase: string;
  termsDays: number;
  approvedOn: string;
  costCentre: string;
  consumed: boolean;
}

export function ErpPicker({
  invoices,
  worldDate,
  payableRef,
}: {
  invoices: ErpRow[];
  worldDate: string;
  payableRef: string;
}) {
  const [selected, setSelected] = useState<string | null>(null);
  const chosen = invoices.find((i) => i.id === selected) ?? null;

  return (
    <div>
      <div className="border-b border-rule bg-surface-raised px-3 py-1.5">
        <span className="font-mono text-[11px] tracking-wide text-ink-muted">
          SAP ECC · Approved invoice register · company code TW01
        </span>
        <span className="ml-2 rounded-[3px] border border-caution/30 bg-caution-soft px-1 py-px text-[10px] font-medium text-caution">
          Simulated
        </span>
      </div>

      <LedgerScroll label="Approved invoices">
        <table className="ledger">
          <thead>
            <tr>
              <th />
              <th>Document</th>
              <th>Supplier</th>
              <th>Invoice</th>
              <th>Cost centre</th>
              <th>Approved</th>
              <th className="num">Amount</th>
              <th className="num">Terms</th>
            </tr>
          </thead>
          <tbody>
            {invoices.map((i) => (
              <tr
                key={i.id}
                className={i.consumed ? 'opacity-45' : 'cursor-pointer'}
                onClick={() => !i.consumed && setSelected(i.id)}
              >
                <td>
                  <input
                    type="radio"
                    name="erp"
                    checked={selected === i.id}
                    disabled={i.consumed}
                    aria-label={`Select document ${i.docNo}`}
                    onChange={() => setSelected(i.id)}
                  />
                </td>
                <td className="mono">{i.docNo}</td>
                <td>{i.supplierName}</td>
                <td className="text-ink-muted">{i.invoiceRef}</td>
                <td className="text-ink-muted">{i.costCentre}</td>
                <td className="num">{i.approvedOn}</td>
                <td className="num">{formatUnits(BigInt(i.amountBase) as BaseUnits, 2)}</td>
                <td className="num">
                  {i.termsDays}d{i.consumed ? <span className="ml-1 text-[10px]">issued</span> : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </LedgerScroll>

      <div className="border-t border-rule p-3">
        {chosen ? (
          <div className="space-y-2">
            <dl className="grid gap-x-6 gap-y-1 text-[12.5px] md:grid-cols-2">
              <Row label="New reference">{payableRef}</Row>
              <Row label="Anchor obligor">ADATA Technology Co., Ltd.</Row>
              <Row label="Supplier">{chosen.supplierName}</Row>
              <Row label="Invoice reference">{chosen.invoiceRef}</Row>
              <Row label="Face value">
                {formatUnits(BigInt(chosen.amountBase) as BaseUnits, 4)} XUSD
              </Row>
              <Row label="Payment terms">{chosen.termsDays} days</Row>
              <Row label="Issue date">{worldDate}</Row>
              <Row label="Maturity date">
                {addDays(parseIsoDate(worldDate), chosen.termsDays)}
              </Row>
            </dl>
            <ActionButton
              label="Create payable"
              confirm={
                <>
                  Creates {payableRef} as a draft against {chosen.supplierName}&apos;s invoice{' '}
                  {chosen.invoiceRef}. It then needs a checker&apos;s approval and StraitsX
                  certification before it can be issued.
                </>
              }
              action={createPayableFromErp}
              args={[chosen.id, payableRef]}
            />
          </div>
        ) : (
          <Notice tone="info">
            Select an approved invoice above to create a payable from it. Denomination is fixed at
            XUSD; terms come from the invoice.
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
