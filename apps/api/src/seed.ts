import { type SheetStore, seedData } from '@erp/db';
import { getSheet } from '@erp/schema';
import { runBatch } from './batch.ts';

/** Adds the starter rows to every empty sheet. Goes through runBatch, so seed rows are validated and audited too. */
export async function seedIfEmpty(store: SheetStore): Promise<string[]> {
  const seeded: string[] = [];
  for (const [key, rows] of Object.entries(seedData)) {
    const sheet = getSheet(key);
    if (!sheet || !(await store.isEmpty(key))) continue;
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
