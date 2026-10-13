import {
  CompactSelection,
  DataEditor,
  type EditableGridCell,
  type GridCell,
  GridCellKind,
  type GridColumn,
  type GridSelection,
  type Item,
  type ProvideEditorCallback,
  type ProvideEditorComponent,
  type TextCell,
  type Theme,
} from '@glideapps/glide-data-grid';
import { type ColumnDef, copyText, formatCell, isReadOnlyColumn, type SheetDef } from '@erp/schema';
import { useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  type KeyboardEvent as ReactKeyboardEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { api } from './api.ts';
import { type LookupOption, RefLookups } from './lookups.ts';
import { type CellStatus, type RowState, SheetModel } from './sheet-model.ts';
import { isMultiCell, parseTsv } from './tsv.ts';

/** The browser's locale for number formatting, falling back to en-US if it reports a tag Intl rejects. */
const locale = (() => {
  const wanted = typeof navigator === 'undefined' ? 'en-US' : navigator.language;
  try {
    return Intl.NumberFormat.supportedLocalesOf([wanted])[0] ?? 'en-US';
  } catch {
    return 'en-US';
  }
})();

const emptySelection: GridSelection = {
  columns: CompactSelection.empty(),
  rows: CompactSelection.empty(),
};

const MUTED = '#8a919c';

const cellTheme = (
  status: CellStatus | undefined,
  column: ColumnDef,
  value: unknown,
  locked: boolean,
): Partial<Theme> | undefined => {
  if (status?.state === 'error') return { bgCell: '#fdecec', textDark: '#b42318' };
  if (status?.state === 'conflict') return { bgCell: '#fff4e0' };
  if (status?.state === 'pending') return { bgCell: '#eef4ff' };
  // Values that ask for attention: low stock, a bill that doesn't match what was received.
  if (value === 'Reorder' || value === 'Billed > received' || value === 'Billed < received') {
    return { bgCell: '#fff4e0', textDark: '#b45309' };
  }
  if (isReadOnlyColumn(column) && !locked) return { bgCell: '#f6f7f9', textDark: '#6b7280' };
  return undefined;
};

const isNumeric = (c: ColumnDef) => c.type === 'number' || c.type === 'currency';

/** Sheets referenced by this sheet's columns, with the column people type to pick a row. */
const refTargets = (sheet: SheetDef) => {
  const seen = new Map<string, string>();
  for (const c of sheet.columns) if (c.ref) seen.set(c.ref.sheet, c.ref.display);
  return [...seen].map(([key, display]) => ({ key, display }));
};

function useSheetModel(sheet: SheetDef, lookups: RefLookups) {
  const queryClient = useQueryClient();
  const model = useMemo(
    () =>
      new SheetModel(sheet, api, {
        locale,
        refs: lookups,
        // Other sheets may show numbers that depend on this one (stock on hand, references): refresh them.
        // This sheet too when its computed columns span rows (it reloads once nothing is waiting to save).
        onSaved: () =>
          void queryClient.invalidateQueries({
            predicate: (q) => q.queryKey[0] === 'rows' && (q.queryKey[1] !== sheet.key || !!sheet.refreshAfterSave),
          }),
      }),
    [sheet, lookups, queryClient],
  );
  useEffect(() => {
    // Save anything still queued when leaving the sheet or closing the tab.
    const beforeUnload = (e: BeforeUnloadEvent) => {
      if (!model.hasUnsavedChanges) return;
      void model.flush();
      e.preventDefault();
    };
    window.addEventListener('beforeunload', beforeUnload);
    return () => {
      window.removeEventListener('beforeunload', beforeUnload);
      void model.flush();
    };
  }, [model]);
  const snapshot = useSyncExternalStore(model.subscribe, model.getSnapshot);
  return { model, snapshot };
}

/** Choices for the dropdown editor; read through a ref so the editor component keeps one identity. */
const editorOptions: { current: { id: string; options: LookupOption[] } } = { current: { id: 'list', options: [] } };

/**
 * Cell editor for enum and reference columns: a text box with the browser's own autocomplete list.
 * Typing still works as in any cell (and pasting SKUs works without it).
 */
const ListEditor: ProvideEditorComponent<TextCell> = ({ value, onChange, onFinishedEditing, initialValue }) => {
  const [text, setText] = useState(initialValue ?? value.data);
  const input = useRef<HTMLInputElement>(null);
  const { id, options } = editorOptions.current;
  useEffect(() => {
    if (initialValue !== undefined) onChange({ ...value, data: initialValue });
    const el = input.current;
    if (el) el.setSelectionRange(el.value.length, el.value.length);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const finish = (movement: readonly [-1 | 0 | 1, -1 | 0 | 1]) => {
    // Let the browser apply a highlighted choice from the list before reading the value.
    setTimeout(() => onFinishedEditing({ ...value, data: input.current?.value ?? text }, movement), 0);
  };
  return (
    <div className="list-editor">
      <input
        ref={input}
        autoFocus
        list={id}
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          onChange({ ...value, data: e.target.value });
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === 'Tab') {
            e.preventDefault();
            e.stopPropagation();
            finish(e.key === 'Enter' ? [0, 1] : [e.shiftKey ? -1 : 1, 0]);
          }
        }}
      />
      <datalist id={id}>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </datalist>
    </div>
  );
};

