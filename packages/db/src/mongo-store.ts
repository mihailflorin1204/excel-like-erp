import { type AuditEntry, type CellValue, type Row, type RowsResponse, type SheetDef, uniqueColumns, uniqueKey } from '@erp/schema';
import { type ClientSession, type Db, MongoClient, MongoServerError } from 'mongodb';
import { type CommitPlan, type CommitResult, ConflictError, DuplicateKeyError, type ListOptions, type SheetStore } from './store.ts';

/** How a row is stored. `_u` holds lower-cased copies of unique columns so the index is case-insensitive. */
interface RowDoc {
  _id: string;
  version: number;
  /** Insertion order, so pasted rows come back in the order they were pasted. */
  seq: number;
  values: Record<string, CellValue>;
  _u: Record<string, string | null>;
  createdAt: Date;
  updatedAt: Date;
}

interface AuditDoc extends Omit<AuditEntry, 'id' | 'at'> {
  _id: string;
  at: Date;
  /** Strictly increasing, so entries written in the same millisecond still sort in write order. */
  seq: number;
}

let lastSeq = 0;
/**
 * Strictly increasing ordering key: microsecond-scale clock, bumped if two calls land on the same tick.
 * Keeps pasted rows and audit entries in write order (single API process).
 */
const nextSeq = (): number => {
  lastSeq = Math.max(lastSeq + 1, Date.now() * 1000);
  return lastSeq;
};

const AUDIT = 'auditLog';

const toRow = (d: RowDoc): Row => ({
  id: d._id,
  version: d.version,
  values: d.values,
  createdAt: d.createdAt.toISOString(),
  updatedAt: d.updatedAt.toISOString(),
});

export class MongoStore implements SheetStore {
  private client: MongoClient;
  private db!: Db;
  private sheets = new Map<string, SheetDef>();

  constructor(private readonly url: string) {
    this.client = new MongoClient(url);
  }

  async init(sheets: readonly SheetDef[]): Promise<void> {
    await this.client.connect();
    this.db = this.client.db();
    for (const sheet of sheets) {
      this.sheets.set(sheet.key, sheet);
      if (sheet.virtual) continue; // calculated on read; nothing stored
      const col = this.db.collection<RowDoc>(sheet.key);
      await col.createIndex({ seq: 1 });
      // Reference columns are looked up constantly (e.g. all movements of an item), and so are a few others.
      for (const c of sheet.columns.filter((col) => (col.type === 'ref' || col.indexed) && !col.computed)) {
        await col.createIndex({ [`values.${c.key}`]: 1 });
      }
      for (const c of uniqueColumns(sheet)) {
        await col.createIndex(
          { [`_u.${c.key}`]: 1 },
          { unique: true, name: `unique_${c.key}`, partialFilterExpression: { [`_u.${c.key}`]: { $type: 'string' } } },
        );
      }
    }
    await this.db.collection<AuditDoc>(AUDIT).createIndex({ sheet: 1, rowId: 1, seq: -1 });
  }

  private col(sheet: string) {
    return this.db.collection<RowDoc>(sheet);
  }

  private uniques(sheet: string, values: Record<string, CellValue>): Record<string, string | null> {
    const def = this.sheets.get(sheet);
    const out: Record<string, string | null> = {};
    for (const c of def ? uniqueColumns(def) : []) {
      if (c.key in values) out[c.key] = uniqueKey(values[c.key] ?? null);
    }
    return out;
  }

  async listRows(sheet: string, { offset, limit }: ListOptions): Promise<RowsResponse> {
    const col = this.col(sheet);
    const [docs, total] = await Promise.all([
      col.find({}).sort({ seq: 1 }).skip(offset).limit(limit).toArray(),
      col.countDocuments(),
    ]);
    return { rows: docs.map(toRow), total };
  }

  async getRows(sheet: string, ids: readonly string[]): Promise<Row[]> {
    if (ids.length === 0) return [];
    const docs = await this.col(sheet).find({ _id: { $in: [...ids] } }).toArray();
    return docs.map(toRow);
  }

  async findByUnique(sheet: string, column: string, keys: readonly string[]): Promise<Row[]> {
    if (keys.length === 0) return [];
    const docs = await this.col(sheet).find({ [`_u.${column}`]: { $in: [...keys] } }).toArray();
    return docs.map(toRow);
  }

