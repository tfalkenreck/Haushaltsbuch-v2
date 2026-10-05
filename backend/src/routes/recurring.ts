import type { FastifyInstance } from 'fastify';
import type { Db } from '../db/connection.js';
import { todayIso } from '../lib/time.js';
import {
  confirmSuggestion,
  createRecurringItem,
  deleteRecurringItem,
  dismissSuggestion,
  listRecurring,
  resetTransactionRecurring,
  setTransactionRecurring,
  splitRecurringItem,
  updateRecurringItem,
  type ConfirmInput,
  type RecurringItemInput,
} from '../services/recurring.js';

const idParams = {
  type: 'object',
  required: ['id'],
  properties: { id: { type: 'integer', minimum: 1 } },
} as const;

const date = { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' } as const;
const nullableDate = { type: ['string', 'null'], pattern: '^\\d{4}-\\d{2}-\\d{2}$' } as const;
const kind = { type: 'string', enum: ['fixed_cost', 'subscription'] } as const;
const interval = { type: 'string', enum: ['biweekly', 'monthly', 'quarterly', 'semiannual', 'annual'] } as const;

const itemBody = {
  type: 'object',
  required: ['kind', 'accountId', 'counterparty', 'amount', 'interval', 'nextDueDate'],
  additionalProperties: false,
  properties: {
    name: { type: 'string', maxLength: 200 },
    kind,
    accountId: { type: ['integer', 'null'], minimum: 1 },
    counterparty: { type: 'string', maxLength: 200 },
    amount: { type: 'string', maxLength: 30 },
    interval,
    nextDueDate: date,
    contractEndDate: nullableDate,
    noticePeriodValue: { type: ['integer', 'null'], minimum: 1, maximum: 120 },
    noticePeriodUnit: { type: ['string', 'null'], enum: ['days', 'weeks', 'months', null] },
    categoryId: { type: ['integer', 'null'], minimum: 1 },
    creditorId: { type: ['string', 'null'], maxLength: 50 },
    mandateReference: { type: ['string', 'null'], maxLength: 50 },
    counterpartyIban: { type: ['string', 'null'], maxLength: 50 },
    active: { type: 'boolean' },
    notes: { type: ['string', 'null'], maxLength: 500 },
  },
} as const;

const keyBody = {
  type: 'object',
  required: ['key'],
  additionalProperties: false,
  properties: { key: { type: 'string', minLength: 1, maxLength: 500 }, name: { type: 'string', maxLength: 200 }, kind },
} as const;

export function recurringRoutes(app: FastifyInstance, db: Db): void {
  /** Fixkosten und Abos mit Soll/Ist-Abgleich, dazu die erkannten Vorschläge (CLAUDE.md § 14). */
  app.get('/api/recurring', async () => listRecurring(db, todayIso()));

  app.post<{ Body: RecurringItemInput }>('/api/recurring', { schema: { body: itemBody } }, async (request, reply) => {
    const { id } = createRecurringItem(db, request.body);
    return reply.status(201).send({ id, overview: listRecurring(db, todayIso()) });
  });

  app.put<{ Params: { id: number }; Body: RecurringItemInput }>(
    '/api/recurring/:id',
    { schema: { params: idParams, body: itemBody } },
    async (request) => {
      updateRecurringItem(db, request.params.id, request.body);
      return listRecurring(db, todayIso());
    },
  );

  /** Löschen (Fehlerkennung entfernen) bzw. einen verworfenen Vorschlag zurückholen. */
  app.delete<{ Params: { id: number } }>('/api/recurring/:id', { schema: { params: idParams } }, async (request) => {
    deleteRecurringItem(db, request.params.id);
    return listRecurring(db, todayIso());
  });

  /** Verschmolzenen Posten aufteilen: die genannten Verträge werden eigene Posten (nur auf Knopfdruck). */
  app.post<{ Params: { id: number }; Body: { keys: string[] } }>(
    '/api/recurring/:id/split',
    {
      schema: {
        params: idParams,
        body: {
          type: 'object',
          required: ['keys'],
          additionalProperties: false,
          properties: { keys: { type: 'array', minItems: 1, maxItems: 100, items: { type: 'string', minLength: 1, maxLength: 500 } } },
        },
      },
    },
    async (request) => {
      const { created } = splitRecurringItem(db, request.params.id, request.body.keys, todayIso());
      return { created, overview: listRecurring(db, todayIso()) };
    },
  );

  /** Vorschlag übernehmen – erst dann zählt er als Fixkosten/Abo. */
  app.post<{ Body: ConfirmInput }>('/api/recurring/suggestions/confirm', { schema: { body: keyBody } }, async (request, reply) => {
    const { id } = confirmSuggestion(db, request.body, todayIso());
    return reply.status(201).send({ id, overview: listRecurring(db, todayIso()) });
  });

  /** Vorschlag verwerfen – wird nicht erneut vorgeschlagen. */
  app.post<{ Body: { key: string } }>('/api/recurring/suggestions/dismiss', { schema: { body: keyBody } }, async (request) => {
    dismissSuggestion(db, request.body.key, todayIso());
    return listRecurring(db, todayIso());
  });

  /** Buchung von Hand einem Posten zuordnen (itemId) oder als „nicht wiederkehrend“ markieren (null). */
  app.put<{ Params: { id: number }; Body: { itemId: number | null } }>(
    '/api/transactions/:id/recurring',
    {
      schema: {
        params: idParams,
        body: {
          type: 'object',
          required: ['itemId'],
          additionalProperties: false,
          properties: { itemId: { type: ['integer', 'null'], minimum: 1 } },
        },
      },
    },
    async (request, reply) => {
      setTransactionRecurring(db, request.params.id, request.body.itemId);
      return reply.status(204).send();
    },
  );

  /** Zuordnung von Hand aufheben – wieder automatisch über die Merkmale der Posten. */
  app.delete<{ Params: { id: number } }>('/api/transactions/:id/recurring', { schema: { params: idParams } }, async (request, reply) => {
    resetTransactionRecurring(db, request.params.id);
    return reply.status(204).send();
  });
}
