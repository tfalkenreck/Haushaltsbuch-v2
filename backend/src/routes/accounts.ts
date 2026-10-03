import type { FastifyInstance } from 'fastify';
import { BANK_ADAPTERS } from '../adapters/registry.js';
import type { Db } from '../db/connection.js';
import {
  ACCOUNT_ROLES,
  createAccount,
  getAccount,
  listAccounts,
  updateAccount,
  type AccountInput,
  type AccountPatch,
} from '../services/accounts.js';

const idParams = {
  type: 'object',
  required: ['id'],
  properties: { id: { type: 'integer', minimum: 1 } },
} as const;

const ibanSchema = { type: ['string', 'null'], maxLength: 50 } as const;

const createBody = {
  type: 'object',
  required: ['name', 'role', 'bankAdapter'],
  additionalProperties: false,
  properties: {
    name: { type: 'string', maxLength: 200 },
    role: { type: 'string' },
    bankAdapter: { type: 'string' },
    iban: ibanSchema,
  },
} as const;

const patchBody = {
  type: 'object',
  additionalProperties: false,
  minProperties: 1,
  properties: {
    name: { type: 'string', maxLength: 200 },
    role: { type: 'string' },
    bankAdapter: { type: 'string' },
    iban: ibanSchema,
    active: { type: 'boolean' },
  },
} as const;

export function accountRoutes(app: FastifyInstance, db: Db): void {
  app.get('/api/bank-adapters', async () => BANK_ADAPTERS);

  app.get('/api/account-roles', async () => ACCOUNT_ROLES);

  app.get('/api/accounts', async () => listAccounts(db));

  app.get<{ Params: { id: number } }>('/api/accounts/:id', { schema: { params: idParams } }, async (request) =>
    getAccount(db, request.params.id),
  );

  app.post<{ Body: AccountInput }>('/api/accounts', { schema: { body: createBody } }, async (request, reply) => {
    const account = createAccount(db, request.body);
    return reply.status(201).send(account);
  });

  app.patch<{ Params: { id: number }; Body: AccountPatch }>(
    '/api/accounts/:id',
    { schema: { params: idParams, body: patchBody } },
    async (request) => updateAccount(db, request.params.id, request.body),
  );
}
