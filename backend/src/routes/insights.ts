import type { FastifyInstance } from 'fastify';
import type { Db } from '../db/connection.js';
import { todayIso } from '../lib/time.js';
import { getAttention } from '../services/attention.js';
import { getBudget, type BudgetQuery } from '../services/budget.js';
import { DEFAULT_HORIZON, getForecast, MAX_HORIZON } from '../services/forecast.js';
import { getMonthOverview, type OverviewQuery } from '../services/overview.js';

const month = { type: 'string', pattern: '^\\d{4}-\\d{2}$' } as const;

/** Auswertungen der Phase 7 (CLAUDE.md § 15): Startseite, Budget, Prognose. */
export function insightRoutes(app: FastifyInstance, db: Db): void {
  /** Offene Punkte, die eine Handlung erfordern. */
  app.get('/api/attention', async () => ({ items: getAttention(db, todayIso()) }));

  /** Monatsübersicht: Einnahmen/Ausgaben/Saldo ohne Umbuchungen, Kategorien, Vormonat, zwölf Monate. */
  app.get<{ Querystring: OverviewQuery }>(
    '/api/overview',
    {
      schema: {
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: { month, accountId: { type: 'integer', minimum: 1 } },
        },
      },
    },
    async (request) => getMonthOverview(db, request.query, todayIso()),
  );

  /** Budget 50/30/20 für einen Monat oder den Durchschnitt mehrerer Monate. */
  app.get<{ Querystring: BudgetQuery }>(
    '/api/budget',
    {
      schema: {
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: { month, span: { type: 'integer', enum: [1, 3, 6, 12] } },
        },
      },
    },
    async (request) => getBudget(db, request.query, todayIso()),
  );

  /** Prognose ab dem aktuellen Monat. */
  app.get<{ Querystring: { months?: number } }>(
    '/api/forecast',
    {
      schema: {
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: { months: { type: 'integer', minimum: 1, maximum: MAX_HORIZON } },
        },
      },
    },
    async (request) => getForecast(db, todayIso(), request.query.months ?? DEFAULT_HORIZON),
  );
}
