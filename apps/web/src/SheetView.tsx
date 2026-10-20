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
import { type ColumnDef, copyText, formatCell, isReadOnlyColumn, type SavedView, type SheetDef, type ViewConfig } from '@erp/schema';
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
import { ViewBar } from './ViewBar.tsx';
import {
  computeFormulas,
  DEFAULT_VIEW,
  type FormulaResult,
  formatResult,
  type ShownColumn,
  shownColumns,
  type SortValue,
  sortIndices,
} from './view-logic.ts';

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

const ATTENTION = new Set(['Reorder', 'Billed > received', 'Billed < received', 'Overdue', 'Draft · unbalanced', 'Out of balance']);

const cellTheme = (
  status: CellStatus | undefined,
  column: ColumnDef,
  value: unknown,
  locked: boolean,
): Partial<Theme> | undefined => {
  if (status?.state === 'error') return { bgCell: '#fdecec', textDark: '#b42318' };
  if (status?.state === 'conflict') return { bgCell: '#fff4e0' };
  if (status?.state === 'pending') return { bgCell: '#eef4ff' };
  // Values that ask for attention: low stock, a bill that doesn't match what was received or is overdue,
  // an entry or a trial balance that doesn't balance.
  if (typeof value === 'string' && ATTENTION.has(value)) {
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
  // Report inputs such as a trial balance's From / To dates; part of the query key, so changing one reloads.
  const [params, setParams] = useState<Record<string, string>>({});
  const rowsQuery = useQuery({ queryKey: ['rows', sheet.key, params], queryFn: () => api.rows(sheet.key, params) });
  const [selection, setSelection] = useState<GridSelection>(emptySelection);
  const [widths, setWidths] = useState<Record<string, number>>({});
  // A notice from an action. `keep`: stays until closed (e.g. a temporary password to copy).
  const [notice, setNotice] = useState<{ text: string; tone: 'info' | 'error'; keep?: boolean } | null>(null);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  // The grid's view: filter, sort, hidden and frozen columns, formula columns. A saved view fills it in.
  const [config, setConfig] = useState<ViewConfig>({ ...DEFAULT_VIEW, query: initialQuery });
  const [activeView, setActiveView] = useState<SavedView | null>(null);
  const query = config.query;
  const setQuery = (q: string) => setConfig((c) => ({ ...c, query: q }));
  useEffect(() => {
    if (initialQuery) {
      setActiveView(null);
      setConfig({ ...DEFAULT_VIEW, query: initialQuery });
    }
    setSelection(emptySelection);
  }, [initialQuery]);
  const shown = useMemo(() => shownColumns(model.columns, config), [model, config]);

  // Formula columns are calculated in the browser (HyperFormula, loaded on first use) and never saved. Results
  // are kept per row key, so they never show against the wrong row; recalculation waits for a pause in editing.
  const [formulas, setFormulas] = useState<{ byRow: Map<string, Map<string, FormulaResult>>; forConfig: string }>({ byRow: new Map(), forConfig: '' });
  const formulasConfig = JSON.stringify(config.formulas);
  const lastFormulasConfig = useRef('');
  useEffect(() => {
    if (config.formulas.length === 0) {
      setFormulas({ byRow: new Map(), forConfig: formulasConfig });
      lastFormulasConfig.current = formulasConfig;
      return;
    }
    let cancelled = false;
    const rows = snapshot.rows;
    // Right away when the formulas change; after a short pause when only the data changed.
    const delay = lastFormulasConfig.current === formulasConfig ? 400 : 0;
    const timer = setTimeout(() => {
      void computeFormulas(model.columns, rows.map((r) => r.values), config.formulas, locale, lookups).then(
        (values) => {
          if (cancelled) return;
          const byRow = new Map<string, Map<string, FormulaResult>>();
          for (const [key, list] of values) byRow.set(key, new Map(rows.map((r, i) => [r.key, list[i] ?? null])));
          lastFormulasConfig.current = formulasConfig;
          setFormulas({ byRow, forConfig: formulasConfig });
        },
        (err: unknown) => !cancelled && setNotice({ text: `Formulas: ${err instanceof Error ? err.message : String(err)}`, tone: 'error' }),
      );
    }, delay);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [formulasConfig, snapshot, model, lookups, lookupVersion]);
  const formulaValue = useCallback(
    (key: string, rowIndex: number): FormulaResult => {
      const rowKey = snapshot.rows[rowIndex]?.key;
      return (rowKey ? formulas.byRow.get(key)?.get(rowKey) : null) ?? null;
    },
    [formulas, snapshot],
  );
  const formulaText = useCallback((key: string, rowIndex: number) => formatResult(formulaValue(key, rowIndex), locale), [formulaValue]);
  const readOnlySheet = !!sheet.virtual;

  // Re-sort/re-filter on the first load and when Reload is clicked, not on the automatic refreshes after saves.
  const [loadVersion, setLoadVersion] = useState(0);
  const resortOnLoad = useRef(true);
  useEffect(() => {
    if (rowsQuery.data && !model.hasUnsavedChanges) {
      model.load(rowsQuery.data.rows);
      if (resortOnLoad.current) {
        resortOnLoad.current = false;
        setLoadVersion((v) => v + 1);
      }
    }
  }, [rowsQuery.data, model]);

  // Filtering: the grid shows `visible` (model row indices); new rows always stay visible. Grid rows past the
  // end map to new rows past the end of the model, so typing or pasting below a filtered list still adds rows.
  // Filtering and sorting decide the order of rows once: when the filter, sort or formulas change, or the sheet
  // reloads. Editing never moves a row (the cursor stays on the record being edited), and new rows stay at the
  // bottom until the next re-sort.
  const snapshotRef = useRef(snapshot);
  snapshotRef.current = snapshot;
  const sortByFormula = !!config.sort && !model.columns.some((c) => c.key === config.sort!.column);
  const frozenOrder = useMemo((): string[] | null => {
    const rows = snapshotRef.current.rows;
    const terms = filterTerms(query);
    const sort = config.sort;
    if (terms.length === 0 && !sort) return null;
    const saved: number[] = [];
    rows.forEach((row, i) => {
      if (row.draft) return;
      const hit =
        terms.length === 0 ||
        model.columns.some((c) => {
          const text = formatCell(c, row.values[c.key] ?? null, locale, lookups).toLowerCase();
          return terms.some((t) => text.includes(t));
        }) ||
        config.formulas.some((f) => terms.some((t) => formulaText(f.key, i).toLowerCase().includes(t)));
      if (hit) saved.push(i);
    });
    let ordered = saved;
    if (sort) {
      const column = model.columns.find((c) => c.key === sort.column);
      const key = (i: number): SortValue => {
        if (!column) {
          const v = formulaValue(sort.column, i);
          return typeof v === 'boolean' ? String(v) : v;
        }
        const v = rows[i]!.values[column.key] ?? null;
        return typeof v === 'number' ? v : v === null ? null : formatCell(column, v, locale, lookups);
      };
      ordered = sortIndices(saved, key, sort.dir);
    }
    return ordered.map((i) => rows[i]!.key);
    // Deliberately not on every edit (snapshot): see above. Formula results count only when the formulas change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, config.sort, formulasConfig, model, loadVersion, lookupVersion, sortByFormula ? formulas.forConfig : null]);
  const visible = useMemo(() => {
    if (!frozenOrder) return null;
    const indexOf = new Map(snapshot.rows.map((r, i) => [r.key, i]));
    const listed = new Set(frozenOrder);
    const out = frozenOrder.flatMap((k) => (indexOf.has(k) ? [indexOf.get(k)!] : []));
    // Rows added since (new rows, rows from another sheet's save) follow, in sheet order.
    snapshot.rows.forEach((r, i) => {
      if (!listed.has(r.key)) out.push(i);
    });
    return out;
  }, [frozenOrder, snapshot]);
  const toModel = useCallback(
    (viewRow: number) =>
      visible ? (viewRow < visible.length ? visible[viewRow]! : snapshot.rows.length + (viewRow - visible.length)) : viewRow,
    [visible, snapshot],
  );
  const viewRowCount = visible ? visible.length : snapshot.rows.length;
  const pasteBlock = useCallback(
    (startCol: number, startRow: number, block: readonly (readonly string[])[]) => {
      // Pasted columns land on the columns as shown (hidden ones skipped); formula columns take nothing.
      const edits = block.flatMap((line, r) =>
        line.flatMap((raw, c) => {
          const target = shown[startCol + c];
          return target?.kind === 'data' ? [{ rowIndex: toModel(startRow + r), column: target.column.key, raw }] : [];
        }),
      );
      model.editCells(edits);
    },
    [model, toModel, shown],
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
      shown.map(({ kind, column: c }) => {
        const arrow = config.sort?.column === c.key ? (config.sort.dir === 'asc' ? ' ▲' : ' ▼') : '';
        const title = kind === 'formula' ? `ƒ ${c.label}` : c.required ? `${c.label} *` : c.label;
        return {
          id: c.key,
          title: title + arrow,
          width: widths[c.key] ?? c.width ?? 150,
          themeOverride:
            kind === 'formula'
              ? { bgHeader: '#f3f0ff', textHeader: '#5b21b6' }
              : isReadOnlyColumn(c) && !readOnlySheet
                ? { bgHeader: '#f1f2f5', textHeader: '#6b7280' }
                : undefined,
        };
      }),
    [shown, widths, readOnlySheet, config.sort],
  );

  const getCellContent = useCallback(
    ([col, viewRow]: Item): GridCell => {
      const target = shown[col]!;
      const column = target.column;
      if (target.kind === 'formula') {
        const rowIndex = toModel(viewRow);
        const text = snapshot.rows[rowIndex] ? formulaText(column.key, rowIndex) : '';
        const value = snapshot.rows[rowIndex] ? formulaValue(column.key, rowIndex) : null;
        return {
          kind: GridCellKind.Text,
          data: text,
          displayData: text,
          allowOverlay: false,
          readonly: true,
          contentAlign: typeof value === 'number' ? 'right' : 'left',
          copyData: typeof value === 'number' ? String(value) : text,
          themeOverride: { bgCell: '#faf8ff', textDark: '#4c1d95' },
        };
      }
      const row = snapshot.rows[toModel(viewRow)];
      const status = row?.cells[column.key];
      const value = row?.values[column.key] ?? null;
      const locked = row ? model.blockedReason(row, column) !== null : isReadOnlyColumn(column);
      const display = status?.state === 'error' ? status.raw : formatCell(column, value, locale, lookups);
      return {
        kind: GridCellKind.Text,
        data: status?.state === 'error' ? status.raw : copyText(column, value, locale, lookups),
        displayData: display,
        allowOverlay: !locked,
        readonly: locked,
        contentAlign: isNumeric(column) ? 'right' : 'left',
        copyData: copyText(column, value, locale, lookups),
        themeOverride: cellTheme(status, column, value, !!row && model.isLocked(row)),
      };
    },
    // lookupVersion: repaint when a referenced sheet loads, so ids turn into SKUs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [model, snapshot, lookups, lookupVersion, toModel, shown, formulaText, formulaValue],
  );

  const provideEditor = useCallback<ProvideEditorCallback<GridCell>>(
    (cell) => {
      const col = selectionRef.current.current?.cell[0];
      const target = col === undefined ? undefined : shown[col];
      const column = target?.kind === 'data' ? target.column : undefined;
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
    [lookups, shown],
  );

  const onCellsEdited = useCallback(
    (edits: readonly { location: Item; value: EditableGridCell }[]) => {
      const mapped = edits.flatMap(({ location: [col, row], value }) => {
        const target = shown[col];
        if (target?.kind !== 'data') return [];
        return [{ rowIndex: toModel(row), column: target.column.key, raw: value.kind === GridCellKind.Text ? value.data : '' }];
      });
      model.editCells(mapped);
      return true;
    },
    [model, toModel, shown],
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
      const messages: string[] = [];
      for (const row of targets) {
        try {
          const res = await api.action(sheet.key, row.id!, action.key);
          model.applyRows(res.rows);
          if (res.message) messages.push(res.message);
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
          : messages.length > 0
            ? { text: messages.join(' '), tone: 'info', keep: true }
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
      if (row.id === 'total' || row.id?.startsWith('total-')) return { bgCell: '#f1f2f5', baseFontStyle: '600 13px' };
      if (row.values.reversedBy || row.values.reversalOf) return { textDark: MUTED };
      return undefined;
    },
    [snapshot, toModel],
  );

  const selectedRows = selection.rows.toArray();
  const selectedSaved = selectedRows.map((i) => snapshot.rows[toModel(i)]).filter((r): r is RowState => !!r?.id);
  const status = readOnlySheet ? { text: 'Calculated · read-only', tone: 'ok' as const } : statusText(snapshot);
  const hint = notice ?? selectionHint(model, shown, snapshot.rows, selection, toModel);
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
    <div className="sheet" onKeyDownCapture={onKeyDown} onMouseDown={() => notice && !notice.keep && setNotice(null)}>
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
          {sheet.params?.map((p) => (
            <label key={p.key} className="param">
              {p.label}
              <input
                type="date"
                value={params[p.key] ?? ''}
                onChange={(e) => setParams((cur) => ({ ...cur, [p.key]: e.target.value }))}
              />
            </label>
          ))}
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
            onClick={() => {
              resortOnLoad.current = true;
              // Unchanged data doesn't reload the model, so re-sort what is there as well.
              void rowsQuery.refetch().then(() => setLoadVersion((v) => v + 1));
            }}
            disabled={rowsQuery.isFetching || model.hasUnsavedChanges}
            title={model.hasUnsavedChanges ? 'Wait for changes to save' : 'Reload from the server'}
          >
            Reload
          </button>
        </div>
      </header>

      <ViewBar
        sheet={sheet}
        columns={model.columns}
        config={config}
        active={activeView}
        onApply={(view, next) => {
          setActiveView(view);
          setConfig(next);
          setSelection(emptySelection);
        }}
        onConfig={setConfig}
        onNotice={setNotice}
      />

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
            freezeColumns={Math.min(config.frozen, Math.max(0, shown.length - 1))}
            onHeaderClicked={(col) => {
              const key = shown[col]?.column.key;
              // Reports keep their own order (their Total rows belong where they are).
              if (!key || readOnlySheet) return;
              // Click a header: ascending, then descending, then unsorted.
              setConfig((c) => ({
                ...c,
                sort: c.sort?.column !== key ? { column: key, dir: 'asc' } : c.sort.dir === 'asc' ? { column: key, dir: 'desc' } : null,
              }));
            }}
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
        <span className={hint.tone === 'error' ? 'hint-error' : 'muted'}>
          {hint.text}
          {notice?.keep && (
            <button className="link notice-close" onClick={() => setNotice(null)}>
              Close
            </button>
          )}
        </span>
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
  shown: readonly ShownColumn[],
  rows: readonly RowState[],
  selection: GridSelection,
  toModel: (viewRow: number) => number,
): { text: string; tone: 'info' | 'error' } {
  const { sheet } = model;
  const cell = selection.current?.cell;
  if (!cell) {
    if (selection.rows.length > 0) return { text: `${selection.rows.length} row(s) selected.`, tone: 'info' };
    return { text: sheet.virtual ? 'Calculated report · read-only.' : 'Select a cell to see details.', tone: 'info' };
  }
  const [col, viewRow] = cell;
  const row = rows[toModel(viewRow)];
  const target = shown[col];
  if (target?.kind === 'formula') {
    return { text: `ƒ ${target.formula.label}: ${target.formula.formula} · calculated in your browser, never saved`, tone: 'info' };
  }
  const column = target?.column;
  if (!row || !column) return { text: '', tone: 'info' };
  const status = row.cells[column.key];
  if (status?.state === 'error') return { text: `${column.label}: ${status.message}`, tone: 'error' };
  if (status?.state === 'conflict') return { text: `${column.label}: ${status.message}`, tone: 'error' };
  if (row.rowError) return { text: row.rowError, tone: 'error' };
  if (sheet.virtual) return { text: `${column.label} is calculated · read-only.`, tone: 'info' };
  if (row.draft) {
    if (column.system) return { text: `${column.label} is filled in automatically when the row is saved.`, tone: 'info' };
    const missing = model.missingRequired(row);
    if (missing.length > 0) return { text: `New row: fill ${missing.join(', ')} to save it.`, tone: 'info' };
    if (Object.values(row.cells).some((c) => c?.state === 'error')) return { text: 'New row: fix the red cells to save it.', tone: 'info' };
    if (!model.isComplete(row)) return { text: 'New row: type something in it to save it.', tone: 'info' };
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
