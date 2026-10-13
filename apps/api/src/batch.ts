import { randomUUID } from 'node:crypto';
import type { CommitPlan, SheetStore } from '@erp/db';
import {
  type AuditEntry,
  type BatchError,
  type BatchResponse,
  type CellValue,
  deleteBlockedReason,
  editBlockedReason,
  type ParsedBatchRequest,
  type Row,
  type SheetDef,
  storedColumns,
  uniqueColumns,
  uniqueKey,
  validateValues,
} from '@erp/schema';
import { applyComputed, type HookContext, hooks } from './hooks.ts';
import { findReferences, resolveRefs } from './references.ts';

interface PendingUpdate {
  id: string;
  current: Row;
  set: Record<string, CellValue>;
}

interface PendingInsert {
  tempId: string;
  values: Record<string, CellValue>;
}

/**
 * Applies one grid batch. Invalid cells are rejected one by one and reported back; everything valid
 * in the batch is written in a single transaction together with its audit rows.
 */
export async function runBatch(
  store: SheetStore,
  sheet: SheetDef,
  req: ParsedBatchRequest,
  user: string,
  /** allOrNothing: save nothing if any row has an error (used by actions such as Receive all). */
  options: { allOrNothing?: boolean } = {},
): Promise<BatchResponse> {
  const now = new Date().toISOString();
  const batchId = randomUUID();
  const errors: BatchError[] = [];
  const conflicts: BatchResponse['conflicts'] = [];
  const alreadyGone: string[] = [];

  const ctx: HookContext = { user, now, batchId, related: [], batch: { updates: [], inserts: [], deletes: [] } };
  const ids = [...new Set([...req.updates.map((u) => u.id), ...req.deletes.map((d) => d.id)])];
  const existing = new Map((await store.getRows(sheet.key, ids)).map((r) => [r.id, r]));
  // Lock rules may depend on computed values (a PO line is locked once its order is sent).
  const withComputed = new Map(
    (await applyComputed(store, sheet.key, [...existing.values()].map((r) => structuredClone(r)))).map((r) => [r.id, r.values]),
  );
  const seen = new Set<string>();
  const once = (op: 'update' | 'delete', id: string): boolean => {
    if (seen.has(id)) {
      errors.push({ op, ref: id, message: 'Row appears more than once in this batch' });
      return false;
    }
    seen.add(id);
    return true;
  };

  // Deletes
  const deletes: { id: string; expectedVersion: number }[] = [];
  const deleting = new Set<string>();
  for (const d of req.deletes) {
    if (!once('delete', d.id)) continue;
    const current = existing.get(d.id);
    if (!current) {
      alreadyGone.push(d.id);
      continue;
    }
    const blocked = deleteBlockedReason(sheet, withComputed.get(d.id) ?? current.values);
    if (blocked) {
      errors.push({ op: 'delete', ref: d.id, message: blocked });
      continue;
    }
    if (current.version !== d.version) {
      conflicts.push({ id: d.id, current });
      continue;
    }
    deletes.push({ id: d.id, expectedVersion: d.version });
    deleting.add(d.id);
  }
  // A row other sheets still point at (an item with stock movements) can't be deleted.
  const inUse = await findReferences(store, sheet.key, deletes.map((d) => d.id));
  for (const [id, usedIn] of inUse) {
    errors.push({ op: 'delete', ref: id, message: `Used in ${usedIn}, so it can't be deleted` });
    deleting.delete(id);
  }

  // Updates: keep valid cells, report invalid ones, drop cells that didn't change.
  const updates: PendingUpdate[] = [];
  for (const u of req.updates) {
    if (!once('update', u.id)) continue;
    const current = existing.get(u.id);
    if (!current || current.version !== u.version) {
      conflicts.push({ id: u.id, current: current ?? null });
      continue;
    }
    const result = validateValues(sheet, u.set, 'update');
    for (const e of result.errors) errors.push({ op: 'update', ref: u.id, column: e.column, message: e.message });
    const set: Record<string, CellValue> = {};
    for (const [k, v] of Object.entries(result.values)) {
      if ((current.values[k] ?? null) === v) continue;
      const blocked = editBlockedReason(sheet, withComputed.get(u.id) ?? current.values, sheet.columns.find((c) => c.key === k)!);
      if (blocked) errors.push({ op: 'update', ref: u.id, column: k, message: blocked });
      else set[k] = v;
    }
    updates.push({ id: u.id, current, set });
  }

  // Inserts: a new row is all-or-nothing.
  let inserts: PendingInsert[] = [];
  for (const ins of req.inserts) {
    const result = validateValues(sheet, ins.values, 'insert');
    if (result.errors.length > 0) {
      for (const e of result.errors) errors.push({ op: 'insert', ref: ins.tempId, column: e.column, message: e.message });
      continue;
    }
    inserts.push({ tempId: ins.tempId, values: result.values });
  }

  // References: "BOLT-M8" typed in an Item column becomes that item's id.
  const unresolved = await resolveRefs(
    store,
    sheet,
    [
      ...inserts.map((i) => ({ kind: 'insert' as const, ref: i.tempId, values: i.values })),
      ...updates.map((u) => ({ kind: 'update' as const, ref: u.id, values: u.set })),
    ],
    errors,
  );
  inserts = inserts.filter((i) => !unresolved.has(i.tempId));
  for (const u of updates) {
    for (const [k, v] of Object.entries(u.set)) if ((u.current.values[k] ?? null) === v) delete u.set[k];
  }


  // Unique columns: check against the database and within the batch. Edits to existing rows win over new rows.
  for (const column of uniqueColumns(sheet)) {
    const claims: { kind: 'update' | 'insert'; ref: string; key: string; raw: CellValue }[] = [];
    for (const u of updates) {
      const raw = u.set[column.key];
      const key = column.key in u.set ? uniqueKey(raw ?? null) : null;
      if (key !== null) claims.push({ kind: 'update', ref: u.id, key, raw: raw ?? null });
    }
    for (const i of inserts) {
      const raw = i.values[column.key] ?? null;
      const key = uniqueKey(raw);
      if (key !== null) claims.push({ kind: 'insert', ref: i.tempId, key, raw });
    }
    if (claims.length === 0) continue;

    // Rows being deleted, or whose value for this column changes in this batch, give up their current value.
    const releasing = new Set([...deleting, ...updates.filter((u) => column.key in u.set).map((u) => u.id)]);
    const owners = new Map<string, { ref: string; fromDb: boolean }>();
    const dbRows = await store.findByUnique(sheet.key, column.key, [...new Set(claims.map((c) => c.key))]);
    for (const r of dbRows) {
      const key = uniqueKey(r.values[column.key] ?? null);
      if (key !== null && !releasing.has(r.id)) owners.set(key, { ref: r.id, fromDb: true });
    }

    const rejectedInserts = new Set<string>();
    for (const claim of claims) {
      const owner = owners.get(claim.key);
      if (!owner || owner.ref === claim.ref) {
        owners.set(claim.key, { ref: claim.ref, fromDb: false });
        continue;
      }
      const message = owner.fromDb
        ? `${column.label} "${claim.raw}" is already used by another row`
        : `${column.label} "${claim.raw}" appears more than once in this paste`;
      errors.push({ op: claim.kind, ref: claim.ref, column: column.key, message });
      if (claim.kind === 'insert') rejectedInserts.add(claim.ref);
      else delete updates.find((u) => u.id === claim.ref)!.set[column.key];
    }
    inserts = inserts.filter((i) => !rejectedInserts.has(i.tempId));
  }

  // Module rules run last, on rows that passed every other check (e.g. stock movements: costing, no negative
  // stock). They may fill system columns and add writes to other sheets (ctx.related).
  let allowedDeletes = deletes.filter((d) => deleting.has(d.id));
  ctx.batch = {
    updates: updates.filter((u) => Object.keys(u.set).length > 0),
    inserts,
    deletes: allowedDeletes.map((d) => existing.get(d.id)!),
  };
  const beforeDelete = hooks[sheet.key]?.beforeDelete;
  if (beforeDelete && ctx.batch.deletes.length > 0) {
    const deleteErrors = await beforeDelete(store, ctx.batch.deletes, ctx);
    errors.push(...deleteErrors);
    const kept = new Set(deleteErrors.map((e) => e.ref));
    allowedDeletes = allowedDeletes.filter((d) => !kept.has(d.id));
    ctx.batch.deletes = ctx.batch.deletes.filter((r) => !kept.has(r.id));
  }
  const beforeUpdate = hooks[sheet.key]?.beforeUpdate;
  const pendingChanges = ctx.batch.updates;
  if (beforeUpdate && pendingChanges.length > 0) {
    for (const e of await beforeUpdate(store, pendingChanges, ctx)) {
      errors.push(e);
      const u = updates.find((x) => x.id === e.ref);
      if (!u) continue;
      if (e.column) delete u.set[e.column];
      else u.set = {};
    }
  }
  ctx.batch.updates = updates.filter((u) => Object.keys(u.set).length > 0);
  const beforeInsert = hooks[sheet.key]?.beforeInsert;
  if (beforeInsert && inserts.length > 0) {
    ctx.batch.inserts = inserts;
    const ruleErrors = await beforeInsert(store, inserts, ctx);
    errors.push(...ruleErrors);
    const failed = new Set(ruleErrors.map((e) => e.ref));
    inserts = inserts.filter((i) => !failed.has(i.tempId));
  }

  if (options.allOrNothing && errors.length + conflicts.length > 0) {
    return { inserted: [], updated: [], deleted: [], errors, conflicts };
  }

  // Build the commit.
  const audit: AuditEntry[] = [];
  const entry = (rowId: string, op: AuditEntry['op'], column: string | null, oldValue: CellValue, newValue: CellValue) =>
    audit.push({ id: randomUUID(), sheet: sheet.key, rowId, op, column, oldValue, newValue, user, batchId, at: now });

  const insertedRows = inserts.map((i) => {
    const values: Record<string, CellValue> = {};
    for (const c of storedColumns(sheet)) values[c.key] = i.values[c.key] ?? null;
    const row: Row = { id: randomUUID(), version: 1, values, createdAt: now, updatedAt: now };
    for (const [k, v] of Object.entries(values)) if (v !== null) entry(row.id, 'insert', k, null, v);
    return { tempId: i.tempId, row };
  });

  const changed = updates.filter((u) => Object.keys(u.set).length > 0);
  for (const u of changed) {
    for (const [k, v] of Object.entries(u.set)) entry(u.id, 'update', k, u.current.values[k] ?? null, v);
  }
  for (const d of allowedDeletes) {
    entry(d.id, 'delete', null, JSON.stringify(existing.get(d.id)?.values ?? {}), null);
  }

  const idsByTempId = new Map(insertedRows.map((i) => [i.tempId, i.row.id]));
  const related: CommitPlan[] = ctx.related.flatMap((r) => r(idsByTempId));
  const { conflictIds } = await store.commit({
    sheet,
    inserts: insertedRows.map((i) => i.row),
    updates: changed.map((u) => ({ id: u.id, expectedVersion: u.current.version, set: u.set, updatedAt: now })),
    deletes: allowedDeletes,
    audit,
    related,
  });

  // Rows that changed underneath us between the read and the write: report their latest copy.
  const lateConflicts = new Set(conflictIds);
  if (lateConflicts.size > 0) {
    const latest = new Map((await store.getRows(sheet.key, [...lateConflicts])).map((r) => [r.id, r]));
    for (const id of lateConflicts) conflicts.push({ id, current: latest.get(id) ?? null });
  }

  const updatedRows: Row[] = updates
    .filter((u) => !lateConflicts.has(u.id))
    .map((u) =>
      Object.keys(u.set).length === 0
        ? structuredClone(u.current)
        : { ...u.current, values: { ...u.current.values, ...u.set }, version: u.current.version + 1, updatedAt: now },
    );

  await applyComputed(store, sheet.key, [
    ...insertedRows.map((i) => i.row),
    ...updatedRows,
    ...conflicts.flatMap((c) => (c.current ? [c.current] : [])),
  ]);

  return {
    inserted: insertedRows,
    updated: updatedRows,
    deleted: [...allowedDeletes.filter((d) => !lateConflicts.has(d.id)).map((d) => d.id), ...alreadyGone],
    errors,
    conflicts,
  };
}
