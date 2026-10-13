import type { CommitPlan, SheetStore } from '@erp/db';
import {
  type BatchError,
  type CellValue,
  purchaseOrdersSheet,
  type Row,
  supplierBillsSheet,
  supplierPaymentsSheet,
  uniqueKey,
} from '@erp/schema';
import { type JournalWriter, journalFor, journalWriter } from '../accounting/posting.ts';
import { ActionError, type SheetHooks } from '../hooks.ts';
import { commitOrConflict } from '../inventory/hooks.ts';
import {
  byId,
  eur,
  groupBy,
  ids,
  insertAudit,
  money,
  newRow,
  num,
  type PostingContext,
  postingContext,
  str,
  today,
  touchInBatch,
  touchPlan,
  updateAudit,
} from '../util.ts';
import { addDays, lineOutstanding, loadOrders } from './hooks.ts';

const BILLS = 'supplierBills';
const PAYMENTS = 'supplierPayments';
const POS = 'purchaseOrders';

/** A bill saved before Phase 4 has no state yet: it counts as a draft until it is posted. */
const billState = (bill: Row): string => str(bill.values.state) ?? 'Draft';

/** Net amount paid per bill (reversals carry negative amounts, so a plain sum works). */
async function paidByBill(store: SheetStore, billIds: readonly string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (billIds.length === 0) return out;
  for (const p of await store.listWhere(PAYMENTS, 'bill', billIds)) {
    const key = String(p.values.bill);
    out.set(key, money((out.get(key) ?? 0) + (num(p.values.amount) ?? 0)));
  }
  return out;
}

async function getBill(store: SheetStore, id: string): Promise<Row> {
  const [bill] = await store.getRows(BILLS, [id]);
  if (!bill) throw new ActionError(404, 'Bill not found');
  return bill;
}

async function reloadBill(store: SheetStore, id: string): Promise<Row[]> {
  const rows = await store.getRows(BILLS, [id]);
  await payablesHooks.supplierBills!.computed!(store, rows);
  return rows;
}

/**
 * Books a draft bill: Dr Goods received not invoiced (up to what was received on the PO and not yet billed),
 * Dr Purchase price variance (the rest, only once the PO is fully received or closed), Cr Accounts payable.
 * Throws ActionError when the bill can't be posted yet.
 */
export async function planBillPosting(store: SheetStore, bill: Row, ctx: PostingContext, journal: JournalWriter): Promise<CommitPlan> {
  const v = bill.values;
  const state = billState(bill);
  if (state !== 'Draft') throw new ActionError(409, `Bill ${v.billNo} is already ${state.toLowerCase()}`);
  const poId = String(v.po);
  const { pos, linesByPo, received, billsByPo } = await loadOrders(store, [poId]);
  const po = pos.get(poId);
  if (!po) throw new ActionError(409, `The PO of bill ${v.billNo} is missing`);
  const lines = linesByPo.get(poId) ?? [];
  const receivedValue = money(lines.reduce((s, l) => s + (received.get(l.id)?.value ?? 0), 0));
  const clearedBefore = (billsByPo.get(poId) ?? [])
    .filter((b) => b.id !== bill.id && billState(b) === 'Posted')
    .reduce((s, b) => s + (num(b.values.grniCleared) ?? 0), 0);
  const openGrni = money(receivedValue - clearedBefore);
  const amount = money(num(v.amount) ?? 0);
  const complete = po.values.state === 'Closed' || lines.every((l) => lineOutstanding(l, received) <= 0);

  let cleared: number;
  if (amount <= openGrni) {
    cleared = amount;
  } else if (complete) {
    cleared = Math.max(0, openGrni);
  } else {
    throw new ActionError(
      409,
      `Bill ${v.billNo} is ${eur(amount - Math.max(0, openGrni))} more than what was received on ${po.values.number} and not yet billed (${eur(Math.max(0, openGrni))}). Receive the rest first, or Close the PO if nothing more is coming.`,
    );
  }
  const variance = money(amount - cleared);
  const [supplier] = await store.getRows('suppliers', [String(po.values.supplier ?? '')]);
  const entryId = journal.add({
    date: str(v.date) ?? today(),
    memo: `Bill ${v.billNo} · ${po.values.number} · ${supplier?.values.code ?? ''}`,
    origin: 'Supplier bill',
    source: BILLS,
    sourceId: bill.id,
    lines: [
      { account: journal.account('grni'), debit: cleared },
      { account: journal.account('priceVariance'), debit: variance },
      { account: journal.account('payable'), credit: amount },
    ],
  });
  const set: Record<string, CellValue> = { state: 'Posted', journalEntry: entryId, grniCleared: cleared, variance };
  return {
    sheet: supplierBillsSheet,
    inserts: [],
    updates: [{ id: bill.id, expectedVersion: bill.version, set, updatedAt: ctx.now }],
    deletes: [],
    audit: updateAudit(ctx, BILLS, bill, set),
    atomic: true,
    // Bumping the PO makes a receipt or another bill on the same PO at the same moment conflict.
    related: [touchPlan(purchaseOrdersSheet, [po], ctx.now), ...journal.plans()],
  };
}

