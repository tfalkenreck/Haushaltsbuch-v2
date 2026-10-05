import type { FastifyInstance } from 'fastify';
import type { Db } from '../db/connection.js';
import { AppError } from '../lib/errors.js';
import { todayIso } from '../lib/time.js';
import {
  createSavingsGoal,
  deleteSavingsGoal,
  getSavingsOverview,
  updateSavingsGoal,
  type SavingsGoalInput,
} from '../services/savings-goals.js';

const idParams = {
  type: 'object',
  required: ['id'],
  properties: { id: { type: 'integer', minimum: 1 } },
} as const;

const goalBody = {
  type: 'object',
  required: ['name', 'amount'],
  additionalProperties: false,
  properties: {
    name: { type: 'string', maxLength: 200 },
    amount: { type: 'string', maxLength: 30 },
    targetDate: { type: ['string', 'null'], pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
    priority: { type: 'integer', minimum: 1, maximum: 1000 },
    accountId: { type: ['integer', 'null'], minimum: 1 },
    active: { type: 'boolean' },
  },
} as const;

/** `without=3,7` → [3, 7]; leer = keine Abos ausgewählt; weggelassen = alle Abos. */
function parseIds(text: string | undefined): number[] | undefined {
  if (text === undefined) return undefined;
  if (text.trim() === '') return [];
  const ids = text.split(',').map((part) => Number(part.trim()));
  if (ids.some((id) => !Number.isInteger(id) || id < 1)) throw new AppError(`„${text}“ ist keine Liste von IDs.`);
  return ids;
}

export function savingsGoalRoutes(app: FastifyInstance, db: Db): void {
  /** Sparziele mit Stand aus dem Konto, Plan gegen den prognostizierten Überschuss und Abo-Rückkopplung. */
  app.get<{ Querystring: { without?: string } }>(
    '/api/savings-goals',
    {
      schema: {
        querystring: { type: 'object', additionalProperties: false, properties: { without: { type: 'string', maxLength: 2000 } } },
      },
    },
    async (request) => getSavingsOverview(db, todayIso(), parseIds(request.query.without)),
  );

  app.post<{ Body: SavingsGoalInput }>('/api/savings-goals', { schema: { body: goalBody } }, async (request, reply) =>
    reply.status(201).send(createSavingsGoal(db, request.body)),
  );

  app.put<{ Params: { id: number }; Body: SavingsGoalInput }>(
    '/api/savings-goals/:id',
    { schema: { params: idParams, body: goalBody } },
    async (request, reply) => {
      updateSavingsGoal(db, request.params.id, request.body);
      return reply.status(204).send();
    },
  );

  app.delete<{ Params: { id: number } }>('/api/savings-goals/:id', { schema: { params: idParams } }, async (request, reply) => {
    deleteSavingsGoal(db, request.params.id);
    return reply.status(204).send();
  });
}
