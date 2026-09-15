/**
 * Build the clone templates once per run.
 *
 * vitest workers are separate processes. If each built its own template they
 * would collide on the same database names, so this runs once before any
 * worker starts and the workers only ever clone.
 */

import { execFileSync } from 'node:child_process';
import { Pool } from 'pg';
import { ADMIN_URL, TEMPLATES, urlFor, type TemplateKind } from './database';

const ROOT = new URL('../..', import.meta.url).pathname;

function psql(url: string, files: readonly string[]): void {
  const args = ['-q', '-v', 'ON_ERROR_STOP=1'];
  for (const file of files) args.push('-f', `${ROOT}/${file}`);
  execFileSync('psql', [url, ...args], { stdio: 'pipe' });
}

const SOURCES: Record<TemplateKind, readonly string[]> = {
  bare: ['db/schema.sql', 'db/post.sql'],
  fixtures: ['db/schema.sql', 'db/post.sql', 'db/fixtures.sql'],
  seed: ['db/schema.sql', 'db/post.sql', 'db/seed.sql'],
};

export async function setup(): Promise<void> {
  execFileSync(`${ROOT}/scripts/db.sh`, ['up'], { stdio: 'pipe' });

  const admin = new Pool({ connectionString: ADMIN_URL, max: 1 });
  try {
    // Clones from a previous run keep their template pinned, so they have to go
    // before the template can be dropped and rebuilt.
    const { rows } = await admin.query<{ datname: string }>(
      "SELECT datname FROM pg_database WHERE datname LIKE 'adata_x_%'",
    );
    for (const { datname } of rows) {
      await admin.query(`DROP DATABASE IF EXISTS ${datname} WITH (FORCE)`);
    }

    for (const kind of Object.keys(TEMPLATES) as TemplateKind[]) {
      const name = TEMPLATES[kind];
      await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await admin.query(`CREATE DATABASE ${name}`);
      psql(urlFor(name), SOURCES[kind]);
    }
  } finally {
    await admin.end();
  }
}

export async function teardown(): Promise<void> {
  const admin = new Pool({ connectionString: ADMIN_URL, max: 1 });
  try {
    const { rows } = await admin.query<{ datname: string }>(
      "SELECT datname FROM pg_database WHERE datname LIKE 'adata_x_%' OR datname LIKE 'adata_t_%'",
    );
    for (const { datname } of rows) {
      await admin.query(`DROP DATABASE IF EXISTS ${datname} WITH (FORCE)`);
    }
  } finally {
    await admin.end();
  }
}
