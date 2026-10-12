import {
  CompactSelection,
  DataEditor,
  type EditableGridCell,
  type GridCell,
  GridCellKind,
  type GridColumn,
  type GridSelection,
  type Item,
  type Theme,
} from '@glideapps/glide-data-grid';
import { type ColumnDef, copyText, formatCell, type SheetDef } from '@erp/schema';
import { useQuery } from '@tanstack/react-query';
import { type KeyboardEvent as ReactKeyboardEvent, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { api } from './api.ts';
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

const cellTheme = (status: CellStatus | undefined, column: ColumnDef): Partial<Theme> | undefined => {
  if (status?.state === 'error') return { bgCell: '#fdecec', textDark: '#b42318' };
  if (status?.state === 'conflict') return { bgCell: '#fff4e0' };
  if (status?.state === 'pending') return { bgCell: '#eef4ff' };
  if (column.computed) return { bgCell: '#f6f7f9', textDark: '#6b7280' };
  return undefined;
};

const isNumeric = (c: ColumnDef) => c.type === 'number' || c.type === 'currency';

function useSheetModel(sheet: SheetDef) {
  const model = useMemo(() => new SheetModel(sheet, api, { locale }), [sheet]);
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

export function SheetView({ sheet }: { sheet: SheetDef }) {
  const { model, snapshot } = useSheetModel(sheet);
  const rowsQuery = useQuery({ queryKey: ['rows', sheet.key], queryFn: () => api.rows(sheet.key) });
  const [selection, setSelection] = useState<GridSelection>(emptySelection);
  const [widths, setWidths] = useState<Record<string, number>>({});

  useEffect(() => {
    if (rowsQuery.data && !model.hasUnsavedChanges) model.load(rowsQuery.data.rows);
  }, [rowsQuery.data, model]);

  // A cell editor is open (e.g. after clicking "Add a row") and Excel data is pasted: Glide would put the
  // whole block into that one cell. Send it to the grid instead, starting at the cell being edited.
  const selectionRef = useRef(selection);
  selectionRef.current = selection;
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const editor = e.target instanceof HTMLElement ? e.target.closest('#portal') : null;
      const text = e.clipboardData?.getData('text/plain') ?? '';
      const cell = selectionRef.current.current?.cell;
      if (!editor || !cell || !isMultiCell(text)) return;
      e.preventDefault();
      e.stopPropagation();
      (e.target as HTMLElement).dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      model.paste(cell[0], cell[1], parseTsv(text));
    };
    document.addEventListener('paste', onPaste, true);
    return () => document.removeEventListener('paste', onPaste, true);
  }, [model]);

  const columns = useMemo<GridColumn[]>(
    () =>
      sheet.columns.map((c) => ({
        id: c.key,
        title: c.required ? `${c.label} *` : c.label,
        width: widths[c.key] ?? c.width ?? 150,
        themeOverride: c.computed ? { bgHeader: '#f1f2f5', textHeader: '#6b7280' } : undefined,
      })),
    [sheet, widths],
  );

  const getCellContent = useCallback(
    ([col, rowIndex]: Item): GridCell => {
      const column = sheet.columns[col]!;
      const row = snapshot.rows[rowIndex];
      const status = row?.cells[column.key];
      const value = row?.values[column.key] ?? null;
      const shown = status?.state === 'error' ? status.raw : formatCell(column, value, locale);
      return {
        kind: GridCellKind.Text,
        data: status?.state === 'error' ? status.raw : copyText(column, value, locale),
        displayData: shown,
        allowOverlay: !column.computed,
        readonly: !!column.computed,
        contentAlign: isNumeric(column) ? 'right' : 'left',
        copyData: copyText(column, value, locale),
        themeOverride: cellTheme(status, column),
      };
    },
    [sheet, snapshot],
  );

  const onCellsEdited = useCallback(
    (edits: readonly { location: Item; value: EditableGridCell }[]) => {
      model.editCells(
        edits.map(({ location: [col, row], value }) => ({
          rowIndex: row,
          column: sheet.columns[col]!.key,
          raw: value.kind === GridCellKind.Text ? value.data : '',
        })),
      );
      return true;
    },
    [model, sheet],
  );

  const onPaste = useCallback(
    ([col, row]: Item, values: readonly (readonly string[])[]) => {
      model.paste(col, row, values);
      return false; // handled: the model parses, validates and adds rows past the end
    },
    [model],
  );

  const selectedRows = selection.rows.toArray();
  const deleteSelected = useCallback(() => {
    model.deleteRows(selection.rows.toArray());
    setSelection(emptySelection);
  }, [model, selection]);

  const onDelete = useCallback(
    (sel: GridSelection) => {
      if (sel.rows.length > 0) {
        model.deleteRows(sel.rows.toArray());
        setSelection(emptySelection);
        return false;
      }
      return true; // clear the selected cells (arrives as edits)
    },
    [model],
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
    (rowIndex: number): Partial<Theme> | undefined =>
      snapshot.rows[rowIndex]?.draft ? { bgCell: '#f7fbff' } : undefined,
    [snapshot],
  );

  const status = statusText(snapshot);
  const hint = selectionHint(model, sheet, snapshot.rows, selection);

  if (rowsQuery.isError) {
    return (
      <div className="sheet-error">
        <p>Could not load {sheet.label}: {rowsQuery.error.message}</p>
        <button onClick={() => rowsQuery.refetch()}>Try again</button>
      </div>
    );
  }

  return (
    <div className="sheet" onKeyDownCapture={onKeyDown}>
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
          <button onClick={() => model.undo()} disabled={!snapshot.canUndo} title="Undo (Ctrl+Z)">
            Undo
          </button>
          <button onClick={() => model.redo()} disabled={!snapshot.canRedo} title="Redo (Ctrl+Y)">
            Redo
          </button>
          <button onClick={deleteSelected} disabled={selectedRows.length === 0}>
            Delete {selectedRows.length > 1 ? `${selectedRows.length} rows` : 'row'}
          </button>
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
        {rowsQuery.isPending ? (
          <p className="muted pad">Loading…</p>
        ) : (
          <DataEditor
            columns={columns}
            rows={snapshot.rows.length}
            getCellContent={getCellContent}
            onCellsEdited={onCellsEdited}
            onPaste={onPaste}
            onDelete={onDelete}
            getCellsForSelection={true}
            fillHandle={true}
            rangeSelect="rect"
            columnSelect="none"
            rowSelect="multi"
            rowMarkers="both"
            freezeColumns={1}
            smoothScrollX
            smoothScrollY
            gridSelection={selection}
            onGridSelectionChange={setSelection}
            getRowThemeOverride={getRowThemeOverride}
            onColumnResize={(col, width) => setWidths((w) => ({ ...w, [String(col.id)]: width }))}
            trailingRowOptions={{ hint: 'Add a row…', sticky: true, tint: true }}
            onRowAppended={() => {
              model.appendRow();
            }}
            width="100%"
            height="100%"
          />
        )}
      </div>

      <footer className="sheet-footer">
        <span className={hint.tone === 'error' ? 'hint-error' : 'muted'}>{hint.text}</span>
        <span className="muted">
          {snapshot.rows.length.toLocaleString(locale)} rows · paste from Excel with Ctrl+V · Ctrl+Z to undo
        </span>
      </footer>
    </div>
  );
}

