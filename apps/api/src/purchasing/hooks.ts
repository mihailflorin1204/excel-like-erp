import { randomUUID } from 'node:crypto';
import type { CommitPlan, SheetStore } from '@erp/db';
import {
  type BatchError,
  type CellValue,
  goodsReceiptsSheet,
  purchaseOrdersSheet,
  roundTo,
  type Row,
  stockMovementsSheet,
  uniqueKey,
} from '@erp/schema';
import { ActionError, type HookContext, type InsertDraft, type SheetHooks } from '../hooks.ts';
import {
  auditEntry,
  commitOrConflict,
  insertAudit,
  MOVEMENTS,
  num,
  planMovementReversal,
  type PostingContext,
  postMovements,
  str,
  today,
} from '../inventory/hooks.ts';
import { journalFor, journalWriter, postMovementEntry } from '../accounting/posting.ts';
import { touchPlan } from '../util.ts';

const POS = 'purchaseOrders';
const LINES = 'purchaseOrderLines';
const RECEIPTS = 'goodsReceipts';
const BILLS = 'supplierBills';
const GR_SOURCE = 'goodsReceipts';

const fmt = (n: number) => String(roundTo(n, 6));
const money = (n: number) => roundTo(n, 2);
const ids = (rows: readonly Row[], column: string) => [...new Set(rows.map((r) => str(r.values[column])).filter((v): v is string => !!v))];
const byId = (rows: readonly Row[]) => new Map(rows.map((r) => [r.id, r]));
const groupBy = (rows: readonly Row[], column: string) => {
  const map = new Map<string, Row[]>();
  for (const r of rows) {
    const key = String(r.values[column] ?? '');
    map.set(key, [...(map.get(key) ?? []), r]);
  }
  return map;
};

/** Net quantity and value received per PO line (reversal rows carry negative quantities, so a plain sum works). */
async function receivedByLine(store: SheetStore, lineIds: readonly string[]): Promise<Map<string, { qty: number; value: number }>> {
  const out = new Map<string, { qty: number; value: number }>();
  if (lineIds.length === 0) return out;
  for (const gr of await store.listWhere(RECEIPTS, 'line', lineIds)) {
    const key = String(gr.values.line);
    const t = out.get(key) ?? { qty: 0, value: 0 };
    t.qty = roundTo(t.qty + (num(gr.values.qty) ?? 0), 6);
    t.value = money(t.value + (num(gr.values.value) ?? 0));
    out.set(key, t);
  }
  return out;
}

/** Everything about a set of POs: their lines, what was received on each line, and what was billed. */
export async function loadOrders(store: SheetStore, poIds: readonly string[]) {
  const pos = byId(await store.getRows(POS, poIds));
  const lines = poIds.length ? await store.listWhere(LINES, 'po', poIds) : [];
  const received = await receivedByLine(store, lines.map((l) => l.id));
  // Reversed bills no longer count as billed.
  const bills = (poIds.length ? await store.listWhere(BILLS, 'po', poIds) : []).filter((b) => b.values.state !== 'Reversed');
  return { pos, lines, linesByPo: groupBy(lines, 'po'), received, billsByPo: groupBy(bills, 'po') };
}

export const lineOutstanding = (line: Row, received: Map<string, { qty: number }>) =>
  roundTo((num(line.values.qty) ?? 0) - (received.get(line.id)?.qty ?? 0), 6);

function poStatus(state: string, ordered: number, receivedQty: number): string {
  if (state !== 'Sent') return state || 'Draft';
  if (receivedQty <= 0) return 'Sent';
  return receivedQty >= ordered ? 'Received' : 'Partially received';
}

/** Quantity still to be delivered per item, over sent POs (for Items · On order). */
export async function onOrderByItem(store: SheetStore, itemIds: readonly string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (itemIds.length === 0) return out;
  const lines = await store.listWhere(LINES, 'item', itemIds);
  const pos = byId(await store.getRows(POS, ids(lines, 'po')));
  const open = lines.filter((l) => pos.get(String(l.values.po))?.values.state === 'Sent');
  const received = await receivedByLine(store, open.map((l) => l.id));
  for (const l of open) {
    const item = String(l.values.item);
    out.set(item, roundTo((out.get(item) ?? 0) + Math.max(0, lineOutstanding(l, received)), 6));
  }
  return out;
}

