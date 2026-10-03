import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { createTestDb } from './helpers/db.js';

// Rauchtest: Server baut, Route antwortet.
describe('App', () => {
  it('antwortet auf /api/health', async () => {
    const app = buildApp({ db: createTestDb() });
    const res = await app.inject({ method: 'GET', url: '/api/health' });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' });

    await app.close();
  });
});