  async commit(plan: CommitPlan): Promise<CommitResult> {
    const session = this.client.startSession();
    let failedSheet = plan.sheet.key;
    try {
      let conflictIds: string[] = [];
      // withTransaction retries on transient errors, so everything inside must start from scratch.
      await session.withTransaction(async () => {
        failedSheet = plan.sheet.key;
        conflictIds = await this.write(plan, session);
        // Throwing inside withTransaction aborts it: none of the writes are kept.
        if (plan.atomic && conflictIds.length > 0) throw new ConflictError(conflictIds);
        for (const related of plan.related ?? []) {
          failedSheet = related.sheet.key;
          const relatedConflicts = await this.write(related, session);
          if (relatedConflicts.length > 0) throw new ConflictError(relatedConflicts);
        }
      });
      return { conflictIds };
    } catch (err) {
      if (err instanceof MongoServerError && err.code === 11000) {
        const pattern = (err as { keyPattern?: Record<string, unknown> }).keyPattern;
        const fromPattern = pattern ? Object.keys(pattern)[0]?.replace(/^_u\./, '') : undefined;
        throw new DuplicateKeyError(failedSheet, fromPattern ?? /unique_(\w+)/.exec(err.message)?.[1] ?? 'unknown');
      }
      throw err;
    } finally {
      await session.endSession();
    }
  }

  /** One sheet's writes inside a running transaction. Returns the ids whose version moved on. */
  private async write(plan: CommitPlan, session: ClientSession): Promise<string[]> {
    const sheet = plan.sheet.key;
    const col = this.col(sheet);
    const conflictIds: string[] = [];
    // Unique indexes are checked on every write, not at commit, so the order matters: first free up
    // values (deletes, then unique columns being changed), then claim them (updates, then inserts).
    // That way "delete A + insert A" or "swap two SKUs" in one batch never collides halfway through.
    for (const d of plan.deletes) {
      const res = await col.deleteOne({ _id: d.id, version: d.expectedVersion }, { session });
      if (res.deletedCount === 0 && (await col.countDocuments({ _id: d.id }, { session })) > 0) {
        conflictIds.push(d.id);
      }
    }

    for (const u of plan.updates) {
      const released = Object.keys(this.uniques(sheet, u.set));
      if (released.length === 0) continue;
      const $set = Object.fromEntries(released.map((k) => [`_u.${k}`, null]));
      await col.updateOne({ _id: u.id, version: u.expectedVersion }, { $set }, { session });
    }

    for (const u of plan.updates) {
      const $set: Record<string, unknown> = { updatedAt: new Date(u.updatedAt) };
      for (const [k, v] of Object.entries(u.set)) $set[`values.${k}`] = v;
      for (const [k, v] of Object.entries(this.uniques(sheet, u.set))) $set[`_u.${k}`] = v;
      const res = await col.updateOne({ _id: u.id, version: u.expectedVersion }, { $set, $inc: { version: 1 } }, { session });
      if (res.matchedCount === 0) conflictIds.push(u.id);
    }

    if (plan.inserts.length > 0) {
      await col.insertMany(
        plan.inserts.map((r) => ({
          _id: r.id,
          version: r.version,
          seq: nextSeq(),
          values: r.values,
          _u: this.uniques(sheet, r.values),
          createdAt: new Date(r.createdAt),
          updatedAt: new Date(r.updatedAt),
        })),
        { session },
      );
    }

    const skipped = new Set(conflictIds);
    const entries = plan.audit.filter((a) => !skipped.has(a.rowId));
    if (entries.length > 0) {
      await this.db.collection<AuditDoc>(AUDIT).insertMany(
        entries.map(({ id, at, ...rest }) => ({ _id: id, at: new Date(at), seq: nextSeq(), ...rest })),
        { session },
      );
    }
    return conflictIds;
  }

  async listWhere(sheet: string, column: string, values?: readonly string[]): Promise<Row[]> {
    if (values && values.length === 0) return [];
    const filter = values ? { [`values.${column}`]: { $in: [...values] } } : {};
    const docs = await this.col(sheet).find(filter).sort({ seq: 1 }).toArray();
    return docs.map(toRow);
  }

  async listWithout(sheet: string, column: string): Promise<Row[]> {
    const docs = await this.col(sheet).find({ [`values.${column}`]: { $exists: false } }).sort({ seq: 1 }).toArray();
    return docs.map(toRow);
  }

  async listAudit(sheet: string, rowId: string, limit: number): Promise<AuditEntry[]> {
    const docs = await this.db.collection<AuditDoc>(AUDIT).find({ sheet, rowId }).sort({ seq: -1 }).limit(limit).toArray();
    return docs.map(({ _id, at, seq: _seq, ...rest }) => ({ id: _id, at: at.toISOString(), ...rest }));
  }

  async isEmpty(sheet: string): Promise<boolean> {
    return (await this.col(sheet).estimatedDocumentCount()) === 0;
  }

  async close(): Promise<void> {
    await this.client.close();
  }
}