/** Splits a filter like "PO-00001, PO-00002" into lower-case terms; a row matches if any cell contains any term. */
const filterTerms = (q: string) => q.split(',').map((t) => t.trim().toLowerCase()).filter(Boolean);

export function SheetView({ sheet, initialQuery = '' }: { sheet: SheetDef; initialQuery?: string }) {
  const queryClient = useQueryClient();
  const lookups = useMemo(() => new RefLookups(), [sheet]);
  const targets = useMemo(() => refTargets(sheet), [sheet]);
  const refQueries = useQueries({
    queries: targets.map((t) => ({ queryKey: ['rows', t.key], queryFn: () => api.rows(t.key) })),
  });
  // Rebuild the lookups whenever a referenced sheet (re)loads; `lookupVersion` repaints the grid.
  const refData = refQueries.map((q) => q.data);
  const lookupVersion = useMemo(() => {
    targets.forEach((t, i) => {
      const data = refData[i];
      if (data) lookups.set(t.key, t.display, data.rows);
    });
    return refData.map((d) => (d ? d.rows.length : -1)).join(',') + Math.random();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lookups, targets, ...refData]);
  const refsReady = refQueries.every((q) => !q.isPending);

  const { model, snapshot } = useSheetModel(sheet, lookups);
  const rowsQuery = useQuery({ queryKey: ['rows', sheet.key], queryFn: () => api.rows(sheet.key) });
  const [selection, setSelection] = useState<GridSelection>(emptySelection);
  const [widths, setWidths] = useState<Record<string, number>>({});
  const [notice, setNotice] = useState<{ text: string; tone: 'info' | 'error' } | null>(null);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [query, setQuery] = useState(initialQuery);
  // Rows edited while a filter is on stay visible until the filter changes, so the cursor never jumps.
  const sticky = useRef(new Set<string>());
  useEffect(() => {
    setQuery(initialQuery);
    setSelection(emptySelection);
  }, [initialQuery]);
  useEffect(() => {
    sticky.current = new Set();
  }, [query]);
  const readOnlySheet = !!sheet.virtual;

  useEffect(() => {
    if (rowsQuery.data && !model.hasUnsavedChanges) model.load(rowsQuery.data.rows);
  }, [rowsQuery.data, model]);

  // Filtering: the grid shows `visible` (model row indices); new rows always stay visible. Grid rows past the
  // end map to new rows past the end of the model, so typing or pasting below a filtered list still adds rows.
  const visible = useMemo(() => {
    const terms = filterTerms(query);
    if (terms.length === 0) return null;
    const out: number[] = [];
    snapshot.rows.forEach((row, i) => {
      if (row.draft || sticky.current.has(row.key)) return out.push(i);
      const hit = model.columns.some((c) => {
        const text = formatCell(c, row.values[c.key] ?? null, locale, lookups).toLowerCase();
        return terms.some((t) => text.includes(t));
      });
      if (hit) out.push(i);
    });
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, snapshot, model, lookups, lookupVersion]);
  const toModel = useCallback(
    (viewRow: number) =>
      visible ? (viewRow < visible.length ? visible[viewRow]! : snapshot.rows.length + (viewRow - visible.length)) : viewRow,
    [visible, snapshot],
  );
  const viewRowCount = visible ? visible.length : snapshot.rows.length;
  const pin = useCallback(
    (modelRows: readonly number[]) => {
      if (!visible) return;
      for (const i of modelRows) {
        const key = snapshot.rows[i]?.key;
        if (key) sticky.current.add(key);
      }
    },
    [visible, snapshot],
  );
  const pasteBlock = useCallback(
    (startCol: number, startRow: number, block: readonly (readonly string[])[]) => {
      const edits = block.flatMap((line, r) =>
        line.flatMap((raw, c) => {
          const column = model.columns[startCol + c];
          return column ? [{ rowIndex: toModel(startRow + r), column: column.key, raw }] : [];
        }),
      );
      pin(edits.map((e) => e.rowIndex));
      model.editCells(edits);
    },
    [model, toModel, pin],
  );
  const pasteRef = useRef(pasteBlock);
  pasteRef.current = pasteBlock;

  // A cell editor is open (e.g. after clicking "Add a row") and Excel data is pasted: Glide would put the
  // whole block into that one cell. Send it to the grid instead, starting at the cell being edited.
  const selectionRef = useRef(selection);
  selectionRef.current = selection;
  useEffect(() => {
    if (readOnlySheet) return;
    const onPaste = (e: ClipboardEvent) => {
      const editor = e.target instanceof HTMLElement ? e.target.closest('#portal') : null;
      const text = e.clipboardData?.getData('text/plain') ?? '';
      const cell = selectionRef.current.current?.cell;
      if (!editor || !cell || !isMultiCell(text)) return;
      e.preventDefault();
      e.stopPropagation();
      (e.target as HTMLElement).dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      pasteRef.current(cell[0], cell[1], parseTsv(text));
    };
    document.addEventListener('paste', onPaste, true);
    return () => document.removeEventListener('paste', onPaste, true);
  }, [model, readOnlySheet]);

  const columns = useMemo<GridColumn[]>(
    () =>
      model.columns.map((c) => ({
        id: c.key,
        title: c.required ? `${c.label} *` : c.label,
        width: widths[c.key] ?? c.width ?? 150,
        themeOverride: isReadOnlyColumn(c) && !readOnlySheet ? { bgHeader: '#f1f2f5', textHeader: '#6b7280' } : undefined,
      })),
    [model, widths, readOnlySheet],
  );

  const getCellContent = useCallback(
    ([col, viewRow]: Item): GridCell => {
      const column = model.columns[col]!;
      const row = snapshot.rows[toModel(viewRow)];
      const status = row?.cells[column.key];
      const value = row?.values[column.key] ?? null;
      const locked = row ? model.blockedReason(row, column) !== null : isReadOnlyColumn(column);
      const shown = status?.state === 'error' ? status.raw : formatCell(column, value, locale, lookups);
      return {
        kind: GridCellKind.Text,
        data: status?.state === 'error' ? status.raw : copyText(column, value, locale, lookups),
        displayData: shown,
        allowOverlay: !locked,
        readonly: locked,
        contentAlign: isNumeric(column) ? 'right' : 'left',
        copyData: copyText(column, value, locale, lookups),
        themeOverride: cellTheme(status, column, value, !!row && model.isLocked(row)),
      };
    },
    // lookupVersion: repaint when a referenced sheet loads, so ids turn into SKUs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [model, snapshot, lookups, lookupVersion, toModel],
  );

  const provideEditor = useCallback<ProvideEditorCallback<GridCell>>(
    (cell) => {
      const col = selectionRef.current.current?.cell[0];
      const column = col === undefined ? undefined : model.columns[col];
      if (cell.kind !== GridCellKind.Text || !column) return undefined;
      if (column.type === 'enum') {
        editorOptions.current = { id: `list-${column.key}`, options: (column.options ?? []).map((o) => ({ value: o, label: '' })) };
      } else if (column.type === 'ref' && column.ref) {
        editorOptions.current = { id: `list-${column.key}`, options: lookups.options(column.ref.sheet) };
      } else {
        return undefined;
      }
      return ListEditor as ProvideEditorComponent<GridCell>;
    },
    [model, lookups],
  );

  const onCellsEdited = useCallback(
    (edits: readonly { location: Item; value: EditableGridCell }[]) => {
      const mapped = edits.map(({ location: [col, row], value }) => ({
        rowIndex: toModel(row),
        column: model.columns[col]!.key,
        raw: value.kind === GridCellKind.Text ? value.data : '',
      }));
      pin(mapped.map((e) => e.rowIndex));
      model.editCells(mapped);
      return true;
    },
    [model, toModel, pin],
  );

  const onPaste = useCallback(
    ([col, row]: Item, values: readonly (readonly string[])[]) => {
      pasteBlock(col, row, values);
      return false; // handled: the model parses, validates and adds rows past the end
    },
    [pasteBlock],
  );

  const deleteRows = useCallback(
    (viewRows: number[]) => {
      const skipped = model.deleteRows(viewRows.map(toModel));
      setSelection(emptySelection);
      setNotice(
        skipped.length > 0
          ? { text: `${skipped.length} row${skipped.length > 1 ? 's' : ''} not deleted: ${skipped[0]}`, tone: 'error' }
          : null,
      );
    },
    [model, toModel],
  );

  const onDelete = useCallback(
    (sel: GridSelection) => {
      if (sel.rows.length > 0) {
        deleteRows(sel.rows.toArray());
        return false;
      }
      return true; // clear the selected cells (arrives as edits)
    },
    [deleteRows],
  );

  const runAction = useCallback(
    async (action: { key: string; label: string }) => {
      const targets = selection.rows
        .toArray()
        .map((i) => snapshot.rows[toModel(i)])
        .filter((r): r is RowState => !!r?.id);
      if (targets.length === 0) return;
      setBusyAction(action.key);
      const failures: string[] = [];
      for (const row of targets) {
        try {
          const res = await api.action(sheet.key, row.id!, action.key);
          model.applyRows(res.rows);
        } catch (err) {
          failures.push(err instanceof Error ? err.message : String(err));
        }
      }
      setBusyAction(null);
      setSelection(emptySelection);
      const done = targets.length - failures.length;
      void queryClient.invalidateQueries({ predicate: (q) => q.queryKey[0] === 'rows' && q.queryKey[1] !== sheet.key });
      setNotice(
        failures.length > 0
          ? { text: `${action.label}: ${done} done, ${failures.length} failed. ${[...new Set(failures)].join(' ')}`, tone: 'error' }
          : { text: `${action.label}: ${done} row${done > 1 ? 's' : ''} done.`, tone: 'info' },
      );
    },
    [model, queryClient, selection, sheet, snapshot, toModel],
  );

  const onKeyDown = useCallback(
    (e: ReactKeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      const key = e.key.toLowerCase();
      if (key === 'z' && !e.shiftKey) {
        model.undo();
        e.preventDefault();
      } else if (key === 'y' || (key === 'z' && e.shiftKey)) {
        model.redo();
        e.preventDefault();
      }
    },
    [model],
  );

  const getRowThemeOverride = useCallback(
    (viewRow: number): Partial<Theme> | undefined => {
      const row = snapshot.rows[toModel(viewRow)];
      if (!row) return undefined;
      if (row.draft) return { bgCell: '#f7fbff' };
      if (row.values.reversedBy || row.values.reversalOf) return { textDark: MUTED };
      return undefined;
    },
    [snapshot, toModel],
  );

  const selectedRows = selection.rows.toArray();
  const selectedSaved = selectedRows.map((i) => snapshot.rows[toModel(i)]).filter((r): r is RowState => !!r?.id);
  const status = readOnlySheet ? { text: 'Calculated · read-only', tone: 'ok' as const } : statusText(snapshot);
  const hint = notice ?? selectionHint(model, snapshot.rows, selection, toModel);
  const drillDown = sheet.drillDown;
  const openDrillDown = () => {
    if (!drillDown) return;
    const values = selectedSaved.map((r) => String(r.values[drillDown.column] ?? '')).filter(Boolean);
    window.location.hash = `#/${drillDown.sheet}?q=${encodeURIComponent(values.join(', '))}`;
  };

  if (rowsQuery.isError) {
    return (
      <div className="sheet-error">
        <p>
          Could not load {sheet.label}: {rowsQuery.error.message}
        </p>
        <button onClick={() => rowsQuery.refetch()}>Try again</button>
      </div>
    );
  }

  return (
    <div className="sheet" onKeyDownCapture={onKeyDown} onMouseDown={() => notice && setNotice(null)}>
      <header className="sheet-header">
        <div>
          <h1>{sheet.label}</h1>
          {sheet.description && <p className="muted">{sheet.description}</p>}
        </div>
        <div className="toolbar">
          <span className={`status status-${status.tone}`} role="status">
            {status.text}
          </span>
          {snapshot.lastError && <button onClick={() => void model.flush()}>Retry</button>}
          <input
            className="filter"
            type="search"
            placeholder="Filter…"
            title="Show rows containing this text. Separate several with commas."
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setSelection(emptySelection);
            }}
          />
          {drillDown && (
            <button onClick={openDrillDown} disabled={selectedSaved.length === 0} title="Select rows by their number first">
              {drillDown.label}
            </button>
          )}
          {!readOnlySheet && (
            <>
              <button onClick={() => model.undo()} disabled={!snapshot.canUndo} title="Undo (Ctrl+Z)">
                Undo
              </button>
              <button onClick={() => model.redo()} disabled={!snapshot.canRedo} title="Redo (Ctrl+Y)">
                Redo
              </button>
              {sheet.actions?.map((a) => (
                <button
                  key={a.key}
                  title={`${a.description}. Select rows by their number first.`}
                  disabled={busyAction !== null || selectedSaved.length === 0}
                  onClick={() => void runAction(a)}
                >
                  {busyAction === a.key ? `${a.label}…` : a.label}
                </button>
              ))}
              <button onClick={() => deleteRows(selectedRows)} disabled={selectedRows.length === 0}>
                Delete {selectedRows.length > 1 ? `${selectedRows.length} rows` : 'row'}
              </button>
            </>
          )}
          <button
            onClick={() => rowsQuery.refetch()}
            disabled={rowsQuery.isFetching || model.hasUnsavedChanges}
            title={model.hasUnsavedChanges ? 'Wait for changes to save' : 'Reload from the server'}
          >
            Reload
          </button>
        </div>
      </header>

      <div className="grid-wrap">
        {rowsQuery.isPending || !refsReady ? (
          <p className="muted pad">Loading…</p>
        ) : (
          <DataEditor
            columns={columns}
            rows={viewRowCount}
            getCellContent={getCellContent}
            provideEditor={provideEditor}
            onCellsEdited={readOnlySheet ? undefined : onCellsEdited}
            onPaste={readOnlySheet ? false : onPaste}
            onDelete={readOnlySheet ? () => false : onDelete}
            getCellsForSelection={true}
            fillHandle={!readOnlySheet}
            rangeSelect="rect"
            columnSelect="none"
            rowSelect="multi"
            rowMarkers={readOnlySheet ? 'number' : 'both'}
            freezeColumns={1}
            smoothScrollX
            smoothScrollY
            gridSelection={selection}
            onGridSelectionChange={setSelection}
            getRowThemeOverride={getRowThemeOverride}
            onColumnResize={(col, width) => setWidths((w) => ({ ...w, [String(col.id)]: width }))}
            trailingRowOptions={readOnlySheet ? undefined : { hint: 'Add a row…', sticky: true, tint: true }}
            onRowAppended={
              readOnlySheet
                ? undefined
                : () => {
                    model.appendRow();
                  }
            }
            width="100%"
            height="100%"
          />
        )}
      </div>

      <footer className="sheet-footer">
        <span className={hint.tone === 'error' ? 'hint-error' : 'muted'}>{hint.text}</span>
        <span className="muted">
          {visible ? `${visible.length.toLocaleString(locale)} of ` : ''}
          {snapshot.rows.length.toLocaleString(locale)} rows
          {readOnlySheet ? '' : ' · paste from Excel with Ctrl+V · Ctrl+Z to undo'}
        </span>
      </footer>
    </div>
  );
}

