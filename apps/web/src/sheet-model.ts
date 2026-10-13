import {
  type BatchRequest,
  type BatchResponse,
  type CellValue,
  type ColumnDef,
  copyText,
  editableColumns,
  deleteBlockedReason,
  editBlockedReason,
  isReadOnlyColumn,
  parseCellInput,
  type RefLookup,
  type Row,
  type SheetDef,
} from '@erp/schema';

export type CellStatus =
  | { state: 'pending' }
  | { state: 'error'; message: string; raw: string }
  | { state: 'conflict'; message: string };

export interface RowState {
  /** Stable client key: the server id, or a temp key for rows created in the grid. */
  key: string;
  id: string | null;
  version: number;
  values: Record<string, CellValue>;
  cells: Record<string, CellStatus | undefined>;
  /** Created in the grid and not saved yet. */
  draft: boolean;
  rowError?: string;
}

export interface CellEdit {
  rowIndex: number;
  column: string;
  raw: string;
}

export interface SheetSnapshot {
  rows: readonly RowState[];
  saving: boolean;
  /** Request-level failure (network, server error). Edits stay queued until the next save. */
  lastError: string | null;
  errorCells: number;
  incompleteRows: number;
  unsaved: number;
  canUndo: boolean;
  canRedo: boolean;
}

export interface BatchApi {
  batch(sheet: string, body: BatchRequest): Promise<BatchResponse>;
}

interface Change {
  rowKey: string;
  column: string;
  before: CellValue;
  after: CellValue;
}

/** One undo step: the cells it changed, plus rows it added past the end (a paste). */
interface UndoGroup {
  changes: Change[];
  createdKeys: string[];
  /** Filled in by undo: the removed rows, so redo can put them back. */
  removed?: { key: string; index: number; values: Record<string, CellValue>; cells: RowState['cells'] }[];
}

/** Today as YYYY-MM-DD in the user's own time zone. */
const localToday = (): string => new Date().toLocaleDateString('sv-SE');

/** Only the error states of a row's cells (pending/conflict markers don't survive an undo). */
const errorCells = (row: RowState): RowState['cells'] =>
  Object.fromEntries(Object.entries(row.cells).filter(([, c]) => c?.state === 'error'));

const CONFLICT_MESSAGE = 'Changed elsewhere since you loaded it; showing the latest value';

/**
 * Client-side state for one sheet: rows, per-cell save status, the autosave queue and undo/redo.
 * Plain TypeScript (no React) so it can be unit-tested; the grid subscribes to snapshots.
 *
 * One batch is in flight at a time. Edits made while it is in flight are queued for the next one,
 * and server responses never overwrite a cell the user has edited again in the meantime.
 */
