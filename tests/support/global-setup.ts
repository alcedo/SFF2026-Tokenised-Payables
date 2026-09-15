/**
 * Build the clone templates, once, without disturbing anyone else's run.
 *
 * Several vitest runs can be in flight at the same time, and each one has
 * several worker processes. So this does two things carefully.
 *
 * Templates are created only when missing, under an advisory lock, and are
 * never dropped here. Dropping and rebuilding them would pull the ground out
 * from under a run that is already cloning. Set REBUILD_TEMPLATES=1 to force a
 * rebuild after a schema change.
 *
 * Teardown removes only the clones this process made. An earlier version swept
 * every `adata_x_%` database, which deleted other runs' databases mid-test.
 */

import { execFileSync } from 'node:child_process';
import { Pool } from 'pg';
import { ADMIN_URL, TEMPLATES, urlFor, clonePrefix, type TemplateKind } from './database';

const ROOT = new URL('../..', import.meta.url).pathname;
const BUILD_LOCK = 20261001;

function psql(url: string, files: readonly string[]): void {
  const args = ['-q', '-v', 'ON_ERROR_STOP=1'];
  for (const file of files) args.push('-f', `${ROOT}/${file}`);
  execFileSync('psql', [url, ...args], { stdio: 'pipe' });
}

// schema.sql defines ledger.post() as a stub that raises 'not implemented';
// post.sql replaces it. Loading only the first gives a database that refuses
// every command, so both always load, in this order.
const SOURCES: Record<TemplateKind, readonly string[]> = {
  bare: ['db/schema.sql', 'db/post.sql'],
  fixtures: ['db/schema.sql', 'db/post.sql', 'db/fixtures.sql'],
  seed: ['db/schema.sql', 'db/post.sql', 'db/seed.sql'],
};

async function exists(admin: Pool, name: string): Promise<boolean> {
  const { rows } = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [name]);
  return rows.length > 0;
}

export async function setup(): Promise<void> {
  // Stamped before any worker forks, so workers inherit it and teardown, which
  // runs back here in this process, removes exactly the databases they made.
  process.env.ADATA_RUN_ID ??= `${process.pid}`;

  execFileSync(`${ROOT}/scripts/db.sh`, ['up'], { stdio: 'pipe' });

  const admin = new Pool({ connectionString: ADMIN_URL, max: 1 });
  try {
    // One builder at a time. A second run arriving mid-build waits here and
    // then finds the templates already present.
    await admin.query('SELECT pg_advisory_lock($1)', [BUILD_LOCK]);
    try {
      for (const kind of Object.keys(TEMPLATES) as TemplateKind[]) {
        const name = TEMPLATES[kind];
        if (process.env.REBUILD_TEMPLATES === '1' && (await exists(admin, name))) {
          await admin.query(`DROP DATABASE ${name} WITH (FORCE)`);
        }
        if (await exists(admin, name)) continue;
        await admin.query(`CREATE DATABASE ${name}`);
        psql(urlFor(name), SOURCES[kind]);
      }
    } finally {
      await admin.query('SELECT pg_advisory_unlock($1)', [BUILD_LOCK]);
    }
  } finally {
    await admin.end();
  }
}

export async function teardown(): Promise<void> {
  const admin = new Pool({ connectionString: ADMIN_URL, max: 1 });
  try {
    const { rows } = await admin.query<{ datname: string }>(
      'SELECT datname FROM pg_database WHERE datname LIKE $1',
      [`${clonePrefix()}%`],
    );
    for (const { datname } of rows) {
      await admin.query(`DROP DATABASE IF EXISTS ${datname} WITH (FORCE)`);
    }
  } finally {
    await admin.end();
  }
}
