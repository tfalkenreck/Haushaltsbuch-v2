/** Fehler einer /api-Anfrage mit der deutschen Meldung des Backends. */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export async function apiRequest<T>(method: string, path: string, body?: unknown): Promise<T> {
  const init: RequestInit = { method, headers: {} };
  if (body !== undefined) {
    init.headers = { 'Content-Type': 'application/json' };
    init.body = JSON.stringify(body);
  }
  return send<T>(path, init);
}

/**
 * Schickt eine Datei als rohe Bytes. Das Encoding bestimmt der Bank-Adapter
 * im Backend – der Browser liest die Datei nicht als Text.
 */
export async function apiUpload<T>(path: string, file: Blob, contentType = 'application/octet-stream'): Promise<T> {
  return send<T>(path, { method: 'POST', headers: { 'Content-Type': contentType }, body: file });
}

/**
 * Lädt eine Datei vom Backend (POST) und bietet sie dem Browser zum
 * Speichern an – den Dateinamen nennt das Backend.
 */
export async function apiDownload(path: string, fallbackName: string): Promise<string> {
  let res: Response;
  try {
    res = await fetch(`/api${path}`, { method: 'POST' });
  } catch {
    throw new ApiError('Backend nicht erreichbar.', 0);
  }
  if (!res.ok) {
    const data: unknown = await res.json().catch(() => null);
    const message =
      data && typeof data === 'object' && 'error' in data && typeof data.error === 'string' ? data.error : `Anfrage fehlgeschlagen (HTTP ${res.status}).`;
    throw new ApiError(message, res.status);
  }
  const name = /filename="([^"]+)"/.exec(res.headers.get('Content-Disposition') ?? '')?.[1] ?? fallbackName;
  const url = URL.createObjectURL(await res.blob());
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
  return name;
}

/** Baut einen Query-String aus gesetzten Werten (leere werden weggelassen). */
export function query(params: Record<string, string | number | undefined | null>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') search.set(key, String(value));
  }
  const text = search.toString();
  return text === '' ? '' : `?${text}`;
}

async function send<T>(path: string, init: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api${path}`, init);
  } catch {
    throw new ApiError('Backend nicht erreichbar.', 0);
  }

  const data: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const message =
      data && typeof data === 'object' && 'error' in data && typeof data.error === 'string'
        ? data.error
        : `Anfrage fehlgeschlagen (HTTP ${res.status}).`;
    throw new ApiError(message, res.status);
  }
  return data as T;
}
