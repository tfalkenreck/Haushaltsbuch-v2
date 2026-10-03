import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { createTestDb } from './helpers/db.js';
import { fixture, IBAN } from './helpers/fixtures.js';

let app: FastifyInstance;
let giro: number;
let ausgaben: number;

async function account(name: string, role: string, bankAdapter: string, iban: string): Promise<number> {
  const res = await app.inject({ method: 'POST', url: '/api/accounts', payload: { name, role, bankAdapter, iban } });
  return res.json().id;
}

function upload(accountId: number, path: string) {
  return app.inject({
    method: 'POST',
    url: `/api/accounts/${accountId}/imports?fileName=${encodeURIComponent(path)}&periodStart=2026-05-01&periodEnd=2026-09-30`,
    headers: { 'content-type': 'application/octet-stream' },
    payload: Buffer.from(fixture(path)),
  });
}

beforeEach(async () => {
  app = buildApp({ db: createTestDb() });
  giro = await account('Giro', 'einnahmen', 'volksbank-owl', IBAN.volksbankGiro);
  ausgaben = await account('Ausgaben', 'ausgaben', 'comdirect', IBAN.comdirectGiro);
  expect((await upload(giro, 'deckung/giro.csv')).statusCode).toBe(201);
  expect((await upload(ausgaben, 'deckung/comdirect.csv')).statusCode).toBe(201);
});

afterEach(async () => {
  await app.close();
});

describe('Deckungs-API', () => {
  it('liefert die Deckungsprüfung eines Kontos', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/accounts/${ausgaben}/funding` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ accountName: 'Ausgaben', standingOrdersTotalCents: 21500, trend: { deficitSince: '2026-07' } });
    expect((await app.inject({ method: 'GET', url: '/api/accounts/999/funding' })).statusCode).toBe(404);
  });

  it('erfasst und löscht Kontostände von Hand', async () => {
    const created = await app.inject({
      method: 'POST',
      url: `/api/accounts/${ausgaben}/balances`,
      payload: { date: '2026-09-30', amount: '1.150,00', notes: 'laut Online-Banking' },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ date: '2026-09-30', balanceCents: 115000, notes: 'laut Online-Banking' });

    const accounts = (await app.inject({ method: 'GET', url: '/api/accounts' })).json();
    expect(accounts.find((a: { id: number }) => a.id === ausgaben)).toMatchObject({ balanceCents: 115000, balanceSource: 'manual' });

    const bad = await app.inject({ method: 'POST', url: `/api/accounts/${ausgaben}/balances`, payload: { date: '2026-09-30', amount: 'viel' } });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error).toMatch(/kein Betrag/);

    const id = created.json().id;
    expect((await app.inject({ method: 'DELETE', url: `/api/balances/${id}` })).statusCode).toBe(204);
    expect((await app.inject({ method: 'GET', url: `/api/accounts/${ausgaben}/balances` })).json()).toEqual([]);
    expect((await app.inject({ method: 'DELETE', url: `/api/balances/${id}` })).statusCode).toBe(404);
  });

  it('listet Ausgaben am Ausgabenkonto vorbei und speichert Entscheidungen', async () => {
    const overview = (await app.inject({ method: 'GET', url: '/api/bypass' })).json();
    const telefon = overview.items.find((i: { label: string }) => i.label === 'Beispiel Telefon GmbH');
    const res = await app.inject({
      method: 'PUT',
      url: '/api/bypass/decision',
      payload: { sourceAccountId: giro, key: telefon.key, decision: 'move' },
    });
    expect(res.json().plannedIncreases).toEqual([{ accountId: ausgaben, accountName: 'Ausgaben', count: 1, monthlyCents: 3999 }]);

    const invalid = await app.inject({
      method: 'PUT',
      url: '/api/bypass/decision',
      payload: { sourceAccountId: giro, key: telefon.key, decision: 'vielleicht' },
    });
    expect(invalid.statusCode).toBe(400);
  });
});
