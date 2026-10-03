import type { FastifyInstance } from 'fastify';
import type { Db } from '../db/connection.js';
import {
  confirmTransfer,
  detectTransfers,
  dissolveTransfer,
  getTransfer,
  listTransfers,
  type TransferFilter,
} from '../services/transfers.js';

const idParams = {
  type: 'object',
  required: ['id'],
  properties: { id: { type: 'integer', minimum: 1 } },
} as const;

export function transferRoutes(app: FastifyInstance, db: Db): void {
  /** Übersicht aller Umbuchungen, damit Fehlerkennungen auffallen (CLAUDE.md § 10). */
  app.get<{ Querystring: TransferFilter }>(
    '/api/transfers',
    {
      schema: {
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: {
            status: { type: 'string', enum: ['suggested', 'confirmed'] },
            accountId: { type: 'integer', minimum: 1 },
          },
        },
      },
    },
    async (request) => listTransfers(db, request.query),
  );

  app.get<{ Params: { id: number } }>('/api/transfers/:id', { schema: { params: idParams } }, async (request) =>
    getTransfer(db, request.params.id),
  );

  /** Erkennung über den Bestand laufen lassen (läuft sonst nach jedem Import). */
  app.post('/api/transfers/detect', async () => detectTransfers(db));

  app.post<{ Params: { id: number } }>('/api/transfers/:id/confirm', { schema: { params: idParams } }, async (request) =>
    confirmTransfer(db, request.params.id),
  );

  /** Aufheben (Fehlerkennung): Buchungen zählen wieder als Einnahme/Ausgabe und werden nicht erneut vorgeschlagen. */
  app.delete<{ Params: { id: number } }>('/api/transfers/:id', { schema: { params: idParams } }, async (request) =>
    dissolveTransfer(db, request.params.id),
  );
}
