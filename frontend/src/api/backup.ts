import { apiDownload, apiRequest, apiUpload } from './client';

export interface ExportStatus {
  lastExportAt: string | null;
  /** Noch keine Daten – nur dann ist ein Re-Import möglich. */
  empty: boolean;
}

export const fetchExportStatus = () => apiRequest<ExportStatus>('GET', '/export/status');
/** Alle Daten als JSON-Datei herunterladen; liefert den Dateinamen. */
export const downloadExport = () => apiDownload('/export', 'haushaltsbuch-export.json');
/** Exportdatei in die leere Datenbank übernehmen. */
export const importExport = (file: Blob) => apiUpload<{ rows: Record<string, number> }>('/export/import', file, 'application/json');
