import type { BatchRequest, BatchResponse, Row, RowsResponse, SavedView, SheetDef, ViewConfig } from '@erp/schema';

export interface CurrentUser {
  email: string;
  name: string;
  role: 'Admin' | 'Member';
  mustChangePassword: boolean;
}

export type Me =
  | { state: 'signedIn'; user: CurrentUser; authEnabled: boolean }
  | { state: 'setup' }
  | { state: 'signedOut' };

/** Fired when the server says the session is gone, so the app shows the sign-in screen. */
export const SIGNED_OUT_EVENT = 'erp:signed-out';

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    credentials: 'same-origin',
    // Only with a body: the API refuses an empty body that claims to be JSON (e.g. a DELETE).
    headers: { ...(init?.body !== undefined ? { 'content-type': 'application/json' } : {}), ...init?.headers },
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { message?: string } | null;
    if ((res.status === 401 || body?.message === 'Choose a new password first') && !url.startsWith('/api/auth/')) {
      window.dispatchEvent(new Event(SIGNED_OUT_EVENT));
    }
    throw new ApiError(res.status, body?.message ?? `Request failed (${res.status})`);
  }
  return (await res.json()) as T;
}

const post = <T>(url: string, body: unknown) => request<T>(url, { method: 'POST', body: JSON.stringify(body) });

export const api = {
  sheets: () => request<{ sheets: SheetDef[] }>('/api/sheets').then((r) => r.sheets),
  rows: (sheet: string, params: Record<string, string> = {}) => {
    const query = new URLSearchParams({ limit: '10000' });
    for (const [k, v] of Object.entries(params)) if (v) query.set(k, v);
    return request<RowsResponse>(`/api/sheets/${sheet}/rows?${query}`);
  },
  batch: (sheet: string, body: BatchRequest) => post<BatchResponse>(`/api/sheets/${sheet}/batch`, body),
  action: (sheet: string, id: string, action: string) =>
    post<{ rows: Row[]; message?: string }>(`/api/sheets/${sheet}/rows/${id}/actions/${action}`, {}),

  me: async (): Promise<Me> => {
    try {
      const r = await request<{ user?: CurrentUser; setupNeeded?: boolean; authEnabled: boolean }>('/api/auth/me');
      if (r.setupNeeded) return { state: 'setup' };
      return { state: 'signedIn', user: r.user!, authEnabled: r.authEnabled };
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) return { state: 'signedOut' };
      throw err;
    }
  },
  setup: (body: { email: string; name: string; password: string }) => post<{ user: CurrentUser }>('/api/auth/setup', body),
  login: (body: { email: string; password: string }) => post<{ user: CurrentUser }>('/api/auth/login', body),
  logout: () => post<{ ok: true }>('/api/auth/logout', {}),
  changePassword: (body: { current: string; password: string }) => post<{ user: CurrentUser }>('/api/auth/password', body),

  views: (sheet: string) => request<{ views: SavedView[] }>(`/api/views?sheet=${encodeURIComponent(sheet)}`).then((r) => r.views),
  createView: (body: { sheet: string; name: string; shared: boolean; config: ViewConfig }) => post<{ view: SavedView }>('/api/views', body).then((r) => r.view),
  updateView: (id: string, body: { name?: string; shared?: boolean; config?: ViewConfig }) =>
    request<{ view: SavedView }>(`/api/views/${id}`, { method: 'PUT', body: JSON.stringify(body) }).then((r) => r.view),
  deleteView: (id: string) => request<{ ok: true }>(`/api/views/${id}`, { method: 'DELETE' }),
};
