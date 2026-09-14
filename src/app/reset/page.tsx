import Link from 'next/link';

import { Button, Notice, Panel } from '@/components/primitives';
import { resetWorld } from './action';

/**
 * PRD §11: "Because the world is shared, show that reset and time changes
 * affect all connected demo sessions." That warning is the whole reason this is
 * a page with a confirm rather than a button on the bar.
 */
export default function ResetPage() {
  return (
    <div className="mx-auto max-w-xl space-y-3 pt-6">
      <Panel title="Reset world">
        <div className="space-y-3">
          <Notice tone="caution">
            This restores the complete seed state, including the demo clock and the mocked FX rate.
            The world is shared, so it affects every connected session, not just this tab.
          </Notice>
          <p className="text-[12.5px] text-ink-muted">
            Everything issued, listed, traded, transferred or settled since the last reset is
            discarded. The seeded listings, balances and histories come back exactly as they were at
            T0.
          </p>
          <form action={resetWorld} className="flex items-center gap-2">
            <Button type="submit" variant="danger">
              Reset the world
            </Button>
            <Link href="/" className="text-[12px] text-accent hover:underline">
              Cancel
            </Link>
          </form>
        </div>
      </Panel>
    </div>
  );
}
