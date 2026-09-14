import Link from 'next/link';

import { AddUser } from './AddUser';
import { ActionButton } from '@/components/ActionButton';
import { Address, EmptyState, LedgerScroll, Notice, Panel } from '@/components/primitives';
import { removeUser } from '@/app/actions';
import { currentPersona } from '@/app/session';
import { readEntities, readUsers } from '@/db/read';

/**
 * PRD §5. Accounts.
 *
 * "There should be a feature to create new account for new users, and assign
 * them a persona... StraitsX admin account is the only one where there's 1
 * single account managed by 1 single user. The admin account can delete all
 * other users from the platform."
 *
 * So this is the StraitsX admin's screen and nobody else's. Removal is
 * deactivation, not deletion: every journal entry names the user who made it,
 * and the audit trail has to keep working after an account is gone. The row
 * says how many entries that is, so an admin removing someone can see what
 * history they are leaving behind.
 */
const ROLE_LABEL: Record<string, string> = {
  adata_preparer: 'ADATA preparer',
  adata_checker: 'ADATA checker',
  supplier: 'Supplier',
  lender: 'Lender',
  straitsx_admin: 'StraitsX admin',
};

export default async function AccountsPage() {
  const persona = await currentPersona();

  if (persona.role !== 'straitsx_admin') {
    return (
      <div className="mx-auto max-w-xl space-y-3 pt-4">
        <div>
          <h1 className="text-[15px] font-semibold">Accounts</h1>
        </div>
        <Panel title="Not available to you">
          <div className="space-y-3">
            <Notice tone="caution">
              Only the StraitsX administrator manages accounts. You are acting as {persona.name},{' '}
              {persona.entityName}.
            </Notice>
            <p className="text-[12.5px] text-ink-muted">
              Anyone can create their own account and be assigned a persona from{' '}
              <Link href="/onboarding" className="text-accent hover:underline">
                onboarding
              </Link>
              .
            </p>
          </div>
        </Panel>
      </div>
    );
  }

  const [users, organisations] = await Promise.all([readUsers(), readEntities()]);

  return (
    <div className="space-y-3">
      <div>
        <h1 className="text-[15px] font-semibold">Accounts</h1>
        <p className="text-[11.5px] text-ink-muted">
          Every account on the platform. Creating one assigns a persona and puts it in the demo
          switcher immediately.
        </p>
      </div>

      <Panel title="Create a user" dense>
        <AddUser
          organisations={organisations.map((o) => ({
            id: o.id,
            name: o.name,
            entityType: o.entityType,
          }))}
        />
      </Panel>

      <Panel title={`Accounts (${users.length})`} dense>
        {users.length === 0 ? (
          <EmptyState title="No accounts." />
        ) : (
          <LedgerScroll label="Accounts">
            <table className="ledger">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Persona</th>
                  <th>Organisation</th>
                  <th>Wallet</th>
                  <th>KYC</th>
                  <th className="num">Audit entries</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {users.map((u) => {
                  const isSelf = u.userId === persona.userId;
                  const isAdmin = u.role === 'straitsx_admin';
                  const blocked = isAdmin
                    ? 'The platform has exactly one administrator, and it cannot be removed.'
                    : u.isOnlyUserOfEntity
                      ? `${u.entityName} has no other account. Removing this one would strand the wallet it holds.`
                      : null;
                  return (
                    <tr key={u.userId}>
                      <td className="font-medium">
                        {u.name}
                        {isSelf ? (
                          <span className="ml-1.5 text-[10px] text-ink-faint">you</span>
                        ) : null}
                      </td>
                      <td>{ROLE_LABEL[u.role] ?? u.role}</td>
                      <td className="text-ink-muted">{u.entityName}</td>
                      <td>{u.wallet ? <Address value={u.wallet} /> : '—'}</td>
                      <td>
                        <span
                          className={`inline-flex items-center rounded-[3px] border px-1.5 py-0.5 text-[11px] font-medium ${
                            u.kycVerified
                              ? 'border-positive/30 bg-positive-soft text-positive'
                              : 'border-rule-strong bg-surface-raised text-ink-muted'
                          }`}
                        >
                          {u.kycVerified ? 'Verified' : 'Pending'}
                        </span>
                      </td>
                      <td className="num text-ink-muted">{u.actions || '—'}</td>
                      <td className="text-right">
                        {blocked ? (
                          <span className="text-[11px] text-ink-faint" title={blocked}>
                            cannot remove
                          </span>
                        ) : (
                          <ActionButton
                            label="Remove"
                            variant="danger"
                            confirm={
                              <>
                                Removes {u.name} from {u.entityName}. The organisation, its wallet
                                and its holdings are untouched, and the{' '}
                                {u.actions === 1 ? 'one entry' : `${u.actions} entries`} they
                                authored stay in the audit trail under their name.
                              </>
                            }
                            action={removeUser}
                            args={[u.userId]}
                          />
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </LedgerScroll>
        )}
      </Panel>

      <p className="text-[11px] text-ink-faint">
        Removing an account deactivates it rather than deleting the row, because every journal
        entry names the person who made it. A removed account leaves the persona switcher and
        cannot act again; its history stays readable in the explorer.
      </p>
    </div>
  );
}
