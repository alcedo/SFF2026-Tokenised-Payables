'use client';

/**
 * PRD §5: "Create a user -> assign it a persona -> fill up necessary
 * information -> user with its relevant persona account created."
 *
 * The persona is not a free choice: a supplier company gets supplier accounts,
 * a lender company lender ones, ADATA a preparer or a checker. The form offers
 * only the roles that organisation can hold, so the refusal the database would
 * give never has to happen.
 */

import { useState } from 'react';

import { ActionButton } from '@/components/ActionButton';
import { Notice } from '@/components/primitives';
import { createUser } from '@/app/actions';

export interface OrgOption {
  id: string;
  name: string;
  entityType: 'anchor' | 'supplier' | 'lender' | 'platform';
}

const ROLES_FOR: Record<OrgOption['entityType'], { value: string; label: string }[]> = {
  anchor: [
    { value: 'adata_preparer', label: 'ADATA preparer' },
    { value: 'adata_checker', label: 'ADATA checker' },
  ],
  supplier: [{ value: 'supplier', label: 'Supplier' }],
  lender: [{ value: 'lender', label: 'Lender' }],
  // PRD §5: one StraitsX admin account, managed by one user. The database
  // enforces it; offering the role here would only invite the refusal.
  platform: [],
};

export function AddUser({ organisations }: { organisations: OrgOption[] }) {
  const eligible = organisations.filter((o) => ROLES_FOR[o.entityType].length > 0);
  const [entityId, setEntityId] = useState(eligible[0]?.id ?? '');
  const [name, setName] = useState('');

  const org = eligible.find((o) => o.id === entityId) ?? null;
  const roles = org ? ROLES_FOR[org.entityType] : [];
  const [role, setRole] = useState(roles[0]?.value ?? '');

  // The role list changes with the organisation, so a stale choice would post
  // a pairing the database refuses. Fall back to the first legal one.
  const effectiveRole = roles.some((r) => r.value === role) ? role : (roles[0]?.value ?? '');
  const ready = org !== null && name.trim() !== '' && effectiveRole !== '';

  return (
    <div className="space-y-3 p-3">
      <div className="grid gap-3 md:grid-cols-3">
        <label className="block">
          <span className="mb-0.5 block text-[10.5px] tracking-wide text-ink-muted uppercase">
            Organisation
          </span>
          <select
            aria-label="Organisation"
            className="w-full rounded-[3px] border border-rule-strong bg-surface px-2 py-1.5 text-[13px]"
            value={entityId}
            onChange={(e) => setEntityId(e.target.value)}
          >
            {eligible.map((o) => (
              <option key={o.id} value={o.id}>
                {o.name}
              </option>
            ))}
          </select>
        </label>

        <label className="block">
          <span className="mb-0.5 block text-[10.5px] tracking-wide text-ink-muted uppercase">
            Persona
          </span>
          <select
            aria-label="Persona"
            className="w-full rounded-[3px] border border-rule-strong bg-surface px-2 py-1.5 text-[13px]"
            value={effectiveRole}
            onChange={(e) => setRole(e.target.value)}
          >
            {roles.map((r) => (
              <option key={r.value} value={r.value}>
                {r.label}
              </option>
            ))}
          </select>
        </label>

        <label className="block">
          <span className="mb-0.5 block text-[10.5px] tracking-wide text-ink-muted uppercase">
            Name
          </span>
          <input
            aria-label="Name"
            autoComplete="off"
            placeholder="Chou Yi-Hsuan"
            className="w-full rounded-[3px] border border-rule-strong bg-surface px-2 py-1.5 text-[13px]"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </label>
      </div>

      {ready ? (
        <ActionButton
          label="Create user"
          confirm={
            <>
              Adds {name.trim()} to {org.name} as{' '}
              {roles.find((r) => r.value === effectiveRole)?.label}, marked KYC verified. They
              share that organisation&apos;s wallet and appear in the persona switcher at once.
            </>
          }
          action={createUser}
          args={[entityId, name.trim(), effectiveRole]}
        />
      ) : (
        <Notice tone="info">Choose an organisation and a persona, then enter a name.</Notice>
      )}

      <p className="text-[10.5px] text-ink-faint">
        A wallet belongs to the organisation, not the person, so a second user sees the same
        holdings. To create a new wallet, onboard a new organisation instead.
      </p>
    </div>
  );
}