export class SheetModel {
  private rows: RowState[] = [];
  private dirty = new Map<string, Set<string>>();
  private pendingDeletes: { id: string; version: number }[] = [];
  private deleteAfterSave = new Set<string>();
  private inflight: Map<string, Record<string, CellValue>> | null = null;
  private undoStack: UndoGroup[] = [];
  private redoStack: UndoGroup[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private listeners = new Set<() => void>();
  private snapshot!: SheetSnapshot;
  private lastError: string | null = null;
  private tempCounter = 0;
  private current: Promise<void> | null = null;

  /** Columns shown in the grid, in order (hidden bookkeeping columns left out). */
  readonly columns: readonly ColumnDef[];

  constructor(
    readonly sheet: SheetDef,
    private readonly api: BatchApi,
    private readonly options: {
      debounceMs?: number;
      locale?: string;
      /** Resolves typed SKUs / codes in reference columns. */
      refs?: RefLookup;
      /** Called after a batch saved something (e.g. to refresh other sheets that depend on this one). */
      onSaved?: () => void;
    } = {},
  ) {
    this.columns = sheet.columns.filter((c) => !c.hidden);
    this.publish();
  }

  /** Saved rows of a ledger, and every row of a report, can't be edited at all. */
  isLocked(row: RowState): boolean {
    return !!this.sheet.virtual || (!!this.sheet.appendOnly && !row.draft);
  }

  /** Why this cell can't be edited (same rules as the server), or null. New rows only block read-only columns. */
  blockedReason(row: RowState, column: ColumnDef): string | null {
    if (this.sheet.virtual) return 'This is a calculated report';
    if (row.draft) return isReadOnlyColumn(column) ? 'Filled in automatically' : null;
    return editBlockedReason(this.sheet, row.values, column);
  }

  // ---- subscription (useSyncExternalStore) ----

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  getSnapshot = (): SheetSnapshot => this.snapshot;

  private publish(): void {
    let errorCells = 0;
    let incompleteRows = 0;
    let unsaved = this.pendingDeletes.length;
    for (const r of this.rows) {
      for (const s of Object.values(r.cells)) if (s?.state === 'error') errorCells++;
      if (r.draft && !this.isEmpty(r)) {
        if (this.isComplete(r)) unsaved++;
        else incompleteRows++;
      }
    }
    for (const cols of this.dirty.values()) unsaved += cols.size;
    this.snapshot = {
      rows: [...this.rows],
      saving: this.inflight !== null,
      lastError: this.lastError,
      errorCells,
      incompleteRows,
      unsaved,
      canUndo: this.undoStack.length > 0,
      canRedo: this.redoStack.length > 0,
    };
    for (const fn of this.listeners) fn();
  }

  // ---- loading ----

  load(rows: readonly Row[]): void {
    this.rows = rows.map((r) => ({ key: r.id, id: r.id, version: r.version, values: { ...r.values }, cells: {}, draft: false }));
    this.dirty.clear();
    this.undoStack = [];
    this.redoStack = [];
    this.publish();
  }

  get hasUnsavedChanges(): boolean {
    return this.snapshot.unsaved > 0 || this.inflight !== null;
  }

  // ---- editing ----

  /** Typed edits, pastes, fill-handle drags and Delete-key clears all come through here. */
  editCells(edits: readonly CellEdit[]): void {
    const changes: Change[] = [];
    const rowCountBefore = this.rows.length;
    // A blank new row (e.g. from clicking "Add a row") that this edit fills counts as created by it.
    const blankDrafts = new Set(this.rows.filter((r) => r.draft && !r.id && this.isEmpty(r)).map((r) => r.key));
    const touched = new Set<string>();
    for (const edit of edits) {
      const column = this.column(edit.column);
      if (!column || isReadOnlyColumn(column) || this.sheet.virtual) continue;
      const existing = this.rows[edit.rowIndex];
      if (existing && this.blockedReason(existing, column)) continue;
      const row = this.rowAt(edit.rowIndex);
      touched.add(row.key);
      const parsed = parseCellInput(column, edit.raw, this.options.refs);
      if (!parsed.ok) {
        row.cells[column.key] = { state: 'error', message: parsed.error, raw: edit.raw };
        this.dirty.get(row.key)?.delete(column.key);
        continue;
      }
      const change = this.setValue(row, column, parsed.value);
      if (change) changes.push(change);
    }
    const createdKeys = this.rows
      .filter((r, i) => i >= rowCountBefore || (blankDrafts.has(r.key) && touched.has(r.key)))
      .map((r) => r.key);
    if (changes.length > 0 || createdKeys.length > 0) {
      this.undoStack.push({ changes, createdKeys });
      this.redoStack = [];
    }
    this.afterEdit();
  }

  /** Pastes a block of text cells (rows × columns) starting at a cell. Adds rows past the end. */
  paste(startColumn: number, startRow: number, block: readonly (readonly string[])[]): void {
    const edits: CellEdit[] = [];
    block.forEach((line, r) => {
      line.forEach((raw, c) => {
        const column = this.columns[startColumn + c];
        if (column) edits.push({ rowIndex: startRow + r, column: column.key, raw });
      });
    });
    this.editCells(edits);
  }

  appendRow(): number {
    this.rowAt(this.rows.length);
    this.publish();
    return this.rows.length - 1;
  }

  /** Deletes rows; rows that can't be deleted (posted, sent…) are skipped. Returns the reasons for those. */
  deleteRows(indices: readonly number[]): string[] {
    const targets = indices.map((i) => this.rows[i]).filter((r): r is RowState => !!r);
    const skipped: string[] = [];
    const allowed = targets.filter((r) => {
      const reason = r.draft ? null : deleteBlockedReason(this.sheet, r.values);
      if (reason) skipped.push(reason);
      return !reason;
    });
    this.removeRows(new Set(allowed.map((r) => r.key)));
    this.afterEdit();
    return skipped;
  }

  /** Merges rows the server changed or created outside a batch (e.g. by Reverse). */
  applyRows(rows: readonly Row[]): void {
    for (const server of rows) {
      const row = this.rows.find((r) => r.id === server.id);
      if (row) {
        row.version = server.version;
        row.values = { ...server.values };
        row.cells = {};
      } else {
        this.rows.push({ key: server.id, id: server.id, version: server.version, values: { ...server.values }, cells: {}, draft: false });
      }
    }
    this.publish();
  }

  private removeRows(keys: ReadonlySet<string>): void {
    for (const row of this.rows) {
      if (!keys.has(row.key)) continue;
      this.dirty.delete(row.key);
      if (row.id) this.pendingDeletes.push({ id: row.id, version: row.version });
      else if (this.inflight?.has(row.key)) this.deleteAfterSave.add(row.key);
    }
    this.rows = this.rows.filter((r) => !keys.has(r.key));
  }

  /** Reverts the last edit. Rows a paste added are removed again (and deleted on the server if already saved). */
  undo(): void {
    const group = this.undoStack.pop();
    if (!group) return;
    this.redoStack.push(group);
    const created = new Set(group.createdKeys);
    for (const ch of [...group.changes].reverse()) {
      if (!created.has(ch.rowKey)) this.applyChange(ch, 'before');
    }
    group.removed = this.rows.flatMap((r, index) => (created.has(r.key) ? [{ key: r.key, index, values: { ...r.values }, cells: errorCells(r) }] : []));
    this.removeRows(created);
    this.afterEdit();
  }

  redo(): void {
    const group = this.redoStack.pop();
    if (!group) return;
    this.undoStack.push(group);
    const oldCreated = new Set(group.createdKeys);
    for (const ch of group.changes) {
      if (!oldCreated.has(ch.rowKey)) this.applyChange(ch, 'after');
    }
    // Put removed rows back as new drafts; they are saved again like any new row.
    const rename = new Map<string, string>();
    for (const { key, index, values, cells } of group.removed ?? []) {
      const row: RowState = { key: `new-${++this.tempCounter}`, id: null, version: 0, values: { ...values }, cells: { ...cells }, draft: true };
      this.rows.splice(Math.min(index, this.rows.length), 0, row);
      rename.set(key, row.key);
    }
    // Later steps in the history may refer to these rows by their old keys.
    for (const g of [...this.undoStack, ...this.redoStack]) {
      g.createdKeys = g.createdKeys.map((k) => rename.get(k) ?? k);
      for (const ch of g.changes) ch.rowKey = rename.get(ch.rowKey) ?? ch.rowKey;
    }
    group.removed = undefined;
    this.afterEdit();
  }

  private applyChange(ch: Change, side: 'before' | 'after'): void {
    const row = this.rows.find((r) => r.key === ch.rowKey);
    const column = this.column(ch.column);
    if (row && column) this.setValue(row, column, ch[side]);
  }

  /** Writes one parsed value into a row; returns the change for the undo stack, if any. */
  private setValue(row: RowState, column: ColumnDef, value: CellValue): Change | null {
    if (value === null && column.required && !row.draft) {
      row.cells[column.key] = { state: 'error', message: 'Required', raw: '' };
      this.dirty.get(row.key)?.delete(column.key);
      return null;
    }
    const before = row.values[column.key] ?? null;
    const hadStatus = row.cells[column.key];
    row.cells[column.key] = undefined;
    row.rowError = undefined;
    if (before === value) {
      // Typing the old value back clears an error, but there is nothing new to save unless it was conflicted/pending.
      if (hadStatus?.state === 'pending') row.cells[column.key] = hadStatus;
      return null;
    }
    row.values[column.key] = value;
    if (!row.draft) {
      row.cells[column.key] = { state: 'pending' };
      this.markDirty(row.key, column.key);
    }
    return { rowKey: row.key, column: column.key, before, after: value };
  }

  private afterEdit(): void {
    this.publish();
    this.schedule();
  }

  // ---- saving ----

  private schedule(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, this.options.debounceMs ?? 400);
  }

