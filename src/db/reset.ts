import { closePool, pool } from './client';
import { applySchemaAndPost, applySeed, beginWorldLoad } from './sql';

/**
 * Rebuild the world from the schema and the seed.
 *
 * PRD §11 requires a reset that "restores the complete seed state, including
 * the clock and the mocked FX rate". The clock is a fixed T0 plus a
 * forward-only offset, so there is nothing to unwind; reloading is the only
 * honest way back.
 *
 * This executes the SQL files rather than shelling out to scripts/db.sh,
 * because on Vercel there is no shell, no psql and no scripts directory. The
 * files themselves are traced into the deployment by next.config.mjs.
 */
export async function resetWorld(): Promise<void> {
  const client = await pool().connect();
  try {
    // One transaction: a half-reset world would be worse than no reset, and a
    // presenter pressing this mid-sentence deserves either the old world or the
    // new one, never a mixture.
    await beginWorldLoad(client);
    await client.query('DROP SCHEMA IF EXISTS app CASCADE');
    await client.query('DROP SCHEMA IF EXISTS ledger CASCADE');
    await applySchemaAndPost(client);
    await applySeed(client);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }

  // The seed recreates every table, so any pooled connection still holding a
  // plan against the old ones would fail its next query.
  await closePool();
}
