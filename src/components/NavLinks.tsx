'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

import { activeNavHref } from '@/core/nav-active';

export type NavLinkItem = {
  readonly href: string;
  readonly label: string;
  /** Items waiting behind this tab, or null when there is nothing to count. */
  readonly count: number | null;
};

const BASE =
  'inline-flex items-baseline gap-1 border-b-2 px-2.5 py-1.5 text-[12.5px] transition-colors';
const IDLE = 'border-transparent text-ink-muted hover:border-rule-strong hover:text-ink';
const CURRENT = 'border-accent font-medium text-ink';

/**
 * The tab row. Rendered on the client because the shell is a server component
 * with no view of the URL; `usePathname` is the only thing that knows where
 * the reader is. The current tab gets the accent underline (the one place the
 * accent is used outside primary actions) and `aria-current="page"` so a
 * screen reader announces it too.
 */
export function NavLinks({ items }: { items: readonly NavLinkItem[] }) {
  const pathname = usePathname();
  const current = activeNavHref(
    items.map((i) => i.href),
    pathname,
  );

  return (
    <nav className="chrome-nav gap-0.5" aria-label="Sections">
      {items.map((item) => {
        const isCurrent = item.href === current;
        return (
          <Link
            key={item.href}
            href={item.href}
            className={`${BASE} ${isCurrent ? CURRENT : IDLE}`}
            aria-current={isCurrent ? 'page' : undefined}
            aria-label={item.count != null ? `${item.label}, ${item.count} waiting` : undefined}
          >
            {item.label}
            {item.count != null ? (
              <span className="num chrome-nav-count" aria-hidden="true">
                {item.count}
              </span>
            ) : null}
          </Link>
        );
      })}
    </nav>
  );
}