const postingContext = (user: string): PostingContext => ({ user, now: new Date().toISOString(), batchId: randomUUID() });

/**
 * Bumps the version of the POs a change depends on, in the same transaction. Two requests that read the same
 * PO (a receipt and another receipt, a line edit and Send) then can't both save: the second one conflicts.
 */
const touched = new WeakMap<HookContext, Set<string>>();
function touchPos(ctx: HookContext, pos: readonly Row[]): void {
  const done = touched.get(ctx) ?? new Set<string>();
  touched.set(ctx, done);
  // Each PO once per batch (a second bump in the same transaction would conflict with the first).
  const unique = [...new Map(pos.filter((p) => !done.has(p.id)).map((p) => [p.id, p])).values()];
  if (unique.length === 0) return;
  for (const p of unique) done.add(p.id);
  ctx.related.push(() => ({
    sheet: purchaseOrdersSheet,
    inserts: [],
    updates: unique.map((p) => ({ id: p.id, expectedVersion: p.version, set: {}, updatedAt: ctx.now })),
    deletes: [],
    audit: [],
  }));
}

/** Changes a PO's state (Send / Close), atomically and audited. */
async function setPoState(store: SheetStore, po: Row, state: string, user: string): Promise<void> {
  const ctx = postingContext(user);
  await commitOrConflict(store, {
    sheet: purchaseOrdersSheet,
    inserts: [],
    updates: [{ id: po.id, expectedVersion: po.version, set: { state }, updatedAt: ctx.now }],
    deletes: [],
    audit: [auditEntry(ctx, POS, po.id, 'update', 'state', po.values.state ?? null, state)],
    atomic: true,
  });
}

async function reloadPo(store: SheetStore, id: string): Promise<Row[]> {
  const rows = await store.getRows(POS, [id]);
  await purchasingHooks.purchaseOrders!.computed!(store, rows);
  return rows;
}

async function getPo(store: SheetStore, id: string): Promise<Row> {
  const [po] = await store.getRows(POS, [id]);
  if (!po) throw new ActionError(404, 'Purchase order not found');
  return po;
}