export const payablesHooks: Record<string, SheetHooks> = {
  supplierBills: {
    /** Bills need a sent PO, a positive amount, and a bill number not already entered for that supplier. */
    async beforeInsert(store, inserts) {
      const errors: BatchError[] = [];
      const pos = byId(await store.getRows(POS, [...new Set(inserts.map((i) => String(i.values.po)))]));
      const supplierOf = (poId: CellValue | undefined) => String(pos.get(String(poId))?.values.supplier ?? '');
      const existing = (await store.listWhere(BILLS, 'billNo')).filter((b) => billState(b) !== 'Reversed');
      const existingPos = byId(await store.getRows(POS, ids(existing, 'po')));
      const seen = new Set(existing.map((b) => `${existingPos.get(String(b.values.po))?.values.supplier}|${uniqueKey(b.values.billNo ?? null)}`));

      for (const ins of inserts) {
        const v = ins.values;
        const err = (column: string, message: string) => errors.push({ op: 'insert', ref: ins.tempId, column, message });
        const po = pos.get(String(v.po))!;
        if (po.values.state === 'Draft') {
          err('po', `${po.values.number} is still a draft. Bills can only be entered for sent POs.`);
          continue;
        }
        if ((num(v.amount) ?? 0) <= 0) {
          err('amount', 'Must be more than 0');
          continue;
        }
        const key = `${supplierOf(v.po)}|${uniqueKey(v.billNo ?? null)}`;
        if (seen.has(key)) {
          err('billNo', `Bill ${v.billNo} from this supplier is already entered`);
          continue;
        }
        seen.add(key);
        Object.assign(v, { state: 'Draft', variance: null, grniCleared: null, journalEntry: null, reversalEntry: null });
      }
      return errors;
    },

    async beforeUpdate(_store, updates) {
      return updates
        .filter((u) => 'amount' in u.set && (num(u.set.amount) ?? 0) <= 0)
        .map((u) => ({ op: 'update' as const, ref: u.id, column: 'amount', message: 'Must be more than 0' }));
    },

    async computed(store, rows) {
      const poIds = ids(rows, 'po');
      const { pos, linesByPo, received, billsByPo } = await loadOrders(store, poIds);
      const suppliers = byId(await store.getRows('suppliers', ids([...pos.values()], 'supplier')));
      const paid = await paidByBill(store, rows.map((r) => r.id));
      const now = today();
      for (const r of rows) {
        const po = pos.get(String(r.values.po));
        const supplier = suppliers.get(String(po?.values.supplier ?? ''));
        const poReceived = money((linesByPo.get(String(r.values.po)) ?? []).reduce((s, l) => s + (received.get(l.id)?.value ?? 0), 0));
        const poBilled = money((billsByPo.get(String(r.values.po)) ?? []).reduce((s, b) => s + (num(b.values.amount) ?? 0), 0));
        const difference = money(poBilled - poReceived);
        const terms = num(supplier?.values.paymentTermsDays);
        const date = str(r.values.date);
        const dueDate = date && terms !== null ? addDays(date, terms) : null;
        const state = billState(r);
        const paidAmount = paid.get(r.id) ?? 0;
        const open = state === 'Posted' ? money((num(r.values.amount) ?? 0) - paidAmount) : null;
        r.values.supplier = po?.values.supplier ?? null;
        r.values.dueDate = dueDate;
        r.values.poReceived = poReceived;
        r.values.poBilled = poBilled;
        r.values.difference = difference;
        r.values.match = Math.abs(difference) < 0.005 ? 'Matched' : difference > 0 ? 'Billed > received' : 'Billed < received';
        r.values.paid = state === 'Draft' ? null : paidAmount;
        r.values.open = open;
        r.values.status =
          state !== 'Posted'
            ? state
            : open! <= 0
              ? 'Paid'
              : dueDate && dueDate < now
                ? 'Overdue'
                : paidAmount > 0
                  ? 'Part paid'
                  : 'Unpaid';
      }
    },

    actions: {
      async post(store, id, user) {
        const bill = await getBill(store, id);
        const ctx = postingContext(user);
        const journal = await journalWriter(store, ctx);
        await commitOrConflict(store, await planBillPosting(store, bill, ctx, journal));
        return reloadBill(store, id);
      },

      /** Cancels a posted bill with the exact opposite entry. Its payments must be reversed first. */
      async reverse(store, id, user) {
        const bill = await getBill(store, id);
        const v = bill.values;
        if (billState(bill) !== 'Posted') throw new ActionError(409, `Only a posted bill can be reversed (bill ${v.billNo} is ${billState(bill).toLowerCase()})`);
        const paid = (await paidByBill(store, [id])).get(id) ?? 0;
        if (paid !== 0) throw new ActionError(409, `Bill ${v.billNo} has payments of ${eur(paid)}. Reverse them in Supplier payments first.`);
        const ctx = postingContext(user);
        const journal = await journalWriter(store, ctx);
        const reversalEntry = await journal.reverse(store, str(v.journalEntry), {
          date: today(),
          origin: 'Supplier bill',
          source: BILLS,
          sourceId: id,
        });
        const [po] = await store.getRows(POS, [String(v.po)]);
        const set: Record<string, CellValue> = { state: 'Reversed', reversalEntry };
        await commitOrConflict(store, {
          sheet: supplierBillsSheet,
          inserts: [],
          updates: [{ id, expectedVersion: bill.version, set, updatedAt: ctx.now }],
          deletes: [],
          audit: updateAudit(ctx, BILLS, bill, set),
          atomic: true,
          related: [...(po ? [touchPlan(purchaseOrdersSheet, [po], ctx.now)] : []), ...journal.plans()],
        });
        return reloadBill(store, id);
      },

      /** Records a payment for whatever is still open, through the normal payment rules. */
      async payInFull(store, id, user) {
        const bill = await getBill(store, id);
        const v = bill.values;
        if (billState(bill) !== 'Posted') throw new ActionError(409, `Bill ${v.billNo} must be posted before it can be paid`);
        const open = money((num(v.amount) ?? 0) - ((await paidByBill(store, [id])).get(id) ?? 0));
        if (open <= 0) throw new ActionError(409, `Bill ${v.billNo} is already paid`);
        const [po] = await store.getRows(POS, [String(v.po)]);
        const { runBatch } = await import('../batch.ts');
        const res = await runBatch(
          store,
          supplierPaymentsSheet,
          {
            inserts: [{ tempId: 'pay', values: { date: today(), supplier: po?.values.supplier ?? null, billNo: v.billNo ?? null, amount: open, reference: 'Paid in full' } }],
            updates: [],
            deletes: [],
          },
          user,
          { allOrNothing: true },
        );
        if (res.errors.length > 0) throw new ActionError(409, `Not paid: ${[...new Set(res.errors.map((e) => e.message))].join('; ')}`);
        return reloadBill(store, id);
      },
    },
  },

  supplierPayments: {
    /**
     * A payment must match a posted bill of that supplier and can't be more than what is open on it (checked row
     * by row, so two rows in one paste can't overpay together). Each posts Dr Accounts payable / Cr Bank.
     */
    async beforeInsert(store, inserts, ctx) {
      const errors: BatchError[] = [];
      const bills = await store.listWhere(BILLS, 'billNo');
      const pos = byId(await store.getRows(POS, ids(bills, 'po')));
      const billsByKey = groupBy(
        bills.map((b) => ({ ...b, values: { ...b.values, key: `${pos.get(String(b.values.po))?.values.supplier}|${uniqueKey(b.values.billNo ?? null)}` } })),
        'key',
      );
      const paid = await paidByBill(store, bills.map((b) => b.id));
      const taken = new Map<string, number>();
      const suppliers = byId(await store.getRows('suppliers', [...new Set(inserts.map((i) => String(i.values.supplier)))]));
      const accepted: { tempId: string; bill: Row }[] = [];

      for (const ins of inserts) {
        const v = ins.values;
        const err = (column: string, message: string) => errors.push({ op: 'insert', ref: ins.tempId, column, message });
        const amount = money(num(v.amount) ?? 0);
        if (amount <= 0) {
          err('amount', 'Must be more than 0');
          continue;
        }
        const code = suppliers.get(String(v.supplier))?.values.code ?? 'this supplier';
        const candidates = (billsByKey.get(`${v.supplier}|${uniqueKey(v.billNo ?? null)}`) ?? []).filter((b) => billState(b) !== 'Reversed');
        const bill = candidates.find((b) => billState(b) === 'Posted');
        if (!bill) {
          err('billNo', candidates.length > 0 ? `Bill ${v.billNo} is still a draft. Post it first.` : `No bill ${v.billNo} from ${code}`);
          continue;
        }
        const open = money((num(bill.values.amount) ?? 0) - (paid.get(bill.id) ?? 0) - (taken.get(bill.id) ?? 0));
        if (amount > open) {
          err('amount', open > 0 ? `Only ${eur(open)} is open on bill ${bill.values.billNo}` : `Bill ${bill.values.billNo} is already paid`);
          continue;
        }
        taken.set(bill.id, money((taken.get(bill.id) ?? 0) + amount));
        accepted.push({ tempId: ins.tempId, bill });
        Object.assign(v, { date: str(v.date) ?? today(), amount, bill: bill.id, reversalOf: null, reversedBy: null, journalEntry: null });
      }
      if (accepted.length === 0) return errors;

      const journal = await journalFor(store, ctx);
      for (const { tempId, bill } of accepted) {
        const v = inserts.find((i) => i.tempId === tempId)!.values;
        const amount = num(v.amount)!;
        v.journalEntry = journal.add({
          date: String(v.date),
          memo: [`Payment bill ${bill.values.billNo} · ${suppliers.get(String(v.supplier))?.values.code ?? ''}`, str(v.reference)].filter(Boolean).join(' · '),
          origin: 'Supplier payment',
          source: PAYMENTS,
          sourceTempId: tempId,
          lines: [
            { account: journal.account('payable'), debit: amount },
            { account: journal.account('bank'), credit: amount },
          ],
        });
      }
      // Two payments (or a payment and a bill reversal) at the same moment: the second one conflicts.
      touchInBatch(ctx, supplierBillsSheet, accepted.map((a) => a.bill));
      return errors;
    },

    async computed(_store, rows) {
      for (const r of rows) {
        r.values.status = str(r.values.reversedBy) ? 'Reversed' : str(r.values.reversalOf) ? 'Reversal' : 'Posted';
      }
    },

    actions: {
      /** Cancels a payment and its journal entry; the bill is open again. */
      async reverse(store, id, user) {
        const [original] = await store.getRows(PAYMENTS, [id]);
        if (!original) throw new ActionError(404, 'Payment not found');
        const o = original.values;
        if (str(o.reversedBy)) throw new ActionError(409, 'This payment is already reversed');
        if (str(o.reversalOf)) throw new ActionError(409, 'This is a reversal; enter a new payment instead');
        const [bill] = await store.getRows(BILLS, [String(o.bill)]);
        if (!bill) throw new ActionError(409, "This payment's bill is missing");

        const ctx = postingContext(user);
        const journal = await journalWriter(store, ctx);
        const reversal = newRow(ctx, {
          ...o,
          date: today(),
          amount: -(num(o.amount) ?? 0),
          reference: `Reversal${str(o.reference) ? `: ${o.reference}` : ''}`.slice(0, 80),
          reversalOf: original.id,
          reversedBy: null,
          journalEntry: null,
        });
        delete reversal.values.status;
        reversal.values.journalEntry = await journal.reverse(store, str(o.journalEntry), {
          date: String(reversal.values.date),
          origin: 'Supplier payment',
          source: PAYMENTS,
          sourceId: reversal.id,
        });
        await commitOrConflict(store, {
          sheet: supplierPaymentsSheet,
          inserts: [reversal],
          updates: [{ id, expectedVersion: original.version, set: { reversedBy: reversal.id }, updatedAt: ctx.now }],
          deletes: [],
          audit: [...insertAudit(ctx, PAYMENTS, reversal), ...updateAudit(ctx, PAYMENTS, original, { reversedBy: reversal.id })],
          atomic: true,
          related: [touchPlan(supplierBillsSheet, [bill], ctx.now), ...journal.plans()],
        });
        const updated: Row = { ...original, version: original.version + 1, updatedAt: ctx.now, values: { ...o, reversedBy: reversal.id } };
        return [updated, reversal];
      },
    },
  },
};
