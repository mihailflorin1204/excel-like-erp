import { type SheetStore, seedActions, seedData } from '@erp/db';
import { getSheet, usersSheet } from '@erp/schema';
import { setPassword } from './auth.ts';
import { insertAudit, newRow, postingContext } from './util.ts';
import { runBatch } from './batch.ts';
import { hooks } from './hooks.ts';

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
  const run = async (steps: typeof seedActions) => {
    for (const step of steps) {
      const [target] = await store.listWhere(step.sheet, step.match.column, [step.match.value]);
      const action = hooks[step.sheet]?.actions?.[step.action];
      if (!target || !action) throw new Error(`Seed action ${step.action} on ${step.match.value} can't run`);
      await action(store, target.id, 'seed');
    }
  };
  for (const [key, rows] of Object.entries(seedData)) {
    const sheet = getSheet(key);
    if (!sheet) continue;
    await run(seedActions.filter((a) => a.before === key));
    const res = await runBatch(
      store,
      sheet,
      { updates: [], deletes: [], inserts: rows.map((values, i) => ({ tempId: `seed-${i}`, values })) },
      'seed',
    );
    if (res.errors.length > 0) throw new Error(`Seed data for ${key} is invalid: ${JSON.stringify(res.errors)}`);
    seeded.push(`${key} (${res.inserted.length})`);
    await run(seedActions.filter((a) => a.after === key));
  }
  return seeded;
}

/** In-memory mode only: a known admin so the app can be tried at once. Never added to a real database. */
export const DEMO_USER = { email: 'admin@example.com', name: 'Demo admin', password: 'demo-password' };

export async function addDemoUser(store: SheetStore): Promise<boolean> {
  if (!(await store.isEmpty('users'))) return false;
  const ctx = postingContext('seed');
  const user = newRow(ctx, { email: DEMO_USER.email, name: DEMO_USER.name, role: 'Admin', status: 'Active', lastSignIn: null });
  await store.commit({ sheet: usersSheet, inserts: [user], updates: [], deletes: [], audit: insertAudit(ctx, 'users', user) });
  await setPassword(store, user.id, DEMO_USER.password, false, 'seed');
  return true;
}
