import type { FastifyInstance } from 'fastify';
import type { Db } from '../db/connection.js';
import { listTransactions, type TransactionFilter } from '../services/transactions.js';

const date = { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' } as const;

const listQuery = {
  type: 'object',
  additionalProperties: false,
  properties: {
    accountId: { type: 'integer', minimum: 1 },
    importBatchId: { type: 'integer', minimum: 1 },
    from: date,
    to: date,
    q: { type: 'string', maxLength: 200 },
    limit: { type: 'integer', minimum: 1, maximum: 500 },
    offset: { type: 'integer', minimum: 0 },
  },
} as const;

export function transactionRoutes(app: FastifyInstance, db: Db): void {
  app.get<{ Querystring: TransactionFilter }>('/api/transactions', { schema: { querystring: listQuery } }, async (request) =>
    listTransactions(db, request.query),
  );
}