function statusText(s: ReturnType<SheetModel['getSnapshot']>): { text: string; tone: 'ok' | 'busy' | 'warn' | 'error' } {
  if (s.lastError) return { text: `Not saved: ${s.lastError}`, tone: 'error' };
  if (s.saving) return { text: 'Saving…', tone: 'busy' };
  if (s.errorCells > 0)
    return { text: s.errorCells === 1 ? '1 cell needs attention' : `${s.errorCells} cells need attention`, tone: 'warn' };
  if (s.incompleteRows > 0)
    return {
      text: s.incompleteRows === 1 ? '1 new row is incomplete' : `${s.incompleteRows} new rows are incomplete`,
      tone: 'warn',
    };
  if (s.unsaved > 0) return { text: 'Saving…', tone: 'busy' };
  return { text: 'All changes saved', tone: 'ok' };
}

function selectionHint(
  model: SheetModel,
  rows: readonly RowState[],
  selection: GridSelection,
  toModel: (viewRow: number) => number,
): { text: string; tone: 'info' | 'error' } {
  const { sheet } = model;
  const cell = selection.current?.cell;
  if (!cell) {
    if (selection.rows.length > 0) return { text: `${selection.rows.length} row(s) selected.`, tone: 'info' };
    return { text: sheet.virtual ? 'Calculated from stock movements.' : 'Select a cell to see details.', tone: 'info' };
  }
  const [col, viewRow] = cell;
  const row = rows[toModel(viewRow)];
  const column = model.columns[col];
  if (!row || !column) return { text: '', tone: 'info' };
  const status = row.cells[column.key];
  if (status?.state === 'error') return { text: `${column.label}: ${status.message}`, tone: 'error' };
  if (status?.state === 'conflict') return { text: `${column.label}: ${status.message}`, tone: 'error' };
  if (row.rowError) return { text: row.rowError, tone: 'error' };
  if (sheet.virtual) return { text: `${column.label} is calculated from stock movements.`, tone: 'info' };
  if (row.draft) {
    if (column.system) return { text: `${column.label} is filled in automatically when the row is saved.`, tone: 'info' };
    const missing = model.missingRequired(row).map((c) => c.label);
    if (missing.length > 0) return { text: `New row: fill ${missing.join(', ')} to save it.`, tone: 'info' };
    return { text: 'New row: saving…', tone: 'info' };
  }
  if (model.isLocked(row)) {
    if (row.values.reversedBy) return { text: 'This row was reversed.', tone: 'info' };
    if (row.values.reversalOf) return { text: 'This row reverses an earlier one.', tone: 'info' };
    return { text: 'Posted and locked. To cancel it, select the row by its number and click Reverse.', tone: 'info' };
  }
  if (column.computed || column.system) return { text: `${column.label} is calculated by the system and can't be edited.`, tone: 'info' };
  const blocked = model.blockedReason(row, column);
  if (blocked) return { text: blocked, tone: 'info' };
  if (column.type === 'ref') return { text: `${column.label}: type a ${column.ref?.display ?? 'value'} or pick from the list.`, tone: 'info' };
  return {
    text: `${column.label} · ${column.type}${column.required ? ' · required' : ''}${column.unique ? ' · unique' : ''}`,
    tone: 'info',
  };
}
