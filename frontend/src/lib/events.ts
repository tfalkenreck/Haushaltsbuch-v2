import { useEffect } from 'react';

const EVENT = 'haushaltsbuch:data-changed';

/** Meldet geänderte Buchungsdaten (Import, Kategorie, Regel) – z. B. für den Unkategorisiert-Hinweis. */
export function notifyDataChanged(): void {
  window.dispatchEvent(new Event(EVENT));
}

export function useDataChanged(callback: () => void): void {
  useEffect(() => {
    window.addEventListener(EVENT, callback);
    return () => window.removeEventListener(EVENT, callback);
  }, [callback]);
}
