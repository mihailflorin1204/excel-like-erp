import { type AuditEntry, type Row, type RowsResponse, type SheetDef, uniqueColumns, uniqueKey } from '@erp/schema';
import { type CommitPlan, type CommitResult, ConflictError, DuplicateKeyError, type ListOptions, type SheetStore } from './store.ts';

const clone = <T>(v: T): T => structuredClone(v);

/** Keeps everything in process memory. Data is lost when the API stops. */
export class MemoryStore implements SheetStore {
  private tables = new Map<string, Map<string, Row>>();
  private sheetDefs = new Map<string, SheetDef>();
  private audit: AuditEntry[] = [];

  async init(sheets: readonly SheetDef[]): Promise<void> {
    for (const s of sheets) {
      this.sheetDefs.set(s.key, s);
      if (!this.tables.has(s.key)) this.tables.set(s.key, new Map());
    }
  }

  private table(sheet: string): Map<string, Row> {
    let t = this.tables.get(sheet);
    if (!t) {
      t = new Map();
      this.tables.set(sheet, t);
    }
    return t;
  }

  async listRows(sheet: string, { offset, limit }: ListOptions): Promise<RowsResponse> {
    const all = [...this.table(sheet).values()];
    return { rows: all.slice(offset, offset + limit).map(clone), total: all.length };
  }

  async getRows(sheet: string, ids: readonly string[]): Promise<Row[]> {
    const t = this.table(sheet);
    return ids.flatMap((id) => {
      const r = t.get(id);
      return r ? [clone(r)] : [];
    });
  }

  async findByUnique(sheet: string, column: string, keys: readonly string[]): Promise<Row[]> {
    const wanted = new Set(keys);
    return [...this.table(sheet).values()]
      .filter((r) => {
        const k = uniqueKey(r.values[column] ?? null);
        return k !== null && wanted.has(k);
      })
      .map(clone);
  }

  async commit(plan: CommitPlan): Promise<CommitResult> {
    // Work on copies so a failure leaves every table untouched, like a rolled-back transaction.
    const primary = this.stage(plan);
    if (plan.atomic && primary.conflictIds.length > 0) throw new ConflictError(primary.conflictIds);
    const related = (plan.related ?? []).map((p) => this.stage(p));
    const relatedConflicts = related.flatMap((r) => r.conflictIds);
    if (relatedConflicts.length > 0) throw new ConflictError(relatedConflicts);

    for (const staged of [primary, ...related]) this.tables.set(staged.plan.sheet.key, staged.next);
    for (const staged of [primary, ...related]) {
      const skipped = new Set(staged.conflictIds);
      this.audit.push(...staged.plan.audit.filter((a) => !skipped.has(a.rowId)).map(clone));
    }
    return { conflictIds: primary.conflictIds };
  }

  /** Applies a plan to a copy of its table and checks unique columns; nothing is saved yet. */
  private stage(plan: CommitPlan) {
    const next = new Map(this.table(plan.sheet.key));
    const conflictIds: string[] = [];

    for (const row of plan.inserts) next.set(row.id, clone(row));
    for (const u of plan.updates) {
      const cur = next.get(u.id);
      if (!cur || cur.version !== u.expectedVersion) {
        conflictIds.push(u.id);
        continue;
      }
      next.set(u.id, {
        ...cur,
        values: { ...cur.values, ...u.set },
        version: cur.version + 1,
        updatedAt: u.updatedAt,
      });
    }
    for (const d of plan.deletes) {
      const cur = next.get(d.id);
      if (!cur) continue;
      if (cur.version !== d.expectedVersion) {
        conflictIds.push(d.id);
        continue;
      }
      next.delete(d.id);
    }

    for (const column of uniqueColumns(plan.sheet)) {
      const seen = new Set<string>();
      for (const row of next.values()) {
        const k = uniqueKey(row.values[column.key] ?? null);
        if (k === null) continue;
        if (seen.has(k)) throw new DuplicateKeyError(plan.sheet.key, column.key);
        seen.add(k);
      }
    }
    return { plan, next, conflictIds };
  }

  async listWhere(sheet: string, column: string, values?: readonly string[]): Promise<Row[]> {
    const wanted = values ? new Set(values) : null;
    return [...this.table(sheet).values()]
      .filter((r) => !wanted || wanted.has(String(r.values[column] ?? '')))
      .map(clone);
  }

  async listAudit(sheet: string, rowId: string, limit: number): Promise<AuditEntry[]> {
    return this.audit
      .filter((a) => a.sheet === sheet && a.rowId === rowId)
      .slice(-limit)
      .reverse()
      .map(clone);
  }

  async isEmpty(sheet: string): Promise<boolean> {
    return this.table(sheet).size === 0;
  }

  async close(): Promise<void> {}
}
