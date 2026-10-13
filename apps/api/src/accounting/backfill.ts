import type { SheetStore } from '@erp/db';
import { type AuditEntry, type Row, stockMovementsSheet, supplierBillsSheet } from '@erp/schema';
import { ActionError } from '../hooks.ts';
import { MOVEMENTS, skusOf } from '../inventory/hooks.ts';
import { planBillPosting } from '../purchasing/payables.ts';
import { postingContext, str, updateAudit } from '../util.ts';
import { ENTRIES, journalWriters, postMovementEntry } from './posting.ts';

/** Movements per transaction, so a large history never runs into the database's transaction limits. */
const CHUNK = 500;

/**
 * Brings data saved before accounting existed into the ledger, once:
 * - every stock movement without a journal link gets its entry (receipts from goods receipts against GRNI,
 *   other receipts against Opening balances, issues against COGS, adjustments against Stock adjustments);
 * - every bill without a state is posted, or becomes a draft if it can't be posted yet (it is then shown as
 *   Draft so it can be corrected and posted by hand).
 * Only rows that lack the new columns are read, so later starts cost one indexed query each. Each chunk is
 * one transaction; if a run stops halfway, the next start carries on where it left off. Returns a summary,
 * or '' if there was nothing to do.
 */
export async function backfillJournal(store: SheetStore): Promise<string> {
  const writerFor = await journalWriters(store);
  const parts: string[] = [];

  const movements = await store.listWithout(MOVEMENTS, 'journalEntry');
  if (movements.length > 0) {
    const skus = await skusOf(store, movements.map((m) => String(m.values.item)));
    let posted = 0;
    for (let start = 0; start < movements.length; start += CHUNK) {
      const chunk = movements.slice(start, start + CHUNK);
      const ctx = postingContext('system');
      const journal = writerFor(ctx);
      // A reversal links to its original's entry: new in this chunk, or saved earlier (then marked reversed).
      const originals = await store.getRows(MOVEMENTS, chunk.flatMap((m) => (str(m.values.reversalOf) ? [String(m.values.reversalOf)] : [])));
      const entryOfMovement = new Map(originals.map((m) => [m.id, str(m.values.journalEntry)]));
      const savedEntries = new Map(
        (await store.getRows(ENTRIES, [...entryOfMovement.values()].filter((v): v is string => !!v))).map((e) => [e.id, e]),
      );
      const updates = [];
      const audit: AuditEntry[] = [];
      for (const m of chunk) {
        const v = { ...m.values };
        const originalEntry = str(v.reversalOf) ? (entryOfMovement.get(String(v.reversalOf)) ?? null) : null;
        const id = postMovementEntry(journal, v, { id: m.id, sku: skus.get(String(v.item)), reversalOf: originalEntry });
        if (id) posted++;
        const saved: Row | undefined = originalEntry && !journal.has(originalEntry) ? savedEntries.get(originalEntry) : undefined;
        if (id && saved && !str(saved.values.reversedBy)) journal.markReversed(saved, id);
        entryOfMovement.set(m.id, id);
        updates.push({ id: m.id, expectedVersion: m.version, set: { journalEntry: id }, updatedAt: ctx.now });
        audit.push(...updateAudit(ctx, MOVEMENTS, m, { journalEntry: id }));
      }
      await store.commit({ sheet: stockMovementsSheet, inserts: [], updates, deletes: [], audit, atomic: true, related: journal.plans() });
    }
    parts.push(`${posted} journal entries for ${movements.length} earlier stock movements`);
  }

  const bills = await store.listWithout('supplierBills', 'state');
  const drafts: string[] = [];
  for (const bill of bills) {
    const ctx = postingContext('system');
    try {
      await store.commit(await planBillPosting(store, bill, ctx, writerFor(ctx)));
    } catch (err) {
      if (!(err instanceof ActionError)) throw err;
      drafts.push(String(bill.values.billNo));
      await store.commit({
        sheet: supplierBillsSheet,
        inserts: [],
        updates: [{ id: bill.id, expectedVersion: bill.version, set: { state: 'Draft' }, updatedAt: ctx.now }],
        deletes: [],
        audit: updateAudit(ctx, 'supplierBills', bill, { state: 'Draft' }),
        atomic: true,
      });
    }
  }
  if (bills.length > 0) {
    parts.push(`${bills.length - drafts.length} earlier bills posted`);
    if (drafts.length > 0) parts.push(`left as draft (can't be posted yet): ${drafts.join(', ')}`);
  }
  return parts.join('; ');
}