export const purchasingHooks: Record<string, SheetHooks> = {
  suppliers: {
    async computed(store, rows) {
      const pos = (await store.listWhere(POS, 'supplier', rows.map((r) => r.id))).filter((p) => p.values.state === 'Sent');
      const { lines, received } = await loadOrders(store, pos.map((p) => p.id));
      const supplierOf = new Map(pos.map((p) => [p.id, String(p.values.supplier)]));
      const open = new Map<string, number>();
      for (const l of lines) {
        const supplier = supplierOf.get(String(l.values.po))!;
        const value = Math.max(0, lineOutstanding(l, received)) * (num(l.values.unitPrice) ?? 0);
        open.set(supplier, money((open.get(supplier) ?? 0) + value));
      }
      for (const r of rows) r.values.openOrders = open.get(r.id) ?? 0;
    },
  },

  purchaseOrders: {
    /** Numbers new POs PO-00001, PO-00002… unless one was typed, and starts them as drafts. */
    async beforeInsert(store, inserts, ctx) {
      // Every number in use after this batch: saved ones (renames and deletes applied) plus typed new ones.
      const renamed = new Map(ctx.batch.updates.filter((u) => 'number' in u.set).map((u) => [u.id, u.set.number]));
      const deleted = new Set(ctx.batch.deletes.map((r) => r.id));
      const numbers = [
        ...(await store.listWhere(POS, 'number')).filter((r) => !deleted.has(r.id)).map((r) => (renamed.has(r.id) ? renamed.get(r.id) : r.values.number)),
        ...inserts.map((i) => i.values.number),
      ];
      const taken = new Set(numbers.map((n) => uniqueKey(n ?? null)).filter(Boolean));
      // Only up to 9 digits count towards the sequence, so a huge typed number can't break it.
      const sequence = numbers.map((n) => /^PO-(\d{1,9})$/i.exec(String(n ?? ''))?.[1]).map((d) => Number(d ?? 0));
      let next = Math.max(0, ...sequence) + 1;
      for (const ins of inserts) {
        if (!str(ins.values.number)) {
          let candidate = `PO-${String(next++).padStart(5, '0')}`;
          while (taken.has(uniqueKey(candidate))) candidate = `PO-${String(next++).padStart(5, '0')}`;
          ins.values.number = candidate;
          taken.add(uniqueKey(candidate));
        }
        ins.values.state = 'Draft';
      }
      return [];
    },

    async beforeUpdate(_store, updates) {
      return updates
        .filter((u) => 'number' in u.set && !str(u.set.number))
        .map((u) => ({ op: 'update' as const, ref: u.id, column: 'number', message: 'A PO needs a number' }));
    },

    async computed(store, rows) {
      const { linesByPo, received, billsByPo } = await loadOrders(store, rows.map((r) => r.id));
      for (const r of rows) {
        const lines = linesByPo.get(r.id) ?? [];
        let total = 0;
        let ordered = 0;
        let qtyIn = 0;
        let valueIn = 0;
        for (const l of lines) {
          total += (num(l.values.qty) ?? 0) * (num(l.values.unitPrice) ?? 0);
          ordered += num(l.values.qty) ?? 0;
          qtyIn += received.get(l.id)?.qty ?? 0;
          valueIn += received.get(l.id)?.value ?? 0;
        }
        r.values.total = money(total);
        r.values.received = money(valueIn);
        r.values.billed = money((billsByPo.get(r.id) ?? []).reduce((sum, b) => sum + (num(b.values.amount) ?? 0), 0));
        r.values.lineCount = lines.length;
        r.values.status = poStatus(String(r.values.state ?? ''), ordered, qtyIn);
      }
    },

    actions: {
      async send(store, id, user) {
        const po = await getPo(store, id);
        if (po.values.state !== 'Draft') throw new ActionError(409, `${po.values.number} is already ${String(po.values.state).toLowerCase()}`);
        const lines = await store.listWhere(LINES, 'po', [id]);
        if (lines.length === 0) throw new ActionError(409, `${po.values.number} has no lines yet. Add them in Purchase order lines.`);
        await setPoState(store, po, 'Sent', user);
        return reloadPo(store, id);
      },

      async close(store, id, user) {
        const po = await getPo(store, id);
        if (po.values.state !== 'Sent') throw new ActionError(409, `Only a sent PO can be closed (${po.values.number} is ${String(po.values.state).toLowerCase()})`);
        await setPoState(store, po, 'Closed', user);
        return reloadPo(store, id);
      },

      /** Posts one goods receipt per line for whatever is still outstanding, through the normal receipt rules. */
      async receiveAll(store, id, user) {
        const po = await getPo(store, id);
        if (po.values.state !== 'Sent') throw new ActionError(409, `${po.values.number} must be sent before goods can be received`);
        const { lines, received } = await loadOrders(store, [id]);
        const inserts = lines
          .filter((l) => lineOutstanding(l, received) > 0)
          .map((l, i) => ({ tempId: `all-${i}`, values: { po: id, item: l.values.item ?? null, qty: lineOutstanding(l, received) } }));
        if (inserts.length === 0) throw new ActionError(409, `Nothing outstanding on ${po.values.number}`);
        const { runBatch } = await import('../batch.ts');
        // All or nothing: if any line can't be received, nothing is posted and the reason is shown.
        const res = await runBatch(store, goodsReceiptsSheet, { inserts, updates: [], deletes: [] }, user, { allOrNothing: true });
        if (res.errors.length > 0) throw new ActionError(409, `Nothing received: ${[...new Set(res.errors.map((e) => e.message))].join('; ')}`);
        return reloadPo(store, id);
      },
    },
  },

  purchaseOrderLines: {
    async beforeInsert(store, inserts, ctx) {
      const errors: BatchError[] = [];
      const poIds = [...new Set(inserts.map((i) => String(i.values.po)))];
      const { pos } = await loadOrders(store, poIds);
      const onPo = await itemsAfterBatch(store, poIds, ctx);
      const items = byId(await store.getRows('items', [...new Set(inserts.map((i) => String(i.values.item)))]));
      const accepted: Row[] = [];

      for (const ins of inserts) {
        const v = ins.values;
        const err = (column: string, message: string) => errors.push({ op: 'insert', ref: ins.tempId, column, message });
        const po = pos.get(String(v.po))!;
        const item = items.get(String(v.item));
        if (po.values.state !== 'Draft') {
          err('po', `${po.values.number} has been sent, so lines can't be added. Start a new PO.`);
          continue;
        }
        if ((num(v.qty) ?? 0) <= 0) {
          err('qty', 'Must be more than 0');
          continue;
        }
        const seen = onPo.get(po.id) ?? new Set<string>();
        if (seen.has(String(v.item))) {
          err('item', `${item?.values.sku ?? 'This item'} is already on ${po.values.number}; change that line's qty instead`);
          continue;
        }
        if (num(v.unitPrice) === null) {
          const cost = num(item?.values.cost);
          if (cost === null) {
            err('unitPrice', 'Enter a price (the item has no default cost)');
            continue;
          }
          v.unitPrice = cost;
        }
        seen.add(String(v.item));
        onPo.set(po.id, seen);
        accepted.push(po);
      }
      touchPos(ctx, accepted);
      return errors;
    },

    async beforeUpdate(store, updates, ctx) {
      const errors: BatchError[] = [];
      const poIds = [...new Set(updates.map((u) => String(u.current.values.po)))];
      for (const u of updates) {
        if ('qty' in u.set && (num(u.set.qty) ?? 0) <= 0) errors.push({ op: 'update', ref: u.id, column: 'qty', message: 'Must be more than 0' });
        if ('unitPrice' in u.set && u.set.unitPrice === null) {
          errors.push({ op: 'update', ref: u.id, column: 'unitPrice', message: 'A line needs a price' });
        }
      }
      // One item per PO, judged on how the lines will look after this batch (so swapping two items works).
      const lines = await store.listWhere(LINES, 'po', poIds);
      const deleted = new Set(ctx.batch.deletes.map((r) => r.id));
      const changedItem = new Map(updates.filter((u) => 'item' in u.set).map((u) => [u.id, String(u.set.item)]));
      const count = new Map<string, number>();
      const keyOf = (l: Row) => `${l.values.po}|${changedItem.get(l.id) ?? l.values.item}`;
      for (const l of lines) if (!deleted.has(l.id)) count.set(keyOf(l), (count.get(keyOf(l)) ?? 0) + 1);
      for (const u of updates) {
        if (!changedItem.has(u.id)) continue;
        if ((count.get(`${u.current.values.po}|${changedItem.get(u.id)}`) ?? 0) > 1) {
          errors.push({ op: 'update', ref: u.id, column: 'item', message: "That item is already on this PO; change that line's qty instead" });
        }
      }
      // The state checked here is the version bumped, so a Send that lands in between makes this save conflict.
      const pos = await store.getRows(POS, poIds);
      const draft = new Set(pos.filter((p) => p.values.state === 'Draft').map((p) => p.id));
      for (const u of updates) {
        if (!draft.has(String(u.current.values.po))) errors.push({ op: 'update', ref: u.id, message: 'The PO has been sent, so its lines are locked.' });
      }
      touchPos(ctx, pos);
      return errors;
    },

    async beforeDelete(store, rows, ctx) {
      // Deleting a line also counts as changing its (draft) PO, so it can't race with Send.
      const pos = await store.getRows(POS, ids(rows, 'po'));
      const draft = new Set(pos.filter((p) => p.values.state === 'Draft').map((p) => p.id));
      touchPos(ctx, pos);
      return rows
        .filter((r) => !draft.has(String(r.values.po)))
        .map((r) => ({ op: 'delete' as const, ref: r.id, message: 'The PO has been sent, so its lines are locked.' }));
    },

    async computed(store, rows) {
      const pos = byId(await store.getRows(POS, ids(rows, 'po')));
      const received = await receivedByLine(store, rows.map((r) => r.id));
      for (const r of rows) {
        const po = pos.get(String(r.values.po));
        const qty = num(r.values.qty) ?? 0;
        const got = received.get(r.id)?.qty ?? 0;
        const state = String(po?.values.state ?? 'Draft');
        r.values.lineTotal = money(qty * (num(r.values.unitPrice) ?? 0));
        r.values.received = got;
        r.values.outstanding = state === 'Closed' ? 0 : Math.max(0, roundTo(qty - got, 6));
        r.values.poState = state;
        r.values.supplier = po?.values.supplier ?? null;
        r.values.status =
          state === 'Draft' ? 'Draft' : got >= qty ? 'Received' : state === 'Closed' ? 'Closed' : got > 0 ? 'Partially received' : 'Open';
      }
    },
  },

  goodsReceipts: {
    /**
     * A receipt must match a line on a sent PO and can't exceed what is outstanding (checked row by row, so
     * two rows in one paste can't over-receive together). Each saved receipt posts a Receipt movement at the
     * PO price in the same transaction.
     */
    async beforeInsert(store, inserts, ctx) {
      const errors: BatchError[] = [];
      const { pos, linesByPo, received } = await loadOrders(store, [...new Set(inserts.map((i) => String(i.values.po)))]);
      const items = byId(await store.getRows('items', [...new Set(inserts.map((i) => String(i.values.item)))]));
      const taken = new Map<string, number>(); // received in this batch per line
      const accepted: { ins: InsertDraft; movementId: string; movement: InsertDraft }[] = [];

      for (const ins of inserts) {
        const v = ins.values;
        const err = (column: string, message: string) => errors.push({ op: 'insert', ref: ins.tempId, column, message });
        const po = pos.get(String(v.po))!;
        const sku = items.get(String(v.item))?.values.sku ?? 'This item';
        if (po.values.state === 'Draft') {
          err('po', `${po.values.number} is still a draft. Send it before receiving goods.`);
          continue;
        }
        if (po.values.state === 'Closed') {
          err('po', `${po.values.number} is closed; no more deliveries can be received`);
          continue;
        }
        const line = (linesByPo.get(po.id) ?? []).find((l) => l.values.item === v.item);
        if (!line) {
          err('item', `${sku} isn't on ${po.values.number}`);
          continue;
        }
        const qty = num(v.qty) ?? 0;
        if (qty <= 0) {
          err('qty', 'Must be more than 0');
          continue;
        }
        const outstanding = roundTo(lineOutstanding(line, received) - (taken.get(line.id) ?? 0), 6);
        if (qty > outstanding) {
          err('qty', outstanding > 0 ? `Only ${fmt(outstanding)} outstanding on ${po.values.number}` : `Nothing outstanding for ${sku} on ${po.values.number}`);
          continue;
        }
        taken.set(line.id, roundTo((taken.get(line.id) ?? 0) + qty, 6));

        const price = num(line.values.unitPrice) ?? 0;
        const movementId = randomUUID();
        v.date = str(v.date) ?? today();
        v.warehouse = str(v.warehouse) ?? po.values.warehouse ?? null;
        v.unitCost = price;
        v.value = money(qty * price);
        v.line = line.id;
        v.movement = movementId;
        v.reversalOf = null;
        v.reversedBy = null;
        const reference = [po.values.number, str(v.reference)].filter(Boolean).join(' / ');
        accepted.push({
          ins,
          movementId,
          movement: {
            tempId: ins.tempId,
            values: {
              date: v.date,
              type: 'Receipt',
              item: v.item ?? null,
              warehouse: v.warehouse,
              toWarehouse: null,
              qty,
              unitCost: price,
              reason: null,
              reference: reference.slice(0, 80),
              source: GR_SOURCE,
            },
          },
        });
      }

      touchPos(ctx, accepted.map((a) => pos.get(String(a.ins.values.po))!));

      // Cost the stock movements with the inventory rules (moving average), then save them with the receipts.
      const movementErrors = await postMovements(store, accepted.map((a) => a.movement));
      for (const e of movementErrors) errors.push({ ...e, column: e.column === 'unitCost' ? 'qty' : e.column });
      const failed = new Set(movementErrors.map((e) => e.ref));
      const ok = accepted.filter((a) => !failed.has(a.ins.tempId));
      if (ok.length > 0) {
        // Dr Inventory / Cr Goods received not invoiced, per receipt, saved only if the receipt is.
        const journal = await journalFor(store, ctx);
        for (const a of ok) {
          postMovementEntry(journal, a.movement.values, { id: a.movementId, keepIfTempId: a.ins.tempId, sku: str(items.get(String(a.ins.values.item))?.values.sku) });
        }
      }

      ctx.related.push((idsByTempId): CommitPlan => {
        const rows: Row[] = ok
          .filter((a) => idsByTempId.has(a.ins.tempId))
          .map((a) => ({ id: a.movementId, version: 1, createdAt: ctx.now, updatedAt: ctx.now, values: a.movement.values }));
        return {
          sheet: stockMovementsSheet,
          inserts: rows,
          updates: [],
          deletes: [],
          audit: rows.flatMap((r) => insertAudit(ctx, MOVEMENTS, r)),
        };
      });
      return errors;
    },

    async computed(_store, rows) {
      for (const r of rows) {
        r.values.status = str(r.values.reversedBy) ? 'Reversed' : str(r.values.reversalOf) ? 'Reversal' : 'Posted';
      }
    },

    actions: {
      /** Reverses the receipt and its stock movement together (both or neither). */
      async reverse(store, id, user) {
        const [original] = await store.getRows(RECEIPTS, [id]);
        if (!original) throw new ActionError(404, 'Goods receipt not found');
        const o = original.values;
        if (str(o.reversedBy)) throw new ActionError(409, 'This receipt is already reversed');
        if (str(o.reversalOf)) throw new ActionError(409, 'This is a reversal; post a new receipt instead');
        const [movement] = await store.getRows(MOVEMENTS, [String(o.movement)]);
        if (!movement) throw new ActionError(409, "This receipt's stock movement is missing");
        // Posted bills have cleared Goods received not invoiced for what was received; taking back goods that
        // are already billed would leave that account wrong, so the bill must be reversed first.
        const poId = String(o.po);
        const { pos, linesByPo, received, billsByPo } = await loadOrders(store, [poId]);
        const po = pos.get(poId);
        const receivedValue = (linesByPo.get(poId) ?? []).reduce((sum, l) => sum + (received.get(l.id)?.value ?? 0), 0);
        const postedBills = (billsByPo.get(poId) ?? []).filter((b) => b.values.state === 'Posted');
        const cleared = postedBills.reduce((sum, b) => sum + (num(b.values.grniCleared) ?? 0), 0);
        if (cleared > money(receivedValue - (num(o.value) ?? 0)) + 0.005) {
          throw new ActionError(
            409,
            `This receipt is already billed (${postedBills.map((b) => b.values.billNo).join(', ')}). Reverse the bill first, or post a stock adjustment instead.`,
          );
        }

        const ctx = postingContext(user);
        const journal = await journalWriter(store, ctx);
        const stock = await planMovementReversal(store, movement, ctx, GR_SOURCE, journal);
        const reversal: Row = {
          id: randomUUID(),
          version: 1,
          createdAt: ctx.now,
          updatedAt: ctx.now,
          values: {
            ...o,
            date: today(),
            qty: -(num(o.qty) ?? 0),
            value: -(num(o.value) ?? 0),
            movement: stock.reversal.id,
            reversalOf: original.id,
            reversedBy: null,
          },
        };
        delete reversal.values.status;
        await commitOrConflict(store, {
          sheet: goodsReceiptsSheet,
          inserts: [reversal],
          updates: [{ id: original.id, expectedVersion: original.version, set: { reversedBy: reversal.id }, updatedAt: ctx.now }],
          deletes: [],
          audit: [...insertAudit(ctx, RECEIPTS, reversal), auditEntry(ctx, RECEIPTS, original.id, 'update', 'reversedBy', null, reversal.id)],
          atomic: true,
          // Bumping the PO makes a bill being posted on it at the same moment conflict.
          related: [stock.plan, ...(po ? [touchPlan(purchaseOrdersSheet, [po], ctx.now)] : []), ...journal.plans()],
        });
        const updated: Row = { ...original, version: original.version + 1, updatedAt: ctx.now, values: { ...o, reversedBy: reversal.id } };
        return [updated, reversal];
      },
    },
  },
};

/**
 * Items on each PO once this batch is applied: saved lines (minus deleted ones, with changed items applied).
 * New rows are added by the caller as it accepts them.
 */
async function itemsAfterBatch(store: SheetStore, poIds: readonly string[], ctx: HookContext): Promise<Map<string, Set<string>>> {
  const deleted = new Set(ctx.batch.deletes.map((r) => r.id));
  const changedItem = new Map(ctx.batch.updates.filter((u) => 'item' in u.set).map((u) => [u.id, String(u.set.item)]));
  const out = new Map<string, Set<string>>();
  for (const l of await store.listWhere(LINES, 'po', poIds)) {
    if (deleted.has(l.id)) continue;
    const set = out.get(String(l.values.po)) ?? new Set<string>();
    set.add(changedItem.get(l.id) ?? String(l.values.item));
    out.set(String(l.values.po), set);
  }
  return out;
}

export function addDays(isoDate: string, days: number): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
