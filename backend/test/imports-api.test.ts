import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { createTestDb } from './helpers/db.js';
import { fixture, IBAN } from './helpers/fixtures.js';

let app: FastifyInstance;

beforeEach(() => {
  app = buildApp({ db: createTestDb() });
});

afterEach(async () => {
  await app.close();
});

async function createAccount(bankAdapter: string, iban: string | null, role = 'einnahmen'): Promise<number> {
  const res = await app.inject({ method: 'POST', url: '/api/accounts', payload: { name: 'Konto', role, bankAdapter, iban } });
  return res.json().id;
}

function upload(accountId: number, path: string, query = '') {
  return app.inject({
    method: 'POST',
    url: `/api/accounts/${accountId}/imports?fileName=${encodeURIComponent(path)}${query}`,
    headers: { 'content-type': 'application/octet-stream' },
    payload: Buffer.from(fixture(path)),
  });
}

describe('Import-API', () => {
  it('importiert eine Datei als rohe Bytes und listet den Importvorgang', async () => {
    const id = await createAccount('comdirect', IBAN.comdirectGiro, 'ausgaben');
    const res = await upload(id, 'comdirect/girokonto.csv');

    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ imported: 6, duplicates: 0, bankAdapter: 'comdirect', fileName: 'comdirect/girokonto.csv' });

    const batches = (await app.inject({ method: 'GET', url: `/api/imports?accountId=${id}` })).json();
    expect(batches).toHaveLength(1);
    expect(batches[0]).toMatchObject({ rowsImported: 6, transactionCount: 6, periodStart: '2026-09-22', periodEnd: '2026-10-02' });
  });

  it('antwortet 200 ohne Importvorgang, wenn alles schon da ist', async () => {
    const id = await createAccount('comdirect', IBAN.comdirectGiro, 'ausgaben');
    await upload(id, 'comdirect/girokonto.csv');
    const res = await upload(id, 'comdirect/girokonto.csv');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ batchId: null, imported: 0, duplicates: 6 });
  });

  it('meldet falsche Adapter mit deutscher Fehlermeldung', async () => {
    const id = await createAccount('comdirect', null, 'ausgaben');
    const res = await upload(id, 'volksbank-owl/giro.csv');
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/^Comdirect-Adapter erkennt keine Kopfzeile\. Verfügbar: volksbank-owl\./);
  });

  it('lehnt leere Uploads und ungültige Zeiträume ab', async () => {
    const id = await createAccount('comdirect', null, 'ausgaben');
    const empty = await app.inject({
      method: 'POST',
      url: `/api/accounts/${id}/imports`,
      headers: { 'content-type': 'application/octet-stream' },
      payload: Buffer.alloc(0),
    });
    expect(empty.statusCode).toBe(400);
    expect((await upload(id, 'comdirect/girokonto.csv', '&periodStart=03.10.2026')).statusCode).toBe(400);
    expect((await upload(id, 'comdirect/girokonto.csv', '&periodStart=2026-02-30')).json().error).toMatch(/kein gültiges Datum/);
  });

  it('meldet 404 für unbekannte Konten', async () => {
    expect((await upload(999, 'comdirect/girokonto.csv')).statusCode).toBe(404);
  });

  it('macht einen Import rückgängig', async () => {
    const id = await createAccount('volksbank-owl', IBAN.volksbankGiro);
    const { batchId } = (await upload(id, 'volksbank-owl/giro.csv')).json();

    const res = await app.inject({ method: 'DELETE', url: `/api/imports/${batchId}` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ batchId, deletedTransactions: 10 });

    const list = (await app.inject({ method: 'GET', url: '/api/transactions' })).json();
    expect(list.total).toBe(0);
    expect((await app.inject({ method: 'DELETE', url: `/api/imports/${batchId}` })).statusCode).toBe(404);
  });

  it('liefert die Abdeckung eines Kontos', async () => {
    const id = await createAccount('volksbank-owl', IBAN.volksbankGiro);
    await upload(id, 'volksbank-owl/giro.csv');
    const res = await app.inject({ method: 'GET', url: `/api/accounts/${id}/coverage` });
    expect(res.statusCode).toBe(200);
    expect(res.json().periods).toEqual([{ start: '2026-09-01', end: '2026-10-02' }]);
    expect(res.json().months[0]).toEqual({ month: '2026-09', status: 'complete', transactionCount: 8 });
  });

  it('zeigt Saldo und Zeitraum in der Kontoübersicht', async () => {
    const id = await createAccount('volksbank-owl', IBAN.volksbankVisa, 'kreditkarte');
    await upload(id, 'volksbank-owl/visa.csv');
    const account = (await app.inject({ method: 'GET', url: `/api/accounts/${id}` })).json();
    expect(account).toMatchObject({
      balanceCents: -13735,
      balanceDate: '2026-10-02',
      coverageStart: '2026-09-29', // Buchungstag der Bank, nicht Kaufdatum 28.09.
      coverageEnd: '2026-10-02',
      transactionCount: 4,
    });
  });
});

describe('Transaktions-API', () => {
  it('filtert und blättert', async () => {
    const id = await createAccount('volksbank-owl', IBAN.volksbankGiro);
    await upload(id, 'volksbank-owl/giro.csv');

    const res = await app.inject({ method: 'GET', url: `/api/transactions?accountId=${id}&q=b%C3%A4ckerei&limit=1` });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({ total: 2, limit: 1, offset: 0, inflowCents: 0, outflowCents: -640 });
    expect(body.items[0]).toMatchObject({ counterparty: 'Bäckerei Müller', accountName: 'Konto', amountCents: -320 });
  });

  it('lehnt ungültige Filter ab', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/transactions?from=01.09.2026' })).statusCode).toBe(400);
    expect((await app.inject({ method: 'GET', url: '/api/transactions?limit=0' })).statusCode).toBe(400);
  });
});
