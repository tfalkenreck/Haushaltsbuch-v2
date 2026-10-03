import type { FastifyInstance } from 'fastify';
import type { Db } from '../db/connection.js';
import { todayIso } from '../lib/time.js';
import { getAccount } from '../services/accounts.js';
import { getCoverage } from '../services/coverage.js';
import { importFile, listImportBatches, undoImport } from '../services/imports.js';

/** Größte Datei, die angenommen wird (Kontoauszüge sind klein). */
const MAX_FILE_BYTES = 20 * 1024 * 1024;

const idParams = {
  type: 'object',
  required: ['id'],
  properties: { id: { type: 'integer', minimum: 1 } },
} as const;

const dateString = { type: 'string', pattern: '^(\\d{4}-\\d{2}-\\d{2})?$' } as const;

const importQuery = {
  type: 'object',
  additionalProperties: false,
  properties: {
    fileName: { type: 'string', maxLength: 255 },
    periodStart: dateString,
    periodEnd: dateString,
  },
} as const;

export function importRoutes(app: FastifyInstance, db: Db): void {
  // Die Datei kommt als rohe Bytes – das Encoding bestimmt der Adapter,
  // nicht der Browser.
  app.addContentTypeParser(
    'application/octet-stream',
    { parseAs: 'buffer', bodyLimit: MAX_FILE_BYTES },
    (_request, body, done) => done(null, body),
  );

  app.post<{
    Params: { id: number };
    Querystring: { fileName?: string; periodStart?: string; periodEnd?: string };
    Body: Buffer;
  }>('/api/accounts/:id/imports', { schema: { params: idParams, querystring: importQuery } }, async (request, reply) => {
    const body = request.body;
    if (!Buffer.isBuffer(body) || body.length === 0) {
      return reply.status(400).send({ error: 'Keine Datei übermittelt (Content-Type application/octet-stream).' });
    }
    const result = importFile(db, {
      accountId: request.params.id,
      fileName: request.query.fileName ?? '',
      bytes: new Uint8Array(body.buffer, body.byteOffset, body.byteLength),
      periodStart: request.query.periodStart,
      periodEnd: request.query.periodEnd,
    });
    return reply.status(result.batchId === null ? 200 : 201).send(result);
  });

  app.get<{ Querystring: { accountId?: number } }>(
    '/api/imports',
    {
      schema: {
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: { accountId: { type: 'integer', minimum: 1 } },
        },
      },
    },
    async (request) => listImportBatches(db, request.query.accountId),
  );

  app.delete<{ Params: { id: number } }>('/api/imports/:id', { schema: { params: idParams } }, async (request) =>
    undoImport(db, request.params.id),
  );

  app.get<{ Params: { id: number } }>('/api/accounts/:id/coverage', { schema: { params: idParams } }, async (request) => {
    getAccount(db, request.params.id);
    return getCoverage(db, request.params.id, todayIso());
  });
}