function statusText(s: ReturnType<SheetModel['getSnapshot']>): { text: string; tone: 'ok' | 'busy' | 'warn' | 'error' } {
  if (s.lastError) return { text: `Not saved: ${s.lastError}`, tone: 'error' };
  if (s.saving) return { text: 'Saving…', tone: 'busy' };
  if (s.errorCells > 0) return { text: s.errorCells === 1 ? '1 cell needs attention' : `${s.errorCells} cells need attention`, tone: 'warn' };
  if (s.incompleteRows > 0) return { text: s.incompleteRows === 1 ? '1 new row is incomplete' : `${s.incompleteRows} new rows are incomplete`, tone: 'warn' };
  if (s.unsaved > 0) return { text: 'Saving…', tone: 'busy' };
  return { text: 'All changes saved', tone: 'ok' };
}

function selectionHint(
  model: SheetModel,
  sheet: SheetDef,
  rows: readonly RowState[],
  selection: GridSelection,
): { text: string; tone: 'info' | 'error' } {
  const cell = selection.current?.cell;
  if (!cell) return { text: 'Select a cell to see details.', tone: 'info' };
  const [col, rowIndex] = cell;
  const row = rows[rowIndex];
  const column = sheet.columns[col];
  if (!row || !column) return { text: '', tone: 'info' };
  const status = row.cells[column.key];
  if (status?.state === 'error') return { text: `${column.label}: ${status.message}`, tone: 'error' };
  if (status?.state === 'conflict') return { text: `${column.label}: ${status.message}`, tone: 'error' };
  if (row.rowError) return { text: row.rowError, tone: 'error' };
  if (row.draft) {
    const missing = model.missingRequired(row).map((c) => c.label);
    return missing.length > 0
      ? { text: `New row: fill ${missing.join(', ')} to save it.`, tone: 'info' }
      : { text: 'New row: saving…', tone: 'info' };
  }
  if (column.computed) return { text: `${column.label} is calculated by the system and can't be edited.`, tone: 'info' };
  return { text: `${column.label} · ${column.type}${column.required ? ' · required' : ''}${column.unique ? ' · unique' : ''}`, tone: 'info' };
}
