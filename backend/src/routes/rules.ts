import type { FastifyInstance } from 'fastify';
import type { Db } from '../db/connection.js';
import { PATTERN_TYPES, RULE_FIELDS } from '../lib/patterns.js';
import {
  applyRules,
  createRule,
  deleteRule,
  getRule,
  listRules,
  previewPattern,
  updateRule,
  type RuleInput,
  type RulePatch,
} from '../services/rules.js';

const idParams = {
  type: 'object',
  required: ['id'],
  properties: { id: { type: 'integer', minimum: 1 } },
} as const;

const ruleProperties = {
  field: { type: 'string', enum: [...RULE_FIELDS] },
  patternType: { type: 'string', enum: [...PATTERN_TYPES] },
  pattern: { type: 'string', maxLength: 500 },
  categoryId: { type: 'integer', minimum: 1 },
  priority: { type: 'integer' },
  active: { type: 'boolean' },
} as const;

const createBody = {
  type: 'object',
  required: ['field', 'patternType', 'pattern', 'categoryId'],
  additionalProperties: false,
  properties: ruleProperties,
} as const;

const patchBody = {
  type: 'object',
  additionalProperties: false,
  minProperties: 1,
  properties: ruleProperties,
} as const;

const previewBody = {
  type: 'object',
  required: ['field', 'patternType', 'pattern'],
  additionalProperties: false,
  properties: {
    field: ruleProperties.field,
    patternType: ruleProperties.patternType,
    pattern: ruleProperties.pattern,
  },
} as const;

export function ruleRoutes(app: FastifyInstance, db: Db): void {
  app.get('/api/rules', async () => listRules(db));

  app.post<{ Body: RuleInput }>('/api/rules', { schema: { body: createBody } }, async (request, reply) =>
    reply.status(201).send(createRule(db, request.body)),
  );

  app.patch<{ Params: { id: number }; Body: RulePatch }>(
    '/api/rules/:id',
    { schema: { params: idParams, body: patchBody } },
    async (request) => updateRule(db, request.params.id, request.body),
  );

  app.delete<{ Params: { id: number }; Querystring: { unassign?: boolean } }>(
    '/api/rules/:id',
    {
      schema: {
        params: idParams,
        querystring: { type: 'object', additionalProperties: false, properties: { unassign: { type: 'boolean' } } },
      },
    },
    async (request) => deleteRule(db, request.params.id, { unassign: request.query.unassign ?? false }),
  );

  /** Welche Buchungen ein Muster träfe, bevor es gespeichert wird. */
  app.post<{ Body: { field: string; patternType: string; pattern: string } }>(
    '/api/rules/preview',
    { schema: { body: previewBody } },
    async (request) => previewPattern(db, request.body),
  );

  /** Alle Regeln auf unkategorisierte Buchungen anwenden. */
  app.post('/api/rules/apply', async () => ({ categorized: applyRules(db) }));

  /** Eine Regel auf unkategorisierte Buchungen anwenden (dort, wo sie gewinnt). */
  app.post<{ Params: { id: number } }>('/api/rules/:id/apply', { schema: { params: idParams } }, async (request) => {
    getRule(db, request.params.id);
    return { categorized: applyRules(db, { ruleId: request.params.id }) };
  });
}
