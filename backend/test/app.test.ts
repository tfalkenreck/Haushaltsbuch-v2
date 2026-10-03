import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';

// Rauchtest fürs Gerüst: Server baut, Route antwortet.
describe('Gerüst', () => {
  it('antwortet auf /api/health', async () => {
    const app = buildApp();
    const res = await app.inject({ method: 'GET', url: '/api/health' });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' });

    await app.close();
  });
});
