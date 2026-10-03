import type { FastifyInstance } from 'fastify';
import type { Db } from '../db/connection.js';
import { todayIso } from '../lib/time.js';
import { deleteManualBalance, listManualBalances, setManualBalance, type ManualBalanceInput } from '../services/balances.js';
import { listBypass, setBypassDecision, type BypassDecisionInput } from '../services/bypass.js';
import { getFunding, setFundingStart } from '../services/funding.js';

const idParams = {
  type: 'object',
  required: ['id'],
  properties: { id: { type: 'integer', minimum: 1 } },
} as const;

const balanceBody = {
  type: 'object',
  required: ['date', 'amount'],
  additionalProperties: false,
  properties: {
    date: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
    amount: { type: 'string', maxLength: 30 },
    notes: { type: ['string', 'null'], maxLength: 200 },
  },
} as const;

const startBody = {
  type: 'object',
  required: ['month'],
  additionalProperties: false,
  properties: { month: { type: ['string', 'null'], pattern: '^\\d{4}-\\d{2}$' } },
} as const;

const decisionBody = {
  type: 'object',
  required: ['sourceAccountId', 'key', 'decision'],
  additionalProperties: false,
  properties: {
    sourceAccountId: { type: 'integer', minimum: 1 },
    key: { type: 'string', minLength: 1, maxLength: 500 },
    decision: { type: ['string', 'null'], enum: ['move', 'keep', null] },
    targetAccountId: { type: ['integer', 'null'], minimum: 1 },
  },
} as const;

export function fundingRoutes(app: FastifyInstance, db: Db): void {
  /** Deckungsprüfung eines per Dauerauftrag gespeisten Kontos (CLAUDE.md § 12). */
  app.get<{ Params: { id: number } }>('/api/accounts/:id/funding', { schema: { params: idParams } }, async (request) =>
    getFunding(db, request.params.id, todayIso()),
  );

  /** Ersten Monat der Auswertung festlegen (month null = automatisch ab der letzten Umstellung). */
  app.put<{ Params: { id: number }; Body: { month: string | null } }>(
    '/api/accounts/:id/funding/start',
    { schema: { params: idParams, body: startBody } },
    async (request) => {
      setFundingStart(db, request.params.id, request.body.month);
      return getFunding(db, request.params.id, todayIso());
    },
  );

  /** Von Hand erfasste Kontostände (für Konten ohne Saldo im Export). */
  app.get<{ Params: { id: number } }>('/api/accounts/:id/balances', { schema: { params: idParams } }, async (request) =>
    listManualBalances(db, request.params.id),
  );

  app.post<{ Params: { id: number }; Body: ManualBalanceInput }>(
    '/api/accounts/:id/balances',
    { schema: { params: idParams, body: balanceBody } },
    async (request, reply) => reply.status(201).send(setManualBalance(db, request.params.id, request.body)),
  );

  app.delete<{ Params: { id: number } }>('/api/balances/:id', { schema: { params: idParams } }, async (request, reply) => {
    deleteManualBalance(db, request.params.id);
    return reply.status(204).send();
  });

  /** Ausgaben am Ausgabenkonto vorbei (CLAUDE.md § 13). */
  app.get('/api/bypass', async () => listBypass(db));

  /** „Soll umgestellt werden“ / „bleibt bewusst hier“ (decision null = zurücknehmen). */
  app.put<{ Body: BypassDecisionInput }>('/api/bypass/decision', { schema: { body: decisionBody } }, async (request) => {
    setBypassDecision(db, request.body);
    return listBypass(db);
  });
}
