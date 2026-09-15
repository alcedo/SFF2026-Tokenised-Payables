/**
 * Who is acting.
 *
 * PRD §11 asks for a persona switcher rather than a login, and §4 says the
 * demo world is shared. So "session" here is one cookie holding a user id,
 * and everything else about the persona is read from the database on each
 * request. Nothing about a persona is cached in the cookie, because a reset
 * can replace the world underneath an open tab and a stale name or wallet
 * would then be wrong in a way nobody would notice until a balance looked odd.
 */

import { cookies } from 'next/headers';

import { type Persona, readPersonas } from '@/db/read';

const COOKIE = 'adata_persona';

/**
 * The acting persona, falling back to the ADATA preparer so a first visit
 * lands somewhere sensible rather than on an error.
 */
export async function currentPersona(): Promise<Persona> {
  const personas = await readPersonas();
  if (personas.length === 0) {
    throw new Error('no personas; run scripts/db.sh reset');
  }
  const jar = await cookies();
  const chosen = jar.get(COOKIE)?.value;
  return personas.find((p) => p.userId === chosen) ?? personas[0]!;
}

export async function setPersona(userId: string): Promise<void> {
  const jar = await cookies();
  jar.set(COOKIE, userId, { httpOnly: true, sameSite: 'lax', path: '/' });
}

/** What each persona is allowed to reach. PRD §14 keeps role permissions real. */
export function homeFor(persona: Persona): string {
  switch (persona.role) {
    case 'adata_preparer':
    case 'adata_checker':
      return '/adata';
    case 'supplier':
      return '/supplier';
    case 'lender':
      return '/lender';
    case 'straitsx_admin':
      return '/admin';
  }
}

export interface NavItem {
  href: string;
  label: string;
}

export function navFor(persona: Persona): NavItem[] {
  switch (persona.role) {
    case 'adata_preparer':
    case 'adata_checker':
      return [
        { href: '/adata', label: 'Dashboard' },
        { href: '/adata/create', label: 'Create payable' },
        { href: '/adata/approvals', label: 'Approval queue' },
        { href: '/adata/settlement', label: 'Settlement' },
      ];
    case 'supplier':
      return [
        { href: '/supplier', label: 'My tokenised payables' },
        { href: '/supplier/offers', label: 'Offers received' },
        { href: '/transfer', label: 'Send payable' },
      ];
    case 'lender':
      return [
        { href: '/lender', label: 'Marketplace' },
        { href: '/lender/portfolio', label: 'Portfolio' },
        { href: '/transfer', label: 'Send payable' },
      ];
    case 'straitsx_admin':
      return [
        { href: '/admin', label: 'Programme oversight' },
        { href: '/admin/certification', label: 'Issuer certification' },
        { href: '/admin/grading', label: 'Grading' },
        { href: '/admin/accounts', label: 'Accounts' },
      ];
  }
}
