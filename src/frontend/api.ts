import type { DocumentProvenanceDetail } from './types';

export class ApiError extends Error { constructor(message: string, public status: number, public code?: string) { super(message); } }
export async function api<T>(path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetch(path, body === undefined ? (signal ? { signal } : undefined) : {
    signal, method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body),
  });
  const data = await response.json();
  if (!response.ok) throw new ApiError(typeof data?.error === 'string' ? data.error : '操作できませんでした', response.status, typeof data?.code === 'string' ? data.code : undefined);
  return data as T;
}

export function loadDocumentProvenance(name: string, revision: string, itemId: string, scope?: { projectId: string; taskId: string }): Promise<DocumentProvenanceDetail> {
  const query = new URLSearchParams({ name, revision, itemId, ...scope });
  return api<DocumentProvenanceDetail>(`/api/document-provenance?${query}`);
}
