import type { SheetDef } from '@erp/schema';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { api, type CurrentUser } from './api.ts';
import { AuthGate, UserMenu } from './Auth.tsx';
import { SheetView } from './SheetView.tsx';


const moduleLabel: Record<SheetDef['module'], string> = {
  inventory: 'Inventory',
  purchasing: 'Purchasing',
  accounting: 'Accounting',
  hr: 'HR',
  admin: 'Admin',
};

/** `#/purchaseOrderLines?q=PO-00001` → sheet key and filter text. */
const parseHash = () => {
  const [path = '', search = ''] = window.location.hash.replace(/^#\/?/, '').split('?');
  return { sheet: path, query: new URLSearchParams(search).get('q') ?? '' };
};

export function App() {
  return <AuthGate>{(user, authEnabled) => <Workspace user={user} authEnabled={authEnabled} />}</AuthGate>;
}

function Workspace({ user, authEnabled }: { user: CurrentUser; authEnabled: boolean }) {
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
  const modules = [...new Set(sheets.map((s) => moduleLabel[s.module]))];

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
            </ul>
          </section>
        ))}
        <UserMenu user={user} authEnabled={authEnabled} />
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
