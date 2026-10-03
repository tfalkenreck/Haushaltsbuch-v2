import type { FastifyInstance } from 'fastify';
import type { Db } from '../db/connection.js';
import {
  BUCKETS,
  createCategory,
  deleteCategory,
  listCategories,
  updateCategory,
  type CategoryInput,
  type CategoryPatch,
} from '../services/categories.js';

const idParams = {
  type: 'object',
  required: ['id'],
  properties: { id: { type: 'integer', minimum: 1 } },
} as const;

const bucket = { type: ['string', 'null'], enum: [...BUCKETS, null] } as const;
const parentId = { type: ['integer', 'null'], minimum: 1 } as const;

const createBody = {
  type: 'object',
  required: ['name'],
  additionalProperties: false,
  properties: {
    name: { type: 'string', maxLength: 200 },
    parentId,
    bucket,
    inheritBucket: { type: 'boolean' },
  },
} as const;

const patchBody = {
  type: 'object',
  additionalProperties: false,
  minProperties: 1,
  properties: {
    name: { type: 'string', maxLength: 200 },
    parentId,
    bucket,
    inheritBucket: { type: 'boolean' },
    active: { type: 'boolean' },
  },
} as const;

export function categoryRoutes(app: FastifyInstance, db: Db): void {
  app.get('/api/categories', async () => listCategories(db));

  app.post<{ Body: CategoryInput }>('/api/categories', { schema: { body: createBody } }, async (request, reply) =>
    reply.status(201).send(createCategory(db, request.body)),
  );

  app.patch<{ Params: { id: number }; Body: CategoryPatch }>(
    '/api/categories/:id',
    { schema: { params: idParams, body: patchBody } },
    async (request) => updateCategory(db, request.params.id, request.body),
  );

  app.delete<{ Params: { id: number } }>('/api/categories/:id', { schema: { params: idParams } }, async (request, reply) => {
    deleteCategory(db, request.params.id);
    return reply.status(204).send();
  });
}
