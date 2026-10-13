import type { BatchRequest, BatchResponse, Row, RowsResponse, SheetDef } from '@erp/schema';

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: { 'content-type': 'application/json', ...init?.headers },
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { message?: string } | null;
    throw new Error(body?.message ?? `Request failed (${res.status})`);
  }
  return (await res.json()) as T;
}

export const api = {
  sheets: () => request<{ sheets: SheetDef[] }>('/api/sheets').then((r) => r.sheets),
  rows: (sheet: string, params: Record<string, string> = {}) => {
    const query = new URLSearchParams({ limit: '10000' });
    for (const [k, v] of Object.entries(params)) if (v) query.set(k, v);
    return request<RowsResponse>(`/api/sheets/${sheet}/rows?${query}`);
  },
  batch: (sheet: string, body: BatchRequest) =>
    request<BatchResponse>(`/api/sheets/${sheet}/batch`, { method: 'POST', body: JSON.stringify(body) }),
  action: (sheet: string, id: string, action: string) =>
    request<{ rows: Row[] }>(`/api/sheets/${sheet}/rows/${id}/actions/${action}`, { method: 'POST', body: '{}' }),
};
