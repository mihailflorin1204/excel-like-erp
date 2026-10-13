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
    // Work on a copy so a failed unique check leaves the table untouched, like a rolled-back transaction.
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

    if (plan.atomic && conflictIds.length > 0) throw new ConflictError(conflictIds);

    for (const column of uniqueColumns(plan.sheet)) {
      const seen = new Set<string>();
      for (const row of next.values()) {
        const k = uniqueKey(row.values[column.key] ?? null);
        if (k === null) continue;
        if (seen.has(k)) throw new DuplicateKeyError(plan.sheet.key, column.key);
        seen.add(k);
      }
    }

    this.tables.set(plan.sheet.key, next);
    const skipped = new Set(conflictIds);
    this.audit.push(...plan.audit.filter((a) => !skipped.has(a.rowId)).map(clone));
    return { conflictIds };
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
