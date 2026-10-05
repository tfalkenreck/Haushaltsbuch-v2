import type { FastifyInstance } from 'fastify';
import type { Db } from '../db/connection.js';
import { todayIso } from '../lib/time.js';
import { exportData, exportStatus, importData } from '../services/data-export.js';

/** Größte Exportdatei für den Re-Import. */
const MAX_IMPORT_BYTES = 200 * 1024 * 1024;

export function dataExportRoutes(app: FastifyInstance, db: Db): void {
  /** Letzter Export und ob ein Re-Import möglich ist (leere Datenbank). */
  app.get('/api/export/status', async () => exportStatus(db));

  /** Alle Daten als JSON-Datei (CLAUDE.md § 16); merkt sich den Zeitpunkt. */
  app.post('/api/export', async (_request, reply) => {
    const data = exportData(db);
    return reply
      .header('Content-Disposition', `attachment; filename="haushaltsbuch-${todayIso()}-export.json"`)
      .type('application/json; charset=utf-8')
      .send(JSON.stringify(data, null, 1));
  });

  /** Re-Import einer Exportdatei in eine leere Datenbank. */
  app.post('/api/export/import', { bodyLimit: MAX_IMPORT_BYTES }, async (request) => importData(db, request.body));
}
