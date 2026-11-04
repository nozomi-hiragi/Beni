export class ApiError extends Error { constructor(message: string, public status: number) { super(message); } }
export async function api<T>(path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetch(path, body === undefined ? (signal ? { signal } : undefined) : {
    signal, method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body),
  });
  const data = await response.json();
  if (!response.ok) throw new ApiError(typeof data?.error === 'string' ? data.error : '操作できませんでした', response.status);
  return data as T;
}
