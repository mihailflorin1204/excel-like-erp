import type { ColumnDef, SavedView, SheetDef, ViewConfig } from '@erp/schema';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { api } from './api.ts';
import { DEFAULT_VIEW, type FormulaDef, nextFormulaKey } from './view-logic.ts';

type Notice = { text: string; tone: 'info' | 'error'; keep?: boolean };

const same = (a: ViewConfig, b: ViewConfig) => JSON.stringify(a) === JSON.stringify(b);

/** The last view used per sheet, remembered in this browser only. */
const remembered = {
  get(sheet: string): string | null {
    try {
      return localStorage.getItem(`erp:view:${sheet}`);
    } catch {
      return null;
    }
  },
  set(sheet: string, id: string | null) {
    try {
      if (id) localStorage.setItem(`erp:view:${sheet}`, id);
      else localStorage.removeItem(`erp:view:${sheet}`);
    } catch {
      // Storage blocked: the view just isn't remembered.
    }
  },
};

/**
 * Saved views for a sheet: pick one, save changes, save as a new (private or shared) view, delete. Also the
 * Columns panel (show/hide, freeze) and the formula column editor. Changes apply at once; saving keeps them.
 */
export function ViewBar({
  sheet,
  columns,
  config,
  active,
  onApply,
  onConfig,
  onNotice,
}: {
  sheet: SheetDef;
  columns: readonly ColumnDef[];
  config: ViewConfig;
  active: SavedView | null;
  onApply: (view: SavedView | null, config: ViewConfig) => void;
  onConfig: (update: (c: ViewConfig) => ViewConfig) => void;
  onNotice: (n: Notice) => void;
}) {
  const queryClient = useQueryClient();
  const views = useQuery({ queryKey: ['views', sheet.key], queryFn: () => api.views(sheet.key) });
  const [panel, setPanel] = useState<'none' | 'columns' | 'saveAs' | 'formula'>('none');
  const [editing, setEditing] = useState<FormulaDef | null>(null);
  const [busy, setBusy] = useState(false);

  // Open the view used last time on this sheet (unless the page was opened with a filter, e.g. Show lines).
  const restored = useRef(false);
  useEffect(() => {
    if (restored.current || !views.data) return;
    restored.current = true;
    const id = remembered.get(sheet.key);
    const view = views.data.find((v) => v.id === id);
    if (view && !config.query) onApply(view, view.config);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [views.data]);

  const base = active?.config ?? { ...DEFAULT_VIEW, query: '' };
  const changed = !same(config, base);
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['views', sheet.key] });
  const run = async (work: () => Promise<void>) => {
    setBusy(true);
    try {
      await work();
    } catch (err) {
      onNotice({ text: err instanceof Error ? err.message : String(err), tone: 'error' });
    } finally {
      setBusy(false);
    }
  };

  const pick = (id: string) => {
    const view = views.data?.find((v) => v.id === id) ?? null;
    remembered.set(sheet.key, view?.id ?? null);
    onApply(view, view ? view.config : { ...DEFAULT_VIEW });
    setPanel('none');
  };

  const save = () =>
    run(async () => {
      if (!active) return;
      const view = await api.updateView(active.id, { config });
      await refresh();
      onApply(view, view.config);
      onNotice({ text: `Saved view "${view.name}".`, tone: 'info' });
    });

  const remove = () =>
    run(async () => {
      if (!active || !window.confirm(`Delete the view "${active.name}"${active.shared ? ' for everyone' : ''}?`)) return;
      await api.deleteView(active.id);
      remembered.set(sheet.key, null);
      await refresh();
      onApply(null, { ...DEFAULT_VIEW });
      onNotice({ text: `Deleted view "${active.name}".`, tone: 'info' });
    });

  const hidden = new Set(config.hidden);
  const toggleColumn = (key: string) =>
    onConfig((c) => ({ ...c, hidden: hidden.has(key) ? c.hidden.filter((k) => k !== key) : [...c.hidden, key] }));

  return (
    <div className="viewbar">
      <label className="view-pick">
        View
        <select value={active?.id ?? ''} onChange={(e) => pick(e.target.value)} disabled={views.isPending}>
          <option value="">Standard</option>
          {views.data?.map((v) => (
            <option key={v.id} value={v.id}>
              {v.name}
              {v.shared ? (v.mine ? ' · shared' : ` · ${v.owner}`) : ''}
            </option>
          ))}
        </select>
      </label>
      {changed && <span className="view-changed">changed</span>}
      {active?.mine && (
        <button onClick={() => void save()} disabled={!changed || busy} title="Keep the current filter, sort, columns and formulas in this view">
          Save
        </button>
      )}
      <button onClick={() => setPanel(panel === 'saveAs' ? 'none' : 'saveAs')} disabled={busy}>
        Save as…
      </button>
      {active && (
        <button onClick={() => void remove()} disabled={busy || (!active.mine && !active.shared)}>
          Delete view
        </button>
      )}
      {changed && (
        <button onClick={() => onApply(active, base)} title="Go back to how the view was saved">
          Undo changes
        </button>
      )}
      <span className="viewbar-sep" />
      <button onClick={() => setPanel(panel === 'columns' ? 'none' : 'columns')} aria-expanded={panel === 'columns'}>
        Columns{config.hidden.length > 0 ? ` (${config.hidden.length} hidden)` : ''}
      </button>
      <button
        onClick={() => {
          setEditing(null);
          setPanel(panel === 'formula' ? 'none' : 'formula');
        }}
        title="Add a calculated column, e.g. =[Qty]*[Unit price]. Only in this view; nothing is saved to the data."
      >
        + Formula
      </button>
      {config.sort && (
        <span className="muted small">
          Sorted by {columns.find((c) => c.key === config.sort!.column)?.label ?? config.formulas.find((f) => f.key === config.sort!.column)?.label}{' '}
          {config.sort.dir === 'asc' ? '▲' : '▼'}{' '}
          <button className="link" onClick={() => onConfig((c) => ({ ...c, sort: null }))}>
            clear
          </button>
        </span>
      )}

      {panel === 'saveAs' && (
        <SaveAsForm
          busy={busy}
          onCancel={() => setPanel('none')}
          onSave={(name, shared) =>
            run(async () => {
              const view = await api.createView({ sheet: sheet.key, name, shared, config });
              await refresh();
              remembered.set(sheet.key, view.id);
              onApply(view, view.config);
              setPanel('none');
              onNotice({ text: `Saved view "${view.name}"${shared ? ', shared with everyone' : ''}.`, tone: 'info' });
            })
          }
        />
      )}

      {panel === 'columns' && (
        <div className="view-panel">
          <div className="view-panel-head">
            <strong>Columns</strong>
            <label>
              Freeze first{' '}
              <select value={config.frozen} onChange={(e) => onConfig((c) => ({ ...c, frozen: Number(e.target.value) }))}>
                {[0, 1, 2, 3, 4].map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>{' '}
              columns
            </label>
            <button className="link" onClick={() => onConfig((c) => ({ ...c, hidden: [] }))} disabled={config.hidden.length === 0}>
              Show all
            </button>
            <button className="link" onClick={() => setPanel('none')}>
              Close
            </button>
          </div>
          <div className="column-list">
            {columns
              .filter((c) => !c.hidden)
              .map((c) => (
                <label key={c.key}>
                  <input type="checkbox" checked={!hidden.has(c.key)} onChange={() => toggleColumn(c.key)} /> {c.label}
                </label>
              ))}
          </div>
          {config.formulas.length > 0 && (
            <>
              <strong>Formula columns</strong>
              <ul className="formula-list">
                {config.formulas.map((f) => (
                  <li key={f.key}>
                    <span>
                      ƒ {f.label} <code>{f.formula}</code>
                    </span>
                    <button
                      className="link"
                      onClick={() => {
                        setEditing(f);
                        setPanel('formula');
                      }}
                    >
                      Edit
                    </button>
                    <button
                      className="link"
                      onClick={() =>
                        onConfig((c) => ({ ...c, formulas: c.formulas.filter((x) => x.key !== f.key), sort: c.sort?.column === f.key ? null : c.sort }))
                      }
                    >
                      Remove
                    </button>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      )}

      {panel === 'formula' && (
        <FormulaForm
          key={editing?.key ?? 'new'}
          columns={columns}
          initial={editing}
          onCancel={() => setPanel('none')}
          onSave={(label, formula) => {
            onConfig((c) => ({
              ...c,
              formulas: editing
                ? c.formulas.map((f) => (f.key === editing.key ? { ...f, label, formula } : f))
                : [...c.formulas, { key: nextFormulaKey(c.formulas), label, formula }],
            }));
            setPanel('none');
          }}
        />
      )}
    </div>
  );
}

function SaveAsForm({ busy, onSave, onCancel }: { busy: boolean; onSave: (name: string, shared: boolean) => void; onCancel: () => void }) {
  const [name, setName] = useState('');
  const [shared, setShared] = useState(false);
  return (
    <form
      className="view-panel view-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (name.trim()) onSave(name.trim(), shared);
      }}
    >
      <label>
        Name <input value={name} onChange={(e) => setName(e.target.value)} maxLength={60} autoFocus required placeholder="e.g. Low stock" />
      </label>
      <label>
        <input type="checkbox" checked={shared} onChange={(e) => setShared(e.target.checked)} /> Share with everyone
      </label>
      <button type="submit" className="primary" disabled={busy || !name.trim()}>
        Save view
      </button>
      <button type="button" onClick={onCancel}>
        Cancel
      </button>
    </form>
  );
}

function FormulaForm({
  columns,
  initial,
  onSave,
  onCancel,
}: {
  columns: readonly ColumnDef[];
  initial: FormulaDef | null;
  onSave: (label: string, formula: string) => void;
  onCancel: () => void;
}) {
  const [label, setLabel] = useState(initial?.label ?? '');
  const [formula, setFormula] = useState(initial?.formula ?? '=');
  const names = columns.filter((c) => !c.hidden).map((c) => c.label);
  const insert = (name: string) => setFormula((f) => `${f}[${name}]`);
  return (
    <form
      className="view-panel view-form formula-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (label.trim() && formula.trim().length > 1) onSave(label.trim(), formula.trim());
      }}
    >
      <label>
        Name <input value={label} onChange={(e) => setLabel(e.target.value)} maxLength={60} autoFocus required placeholder="e.g. Value" />
      </label>
      <label className="grow">
        Formula{' '}
        <input value={formula} onChange={(e) => setFormula(e.target.value)} maxLength={2000} required placeholder="=[Qty]*[Unit price]" className="mono" />
      </label>
      <button type="submit" className="primary">
        {initial ? 'Update' : 'Add column'}
      </button>
      <button type="button" onClick={onCancel}>
        Cancel
      </button>
      <p className="muted small formula-help">
        Use a column as <code>[Name]</code>, and Excel functions such as ROUND, IF, SUM or TEXT. Calculated in your browser for each row; nothing is
        saved to the data. Columns:{' '}
        {names.map((n, i) => (
          <span key={n}>
            <button type="button" className="link" onClick={() => insert(n)}>
              {n}
            </button>
            {i < names.length - 1 ? ', ' : ''}
          </span>
        ))}
      </p>
    </form>
  );
}
