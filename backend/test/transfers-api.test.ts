import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { createTestDb } from './helpers/db.js';
import { fixture, IBAN } from './helpers/fixtures.js';

let app: FastifyInstance;
const ids: Record<string, number> = {};

async function account(name: string, role: string, bankAdapter: string, iban: string): Promise<number> {
  const res = await app.inject({ method: 'POST', url: '/api/accounts', payload: { name, role, bankAdapter, iban } });
  return res.json().id;
}

function upload(accountId: number, path: string) {
  return app.inject({
    method: 'POST',
    url: `/api/accounts/${accountId}/imports?fileName=${encodeURIComponent(path)}`,
    headers: { 'content-type': 'application/octet-stream' },
    payload: Buffer.from(fixture(path)),
  });
}

beforeEach(async () => {
  app = buildApp({ db: createTestDb() });
  ids['giro'] = await account('Giro', 'einnahmen', 'volksbank-owl', IBAN.volksbankGiro);
  ids['ausgaben'] = await account('Ausgaben', 'ausgaben', 'comdirect', IBAN.comdirectGiro);
  ids['visa'] = await account('Visa', 'kreditkarte', 'volksbank-owl', IBAN.volksbankVisa);
  await upload(ids['giro'], 'umbuchungen/giro.csv');
  await upload(ids['ausgaben'], 'umbuchungen/comdirect.csv');
});

afterEach(async () => {
  await app.close();
});

describe('Umbuchungen-API', () => {
  it('meldet erkannte Umbuchungen beim Import und listet sie', async () => {
    const res = await upload(ids['visa'] as number, 'umbuchungen/visa.csv');
    expect(res.json()).toMatchObject({ transfersDetected: 1 });

    const transfers = (await app.inject({ method: 'GET', url: '/api/transfers' })).json() as { kind: string; status: string }[];
    // Kein Sparkonto angelegt: die Sparrate bleibt eine Ausgabe.
    expect(transfers.map((t) => t.kind).sort()).toEqual(['card_settlement', 'one_sided', 'pair']);
    const suggested = (await app.inject({ method: 'GET', url: '/api/transfers?status=suggested' })).json();
    expect(suggested).toHaveLength(3);
  });

  it('bestätigt, hebt auf und markiert von Hand', async () => {
    const list = (await app.inject({ method: 'GET', url: `/api/transactions?accountId=${ids['giro']}&transfers=only` })).json();
    const dauerauftrag = list.items.find((t: { amountCents: number }) => t.amountCents === -123456);
    expect(dauerauftrag).toMatchObject({ transferKind: 'pair', transferAccountName: 'Ausgaben' });

    const confirmed = await app.inject({ method: 'POST', url: `/api/transfers/${dauerauftrag.transferId}/confirm` });
    expect(confirmed.json()).toMatchObject({ status: 'confirmed' });

    const dissolved = await app.inject({ method: 'DELETE', url: `/api/transfers/${dauerauftrag.transferId}` });
    expect(dissolved.json()).toEqual({ released: 2 });

    // Die Gegenbuchung ist nach dem Aufheben als „keine Umbuchung“ markiert – sie wird nicht angetastet.
    const marked = await app.inject({ method: 'PUT', url: `/api/transactions/${dauerauftrag.id}/transfer`, payload: { accountId: ids['ausgaben'] } });
    expect(marked.json()).toMatchObject({ kind: 'one_sided', origin: 'manual', status: 'confirmed', toAccountName: 'Ausgaben' });

    const unmarked = await app.inject({ method: 'DELETE', url: `/api/transactions/${dauerauftrag.id}/transfer` });
    expect(unmarked.statusCode).toBe(204);

    const reset = await app.inject({ method: 'POST', url: `/api/transactions/${dauerauftrag.id}/transfer/reset` });
    expect(reset.json()).toMatchObject({ created: 1 });

    const missing = await app.inject({ method: 'POST', url: '/api/transfers/9999/confirm' });
    expect(missing.statusCode).toBe(404);
  });

  it('bestätigt gesammelt alle Paare mit eigener Gegen-IBAN und nennt die Anzahl vorher', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/transfers/own-iban-pairs' })).json()).toEqual({ count: 1 });
    expect((await app.inject({ method: 'POST', url: '/api/transfers/own-iban-pairs/confirm' })).json()).toEqual({ confirmed: 1 });
    expect((await app.inject({ method: 'GET', url: '/api/transfers/own-iban-pairs' })).json()).toEqual({ count: 0 });
    const confirmed = (await app.inject({ method: 'GET', url: '/api/transfers?status=confirmed' })).json();
    expect(confirmed).toMatchObject([{ kind: 'pair', amountCents: 123456 }]);
  });

  it('rechnet Umbuchungen aus der Leiste der unkategorisierten Buchungen heraus', async () => {
    const summary = (await app.inject({ method: 'GET', url: '/api/transactions/uncategorized' })).json();
    // Giro: Gehalt, Miete, Erika, Sparrate (kein Sparkonto angelegt), Kreditkarte (noch keine Kartenumsätze);
    // Ausgabenkonto: Versicherung, Rückzahlung. Dauerauftrag und Tagesgeld zählen nicht.
    expect(summary).toEqual({ count: 7, inflowCents: 285000 + 5000, outflowCents: -95000 - 5000 - 10000 - 10235 - 2788 });
  });
});
