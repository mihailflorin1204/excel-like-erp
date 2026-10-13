import { type SheetStore, seedData } from '@erp/db';
import { getSheet } from '@erp/schema';
import { runBatch } from './batch.ts';

/**
 * Adds the starter rows, but only to a brand-new database (every seeded sheet empty). Once you have your own
 * data nothing is added, so demo stock can never land in a real, locked ledger.
 * Goes through runBatch, so seed rows are validated, costed and audited like any other.
 */
export async function seedIfEmpty(store: SheetStore): Promise<string[]> {
  const seeded: string[] = [];
  for (const key of Object.keys(seedData)) {
    if (!(await store.isEmpty(key))) return seeded;
  }
  for (const [key, rows] of Object.entries(seedData)) {
    const sheet = getSheet(key);
    if (!sheet) continue;
    const res = await runBatch(
      store,
      sheet,
      { updates: [], deletes: [], inserts: rows.map((values, i) => ({ tempId: `seed-${i}`, values })) },
      'seed',
    );
    if (res.errors.length > 0) throw new Error(`Seed data for ${key} is invalid: ${JSON.stringify(res.errors)}`);
    seeded.push(`${key} (${res.inserted.length})`);
  }
  return seeded;
}
