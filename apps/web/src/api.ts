import type { BatchRequest, BatchResponse, RowsResponse, SheetDef } from '@erp/schema';

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
  rows: (sheet: string) => request<RowsResponse>(`/api/sheets/${sheet}/rows?limit=10000`),
  batch: (sheet: string, body: BatchRequest) =>
    request<BatchResponse>(`/api/sheets/${sheet}/batch`, { method: 'POST', body: JSON.stringify(body) }),
};
