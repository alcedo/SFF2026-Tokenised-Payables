import Link from 'next/link';

import { Button, Notice, Panel } from '@/components/primitives';
import { currentPersona } from '@/app/session';
import { WORLD_TARGETS, type WorldTarget } from '@/db/reset';
import { resetWorld } from './action';

/**
 * What each world is called in front of a room. "Fixtures" is a file name, so
 * the copy says what the world holds instead.
 */
const WORLDS: Record<WorldTarget, { label: string; holds: string }> = {
  seed: {
    label: 'Demo catalogue',
    holds:
      'Five lots on the market with bids against them, one position already settled and one overdue. The world the runbook is written for.',
  },
  fixtures: {
    label: 'Minimal world',
    holds:
      'ADATA, StraitsX, two suppliers, two funded lenders and the 24-invoice ERP register. Nothing issued, listed or traded yet, which is how a new deployment starts.',
  },
};

/**
 * PRD §11: "Because the world is shared, show that reset and time changes
 * affect all connected demo sessions." That warning is the whole reason this is
 * a page with a typed confirmation rather than a button on the bar.
 *
 * The demo runs on a public URL, so this screen is also the one place where a
 * stranger can destroy everyone else's session. It is restricted to the
 * StraitsX admin persona, asks for a typed phrase, and honours an optional PIN.
 * See src/app/reset/action.ts for what each gate is actually worth.
 */
export default async function ResetPage({
  searchParams,
}: {
  searchParams: Promise<{ e?: string }>;
}) {
  const [persona, { e }] = await Promise.all([currentPersona(), searchParams]);
  const isAdmin = persona.role === 'straitsx_admin';
  const pinRequired = Boolean(process.env.ADATA_RESET_PIN);

  if (!isAdmin) {
    return (
      <div className="mx-auto max-w-xl space-y-3 pt-6">
        <div>
          <h1 className="text-[15px] font-semibold">Reset world</h1>
          <p className="text-[11.5px] text-ink-muted">
            Rebuilds the world for every connected session.
          </p>
        </div>
        <Panel title="Not available to you">
          <div className="space-y-3">
            <Notice tone="caution">
              Only the StraitsX administrator can reset the world. You are acting as {persona.name},{' '}
              {persona.entityName}.
            </Notice>
            <p className="text-[12.5px] text-ink-muted">
              The world is shared with everyone else using this demo right now, so a reset is not
              something a participant can do to the room. Switch to the StraitsX admin persona in
              the demo controls if you are the one running it.
            </p>
            <Link href="/" className="text-[12px] text-accent hover:underline">
              ← Back
            </Link>
          </div>
        </Panel>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-xl space-y-3 pt-6">
      <div>
        <h1 className="text-[15px] font-semibold">Reset world</h1>
        <p className="text-[11.5px] text-ink-muted">
          Rebuilds the world for every connected session.
        </p>
      </div>
      <Panel title="Confirm">
        <div className="space-y-3">
          {e === 'phrase' ? (
            <Notice tone="critical">
              Type RESET exactly, in capitals, to confirm. Nothing was changed.
            </Notice>
          ) : null}
          {e === 'pin' ? (
            <Notice tone="critical">That PIN is wrong. Nothing was changed.</Notice>
          ) : null}
          {e === 'role' ? (
            <Notice tone="critical">
              That persona cannot reset the world. Nothing was changed.
            </Notice>
          ) : null}
          {e === 'target' ? (
            <Notice tone="critical">
              Choose which world to restore. Nothing was changed.
            </Notice>
          ) : null}

          <Notice tone="caution">
            This rebuilds the world from the schema up, including the demo clock and the mocked FX
            rate. The world is shared, so it affects every connected session, not just this tab.
          </Notice>
          <p className="text-[12.5px] text-ink-muted">
            Everything issued, listed, traded, transferred or settled since the last reset is
            discarded, whichever world you choose below. That world comes back exactly as it starts,
            the clock returns to T0, and T0 becomes today.
          </p>

          <form action={resetWorld} className="space-y-3">
            <fieldset className="space-y-1.5">
              <legend className="mb-1 text-[10.5px] tracking-wide text-ink-muted uppercase">
                World to restore
              </legend>
              {WORLD_TARGETS.map((target) => (
                <label key={target} className="flex items-start gap-2">
                  <input
                    type="radio"
                    name="target"
                    value={target}
                    defaultChecked={target === 'seed'}
                    aria-label={WORLDS[target].label}
                    className="mt-[3px]"
                  />
                  <span>
                    <span className="block text-[12.5px]">{WORLDS[target].label}</span>
                    <span className="block text-[11.5px] text-ink-muted">
                      {WORLDS[target].holds}
                    </span>
                  </span>
                </label>
              ))}
            </fieldset>

            <label className="block">
              <span className="mb-0.5 block text-[10.5px] tracking-wide text-ink-muted uppercase">
                Type RESET to confirm
              </span>
              <input
                name="phrase"
                required
                autoComplete="off"
                aria-label="Type RESET to confirm"
                className="w-40 rounded-[3px] border border-rule-strong bg-surface px-2 py-1.5 text-[13px] tracking-[0.1em]"
              />
            </label>

            {pinRequired ? (
              <label className="block">
                <span className="mb-0.5 block text-[10.5px] tracking-wide text-ink-muted uppercase">
                  Reset PIN
                </span>
                <input
                  name="pin"
                  type="password"
                  required
                  autoComplete="off"
                  aria-label="Reset PIN"
                  className="w-40 rounded-[3px] border border-rule-strong bg-surface px-2 py-1.5 text-[13px]"
                />
              </label>
            ) : null}

            <div className="flex items-center gap-2">
              <Button type="submit" variant="danger">
                Reset the world
              </Button>
              <Link href="/" className="text-[12px] text-accent hover:underline">
                Cancel
              </Link>
            </div>
          </form>

          {pinRequired ? null : (
            <p className="text-[10.5px] text-ink-faint">
              No reset PIN is configured. Anyone who switches to the admin persona can reset this
              world. Set ADATA_RESET_PIN in the deployment environment to require one.
            </p>
          )}
        </div>
      </Panel>
    </div>
  );
}
