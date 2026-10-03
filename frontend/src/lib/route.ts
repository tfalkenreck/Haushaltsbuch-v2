import { useEffect, useState } from 'react';

export type Page = 'konten' | 'import' | 'buchungen' | 'kategorien' | 'regeln';

export interface Route {
  page: Page;
  params: URLSearchParams;
}

const PAGES: readonly Page[] = ['konten', 'import', 'buchungen', 'kategorien', 'regeln'];

/** `#/buchungen?accountId=3` → { page: 'buchungen', params }. Unbekannt → Konten. */
export function parseHash(hash: string): Route {
  const [path = '', search = ''] = hash.replace(/^#\/?/, '').split('?');
  const page = (PAGES as readonly string[]).includes(path) ? (path as Page) : 'konten';
  return { page, params: new URLSearchParams(search) };
}

export function hrefFor(page: Page, params: Record<string, string | number | undefined> = {}): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== '') search.set(key, String(value));
  }
  const text = search.toString();
  return `#/${page}${text ? `?${text}` : ''}`;
}

/** Aktuelle Seite aus dem URL-Fragment – Vor/Zurück im Browser funktioniert. */
export function useRoute(): Route {
  const [route, setRoute] = useState(() => parseHash(window.location.hash));
  useEffect(() => {
    const onChange = () => setRoute(parseHash(window.location.hash));
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  return route;
}
