/**
 * Which navigation tab is current for a given pathname.
 *
 * Tabs are prefixes of the pages under them: `/supplier` is current on
 * `/supplier/finance/42`, and `/lender` on `/lender/7`. When several tabs
 * match, the longest wins, so `/adata/create` lights "Create payable" and
 * not "Dashboard". A match has to end on a segment boundary: `/admin` must
 * not light for a hypothetical `/administration`. Pages outside every tab
 * (onboarding, the explorer, the overdue list) light nothing.
 */
export function activeNavHref(hrefs: readonly string[], pathname: string): string | null {
  let best: string | null = null;
  for (const href of hrefs) {
    if (!matchesSegment(href, pathname)) continue;
    if (best === null || href.length > best.length) best = href;
  }
  return best;
}

function matchesSegment(href: string, pathname: string): boolean {
  if (pathname === href) return true;
  return pathname.startsWith(href) && pathname.charAt(href.length) === '/';
}
