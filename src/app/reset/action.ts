'use server';

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';

import { closePool } from '@/db/client';

const run = promisify(execFile);

/**
 * Reset by reloading the seed, rather than by walking the world backwards.
 *
 * The clock is a fixed T0 plus a forward-only offset, so there is no "undo" to
 * apply; restoring the seed is the only honest way back. The pool is closed
 * first because the reset drops the database out from under any open
 * connection, and a pooled socket to a dropped database fails the next request
 * in a way that looks like a bug in the app.
 */
export async function resetWorld(): Promise<void> {
  await closePool();
  await run('scripts/db.sh', ['reset'], { cwd: process.cwd() });
  revalidatePath('/', 'layout');
  redirect('/');
}
