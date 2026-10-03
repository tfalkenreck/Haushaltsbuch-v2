import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { createTestDb } from './helpers/db.js';
import { fixture, IBAN } from './helpers/fixtures.js';

let app: FastifyInstance;

beforeEach(async () => {
  app = buildApp({ db: createTestDb() });
  const account = await app.inject({
    method: 'POST',
    url: '/api/accounts',
    payload: { name: 'Giro', role: 'einnahmen', bankAdapter: 'volksbank-owl', iban: IBAN.volksbankGiro },
  });
  await app.inject({
    method: 'POST',
    url: `/api/accounts/${account.json().id}/imports?fileName=giro.csv`,
    headers: { 'content-type': 'application/octet-stream' },
    payload: Buffer.from(fixture('volksbank-owl/giro.csv')),
  });
});

afterEach(async () => {
  await app.close();
});

async function categoryId(name: string): Promise<number> {
  const list = (await app.inject({ method: 'GET', url: '/api/categories' })).json() as { id: number; name: string }[];
  return list.find((c) => c.name === name)?.id as number;
}

describe('Kategorien-API', () => {
  it('legt an, ändert Bucket inkl. „keiner“ und löscht', async () => {
    const parentId = await categoryId('Mobilität');
    const created = await app.inject({ method: 'POST', url: '/api/categories', payload: { name: 'Fahrrad', parentId } });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ path: 'Mobilität › Fahrrad', inheritBucket: true, effectiveBucket: 'need' });

    const patched = await app.inject({ method: 'PATCH', url: `/api/categories/${created.json().id}`, payload: { bucket: null } });
    expect(patched.json()).toMatchObject({ inheritBucket: false, effectiveBucket: null });

    const bad = await app.inject({ method: 'PATCH', url: `/api/categories/${created.json().id}`, payload: { bucket: 'luxus' } });
    expect(bad.statusCode).toBe(400);

    const del = await app.inject({ method: 'DELETE', url: `/api/categories/${created.json().id}` });
    expect(del.statusCode).toBe(204);
  });

  it('meldet doppelte Namen mit 409', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/categories', payload: { name: 'Lebensmittel' } });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatch(/gibt es bereits/);
  });
});

describe('Regeln-API und Kategorisieren', () => {
  it('zeigt Vorschau, legt Regel an, wendet sie an und zählt Treffer', async () => {
    const target = await categoryId('Lebensmittel');
    const preview = await app.inject({
      method: 'POST',
      url: '/api/rules/preview',
      payload: { field: 'counterparty', patternType: 'contains', pattern: 'Bäckerei' },
    });
    expect(preview.json()).toMatchObject({ matchCount: 2, uncategorizedCount: 2 });

    const rule = await app.inject({
      method: 'POST',
      url: '/api/rules',
      payload: { field: 'counterparty', patternType: 'contains', pattern: 'Bäckerei', categoryId: target },
    });
    expect(rule.statusCode).toBe(201);

    const apply = await app.inject({ method: 'POST', url: '/api/rules/apply' });
    expect(apply.json()).toEqual({ categorized: 2 });

    const rules = (await app.inject({ method: 'GET', url: '/api/rules' })).json();
    expect(rules[0]).toMatchObject({ matchCount: 2, assignedCount: 2, categoryPath: 'Lebensmittel' });

    const filtered = await app.inject({ method: 'GET', url: `/api/transactions?categoryId=${target}` });
    expect(filtered.json().total).toBe(2);

    const removed = await app.inject({ method: 'DELETE', url: `/api/rules/${rule.json().id}?unassign=true` });
    expect(removed.json()).toEqual({ unassigned: 2 });
  });

  it('lehnt einen unbekannten Mustertyp ab', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/rules',
      payload: { field: 'counterparty', patternType: 'regex', pattern: 'x', categoryId: 1 },
    });
    expect(res.statusCode).toBe(400);
  });

  it('kategorisiert von Hand, liefert Regelvorschlag und hebt Handarbeit wieder auf', async () => {
    const list = (await app.inject({ method: 'GET', url: '/api/transactions?uncategorized=true' })).json();
    expect(list.total).toBe(10);
    const tx = list.items.find((t: { counterparty: string }) => t.counterparty === 'Vermieter Beispiel');

    const put = await app.inject({
      method: 'PUT',
      url: `/api/transactions/${tx.id}/category`,
      payload: { categoryId: await categoryId('Wohnen & Nebenkosten') },
    });
    expect(put.statusCode).toBe(200);
    expect(put.json()).toMatchObject({
      transaction: { categorySource: 'manual', categoryPath: 'Wohnen & Nebenkosten' },
      suggestion: { pattern: 'Vermieter Beispiel', patternType: 'contains' },
    });

    const summary = (await app.inject({ method: 'GET', url: '/api/transactions/uncategorized' })).json();
    expect(summary.count).toBe(9);

    const reset = await app.inject({ method: 'DELETE', url: `/api/transactions/${tx.id}/category` });
    expect(reset.json()).toMatchObject({ categoryId: null, categorySource: null });
  });

  it('meldet unbekannte Buchungen mit 404', async () => {
    const res = await app.inject({ method: 'PUT', url: '/api/transactions/9999/category', payload: { categoryId: null } });
    expect(res.statusCode).toBe(404);
  });
});
