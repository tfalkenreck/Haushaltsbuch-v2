import type { FastifyInstance } from 'fastify';
import type { Db } from '../db/connection.js';
import { markTransfer, resetTransfer, unmarkTransfer } from '../services/transfers.js';
import {
  listTransactions,
  resetTransactionCategory,
  setTransactionCategory,
  uncategorizedSummary,
  type TransactionFilter,
} from '../services/transactions.js';

const date = { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' } as const;

const idParams = {
  type: 'object',
  required: ['id'],
  properties: { id: { type: 'integer', minimum: 1 } },
} as const;

const listQuery = {
  type: 'object',
  additionalProperties: false,
  properties: {
    accountId: { type: 'integer', minimum: 1 },
    importBatchId: { type: 'integer', minimum: 1 },
    from: date,
    to: date,
    dateBasis: { type: 'string', enum: ['booking', 'bank'] },
    q: { type: 'string', maxLength: 200 },
    categoryId: { type: 'integer', minimum: 1 },
    uncategorized: { type: 'boolean' },
    transfers: { type: 'string', enum: ['only', 'exclude'] },
    recurringItemId: { type: 'integer', minimum: 1 },
    limit: { type: 'integer', minimum: 1, maximum: 500 },
    offset: { type: 'integer', minimum: 0 },
  },
} as const;

const categoryBody = {
  type: 'object',
  required: ['categoryId'],
  additionalProperties: false,
  properties: { categoryId: { type: ['integer', 'null'], minimum: 1 } },
} as const;

export function transactionRoutes(app: FastifyInstance, db: Db): void {
  app.get<{ Querystring: TransactionFilter }>('/api/transactions', { schema: { querystring: listQuery } }, async (request) =>
    listTransactions(db, request.query),
  );

  /** Anzahl und Summe unkategorisierter Buchungen – immer sichtbar in der Oberfläche. */
  app.get('/api/transactions/uncategorized', async () => uncategorizedSummary(db));

  /** Kategorie von Hand setzen (null = bewusst keine); liefert ggf. einen Regelvorschlag. */
  app.put<{ Params: { id: number }; Body: { categoryId: number | null } }>(
    '/api/transactions/:id/category',
    { schema: { params: idParams, body: categoryBody } },
    async (request) => setTransactionCategory(db, request.params.id, request.body.categoryId),
  );

  /** Handarbeit aufheben – Regeln dürfen die Buchung wieder einordnen. */
  app.delete<{ Params: { id: number } }>(
    '/api/transactions/:id/category',
    { schema: { params: idParams } },
    async (request) => resetTransactionCategory(db, request.params.id),
  );

  /**
   * Von Hand als Umbuchung markieren. Mit Gegenkonto wird dort die
   * Gegenbuchung gesucht; bei einer Kreditkarte entsteht eine Kartenabrechnung.
   */
  app.put<{ Params: { id: number }; Body: { accountId: number | null } }>(
    '/api/transactions/:id/transfer',
    {
      schema: {
        params: idParams,
        body: {
          type: 'object',
          required: ['accountId'],
          additionalProperties: false,
          properties: { accountId: { type: ['integer', 'null'], minimum: 1 } },
        },
      },
    },
    async (request) => markTransfer(db, request.params.id, { accountId: request.body.accountId }),
  );

  /** „Keine Umbuchung“ – zählt wieder als Einnahme/Ausgabe, Erkennung lässt die Buchung in Ruhe. */
  app.delete<{ Params: { id: number } }>(
    '/api/transactions/:id/transfer',
    { schema: { params: idParams } },
    async (request, reply) => {
      unmarkTransfer(db, request.params.id);
      return reply.status(204).send();
    },
  );

  /** Handarbeit aufheben – die Erkennung darf die Buchung wieder einordnen (läuft sofort). */
  app.post<{ Params: { id: number } }>(
    '/api/transactions/:id/transfer/reset',
    { schema: { params: idParams } },
    async (request) => resetTransfer(db, request.params.id),
  );
}
