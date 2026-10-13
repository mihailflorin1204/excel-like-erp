import type { SheetDef } from '@erp/schema';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { api } from './api.ts';
import { SheetView } from './SheetView.tsx';

/** Sheets planned for later phases, shown greyed out so the roadmap is visible in the app. */
const upcoming: { module: string; phase: number; sheets: string[] }[] = [
  { module: 'HR', phase: 5, sheets: ['Departments', 'Employees', 'Expense claims'] },
];

const moduleLabel: Record<SheetDef['module'], string> = {
  inventory: 'Inventory',
  purchasing: 'Purchasing',
  accounting: 'Accounting',
  hr: 'HR',
};

/** `#/purchaseOrderLines?q=PO-00001` → sheet key and filter text. */
const parseHash = () => {
  const [path = '', search = ''] = window.location.hash.replace(/^#\/?/, '').split('?');
  return { sheet: path, query: new URLSearchParams(search).get('q') ?? '' };
};

export function App() {
  const sheetsQuery = useQuery({ queryKey: ['sheets'], queryFn: api.sheets });
  const [route, setRoute] = useState(parseHash);
  const active = route.sheet;

  useEffect(() => {
    const onHash = () => setRoute(parseHash());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  const sheets = sheetsQuery.data ?? [];
  const current = sheets.find((s) => s.key === active) ?? sheets[0];
  const modules = [...new Set([...sheets.map((s) => moduleLabel[s.module]), ...upcoming.map((u) => u.module)])];

  return (
    <div className="app">
      <nav className="sidebar">
        <div className="brand">ERP</div>
        {modules.map((m) => (
          <section key={m}>
            <h2>{m}</h2>
            <ul>
              {sheets
                .filter((s) => moduleLabel[s.module] === m)
                .map((s) => (
                  <li key={s.key}>
                    <a href={`#/${s.key}`} className={s.key === current?.key ? 'active' : undefined}>
                      {s.label}
                    </a>
                  </li>
                ))}
              {upcoming
                .filter((u) => u.module === m)
                .flatMap((u) =>
                  u.sheets.map((name) => (
                    <li key={name} className="upcoming" title={`Coming in phase ${u.phase}`}>
                      {name} <span>P{u.phase}</span>
                    </li>
                  )),
                )}
            </ul>
          </section>
        ))}
      </nav>
      <main className="main">
        {sheetsQuery.isError && (
          <div className="sheet-error">
            <p>Can't reach the API. Is it running? ({sheetsQuery.error.message})</p>
            <button onClick={() => sheetsQuery.refetch()}>Try again</button>
          </div>
        )}
        {current && <SheetView key={current.key} sheet={current} initialQuery={current.key === active ? route.query : ''} />}
      </main>
    </div>
  );
}
