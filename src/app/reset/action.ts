'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';

import { resetWorld as rebuild } from '@/db/reset';

/**
 * PRD §11's "Reset world". Restores the complete seed state, including the
 * clock and the mocked FX rate, for every connected session at once.
 */
export async function resetWorld(): Promise<void> {
  await rebuild();
  revalidatePath('/', 'layout');
  redirect('/');
}
