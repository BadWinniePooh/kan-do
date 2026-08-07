/** Thin fetch wrapper. Errors surface as thrown ApiError — callers show them;
 * nothing fails silently. */
export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public fields?: { path: string; message: string }[],
    /** machine-readable payload, e.g. the checklist behind a blocked card move */
    public details?: unknown,
  ) {
    super(message);
  }
}

const BASE = import.meta.env.VITE_API_URL ?? '';

export async function api<T = unknown>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    credentials: 'include',
    headers: init.body ? { 'Content-Type': 'application/json' } : undefined,
    ...init,
  });
  if (!res.ok) {
    let msg = res.statusText;
    let fields;
    let details;
    try {
      const body = await res.json();
      msg = body.error ?? msg;
      fields = body.fields;
      details = body.details;
    } catch {
      /* non-JSON error body */
    }
    throw new ApiError(res.status, msg, fields, details);
  }
  return res.json() as Promise<T>;
}

export const get = <T>(path: string) => api<T>(path);
export const post = <T>(path: string, body?: unknown) =>
  api<T>(path, { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) });
export const patch = <T>(path: string, body: unknown) => api<T>(path, { method: 'PATCH', body: JSON.stringify(body) });
export const put = <T>(path: string, body: unknown) => api<T>(path, { method: 'PUT', body: JSON.stringify(body) });
export const del = <T>(path: string) => api<T>(path, { method: 'DELETE' });