  /** Sends everything queued. Resolves once the queue is empty or nothing more can be sent. */
  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    while (this.current) await this.current;
    const request = this.buildRequest();
    if (!request) return;
    this.current = this.send(request.body, request.sent).finally(() => {
      this.current = null;
    });
    await this.current;
    // Anything edited while that batch was in flight goes out next (but don't hammer a failing server).
    if (!this.lastError && this.buildRequest(true)) await this.flush();
  }

  private buildRequest(peek = false): { body: BatchRequest; sent: Map<string, Record<string, CellValue>> } | null {
    const sent = new Map<string, Record<string, CellValue>>();
    const updates: NonNullable<BatchRequest['updates']> = [];
    const inserts: NonNullable<BatchRequest['inserts']> = [];

    for (const row of this.rows) {
      if (row.id) {
        const cols = this.dirty.get(row.key);
        if (!cols || cols.size === 0) continue;
        const set = Object.fromEntries([...cols].map((c) => [c, row.values[c] ?? null]));
        updates.push({ id: row.id, version: row.version, set });
        sent.set(row.key, set);
      } else if (row.draft && this.isComplete(row)) {
        for (const c of this.sheet.columns) {
          if (c.defaultToday && (row.values[c.key] ?? null) === null) row.values[c.key] = localToday();
        }
        const values = Object.fromEntries(editableColumns(this.sheet).map((c) => [c.key, row.values[c.key] ?? null]));
        inserts.push({ tempId: row.key, values });
        sent.set(row.key, values);
      }
    }
    const deletes = [...this.pendingDeletes];
    if (updates.length + inserts.length + deletes.length === 0) return null;
    if (peek) return { body: {}, sent };

    this.pendingDeletes = [];
    for (const key of sent.keys()) this.dirty.delete(key);
    return { body: { updates, inserts, deletes }, sent };
  }

  private async send(body: BatchRequest, sent: Map<string, Record<string, CellValue>>): Promise<void> {
    this.inflight = sent;
    this.lastError = null;
    this.publish();
    try {
      const res = await this.api.batch(this.sheet.key, body);
      this.inflight = null;
      this.apply(res, sent);
      if (res.inserted.length + res.updated.length + res.deleted.length > 0) this.options.onSaved?.();
    } catch (err) {
      // Put everything back in the queue; the user can retry.
      this.inflight = null;
      this.pendingDeletes.unshift(...(body.deletes ?? []));
      for (const u of body.updates ?? []) {
        const row = this.rows.find((r) => r.id === u.id);
        if (row) for (const c of Object.keys(u.set)) this.markDirty(row.key, c);
      }
      this.lastError = err instanceof Error ? err.message : String(err);
      this.publish();
    }
  }

  private apply(res: BatchResponse, sent: Map<string, Record<string, CellValue>>): void {
    const byKey = new Map(this.rows.map((r) => [r.key, r]));
    const byId = new Map(this.rows.filter((r) => r.id).map((r) => [r.id!, r]));

    const merge = (row: RowState, server: Row, sentValues: Record<string, CellValue>) => {
      row.version = server.version;
      const edited = this.dirty.get(row.key) ?? new Set<string>();
      for (const [k, v] of Object.entries(server.values)) {
        if (edited.has(k)) continue;
        // A draft cell edited during the insert: keep the local value and send it as an update next.
        if (k in sentValues && (row.values[k] ?? null) !== (sentValues[k] ?? null)) {
          this.markDirty(row.key, k);
          row.cells[k] = { state: 'pending' };
          continue;
        }
        row.values[k] = v;
        if (row.cells[k]?.state === 'pending') row.cells[k] = undefined;
      }
    };

    for (const { tempId, row: server } of res.inserted) {
      const row = byKey.get(tempId);
      if (this.deleteAfterSave.delete(tempId) || !row) {
        this.pendingDeletes.push({ id: server.id, version: server.version });
        continue;
      }
      row.id = server.id;
      row.draft = false;
      byId.set(server.id, row);
      merge(row, server, sent.get(tempId) ?? {});
    }

    for (const server of res.updated) {
      const row = byId.get(server.id);
      if (row) merge(row, server, sent.get(row.key) ?? {});
    }

    for (const e of res.errors) {
      const row = e.op === 'insert' ? byKey.get(e.ref) : byId.get(e.ref);
      if (!row) continue;
      if (!e.column) {
        row.rowError = e.message;
        continue;
      }
      const column = this.column(e.column);
      const value = sent.get(row.key)?.[e.column] ?? row.values[e.column] ?? null;
      row.cells[e.column] = {
        state: 'error',
        message: e.message,
        raw: column ? copyText(column, value, this.options.locale, this.options.refs) : String(value ?? ''),
      };
    }

    for (const { id, current } of res.conflicts) {
      const row = byId.get(id);
      if (!row) continue;
      if (!current) {
        this.rows = this.rows.filter((r) => r !== row);
        continue;
      }
      row.version = current.version;
      row.values = { ...current.values };
      this.dirty.delete(row.key);
      for (const k of Object.keys(sent.get(row.key) ?? {})) row.cells[k] = { state: 'conflict', message: CONFLICT_MESSAGE };
    }

    this.publish();
  }

  // ---- helpers ----

  private column(key: string): ColumnDef | undefined {
    return this.sheet.columns.find((c) => c.key === key);
  }

  private rowAt(index: number): RowState {
    while (this.rows.length <= index) {
      this.rows.push({ key: `new-${++this.tempCounter}`, id: null, version: 0, values: {}, cells: {}, draft: true });
    }
    return this.rows[index]!;
  }

  private markDirty(rowKey: string, column: string): void {
    let cols = this.dirty.get(rowKey);
    if (!cols) this.dirty.set(rowKey, (cols = new Set()));
    cols.add(column);
  }

  private isEmpty(row: RowState): boolean {
    return Object.values(row.values).every((v) => v === null || v === undefined);
  }

  /**
   * A new row is saved once something is typed in it, every required cell has a value and no cell shows an
   * error. (A blank row from "Add a row" is never saved, even on a sheet with no required columns.)
   */
  isComplete(row: RowState): boolean {
    if (row.rowError || this.isEmpty(row)) return false;
    if (Object.values(row.cells).some((s) => s?.state === 'error')) return false;
    return this.missingRequired(row).length === 0;
  }

  /** What a new row still needs before it can be saved, e.g. ["Item", "Debit or Credit"]. */
  missingRequired(row: RowState): string[] {
    const has = (key: string) => (row.values[key] ?? null) !== null;
    return [
      ...this.sheet.columns.filter((c) => c.required && !isReadOnlyColumn(c) && !has(c.key)).map((c) => c.label),
      ...(this.sheet.requireOneOf ?? [])
        .filter((group) => !group.some(has))
        .map((group) => group.map((k) => this.column(k)?.label ?? k).join(' or ')),
    ];
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    this.listeners.clear();
  }
}
