'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';

import { currentPersona } from '@/app/session';
import { WORLD_TARGETS, resetWorld as rebuild } from '@/db/reset';

/**
 * PRD §11's "Reset world". Loads the world the form names, including the clock
 * and the mocked FX rate, for every connected session at once.
 *
 * Three gates, because the demo is a public URL and this is the one control
 * that destroys other people's work:
 *
 *  1. The acting persona must be the StraitsX admin. Checked here and not only
 *     on the page, because a form post does not have to come from the page.
 *  2. The typed phrase must match. This is what actually prevents the realistic
 *     accident: someone mid-presentation clicking the red button to see what it
 *     does. A confirm dialog would not; typing RESET requires meaning it.
 *  3. If ADATA_RESET_PIN is set in the environment, it must match too.
 *
 * Gate 1 is a speed bump rather than a lock, and deliberately so: PRD §11 asks
 * for an open persona switcher, so anyone can become the admin. Gate 3 is the
 * real lock, for whoever is hosting the shared URL.
 *
 * The world to load is then read from the same untrusted form. A value that is
 * not one of WORLD_TARGETS, absent included, is refused rather than defaulted,
 * for gate 1's reason: the post need not have come from the page, and guessing
 * which world a stranger meant is not a guess worth making.
 */
export async function resetWorld(formData: FormData): Promise<void> {
  const persona = await currentPersona();
  if (persona.role !== 'straitsx_admin') {
    redirect('/reset?e=role');
  }

  const phrase = String(formData.get('phrase') ?? '').trim();
  if (phrase !== 'RESET') {
    redirect('/reset?e=phrase');
  }

  const required = process.env.ADATA_RESET_PIN;
  if (required && String(formData.get('pin') ?? '') !== required) {
    redirect('/reset?e=pin');
  }

  const requested = formData.get('target');
  const target = WORLD_TARGETS.find((known) => known === requested);
  if (!target) {
    redirect('/reset?e=target');
  }

  await rebuild(target);
  revalidatePath('/', 'layout');
  redirect('/');
}
