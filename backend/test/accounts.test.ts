import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { createTestDb } from './helpers/db.js';

// Synthetische IBANs mit gültiger Prüfziffer (erfundene BLZ 12345678).
const IBAN_A = 'DE17123456780000000001';
const IBAN_B = 'DE87123456780000000002';

let app: FastifyInstance;

beforeEach(() => {
  app = buildApp({ db: createTestDb() });
});

afterEach(async () => {
  await app.close();
});

async function create(body: Record<string, unknown>) {
  return app.inject({ method: 'POST', url: '/api/accounts', payload: body });
}

async function patch(id: number, body: Record<string, unknown>) {
  return app.inject({ method: 'PATCH', url: `/api/accounts/${id}`, payload: body });
}

describe('Konten-API', () => {
  it('liefert die wählbaren Adapter und Rollen', async () => {
    const adapters = await app.inject({ method: 'GET', url: '/api/bank-adapters' });
    expect(adapters.json().map((a: { id: string }) => a.id)).toEqual(['volksbank-owl', 'comdirect']);

    const roles = await app.inject({ method: 'GET', url: '/api/account-roles' });
    expect(roles.json()).toEqual(['einnahmen', 'ausgaben', 'sparen', 'kreditkarte']);
  });

  it('legt ein Konto mit Rolle, Adapter und normalisierter IBAN an', async () => {
    const res = await create({
      name: '  Girokonto  ',
      role: 'einnahmen',
      bankAdapter: 'volksbank-owl',
      iban: 'de17 1234 5678 0000 0000 01',
    });

    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({
      id: expect.any(Number),
      name: 'Girokonto',
      role: 'einnahmen',
      bankAdapter: 'volksbank-owl',
      iban: IBAN_A,
      active: true,
    });
  });

  it('erlaubt mehrere Konten bei derselben Bank und mit gleichem Namen', async () => {
    expect((await create({ name: 'Girokonto', role: 'einnahmen', bankAdapter: 'volksbank-owl' })).statusCode).toBe(201);
    expect((await create({ name: 'Sparkonto', role: 'sparen', bankAdapter: 'volksbank-owl' })).statusCode).toBe(201);
    expect((await create({ name: 'Girokonto', role: 'ausgaben', bankAdapter: 'comdirect' })).statusCode).toBe(201);

    const list = await app.inject({ method: 'GET', url: '/api/accounts' });
    expect(list.json()).toHaveLength(3);
  });

  it('übernimmt die gewählte Rolle unabhängig von Name und Bank', async () => {
    const res = await create({ name: 'Comdirect Giro', role: 'kreditkarte', bankAdapter: 'comdirect' });
    expect(res.json().role).toBe('kreditkarte');
  });

  it('lehnt unbekannte Rollen und Adapter mit deutscher Meldung ab', async () => {
    const badRole = await create({ name: 'X', role: 'depot', bankAdapter: 'comdirect' });
    expect(badRole.statusCode).toBe(400);
    expect(badRole.json().error).toContain('Unbekannte Rolle');

    const badAdapter = await create({ name: 'X', role: 'sparen', bankAdapter: 'sparkasse' });
    expect(badAdapter.statusCode).toBe(400);
    expect(badAdapter.json().error).toContain('Unbekannter Bank-Adapter');
  });

  it('lehnt leere Namen, ungültige IBANs und fehlende Felder ab', async () => {
    expect((await create({ name: '   ', role: 'sparen', bankAdapter: 'comdirect' })).statusCode).toBe(400);

    const badIban = await create({ name: 'X', role: 'sparen', bankAdapter: 'comdirect', iban: 'DE00123456780000000001' });
    expect(badIban.statusCode).toBe(400);
    expect(badIban.json().error).toContain('keine gültige IBAN');

    expect((await create({ name: 'X', role: 'sparen' })).statusCode).toBe(400);
  });

  it('behandelt eine leere IBAN als „keine IBAN“', async () => {
    const res = await create({ name: 'X', role: 'sparen', bankAdapter: 'comdirect', iban: '  ' });
    expect(res.json().iban).toBeNull();
  });

  it('verhindert dieselbe IBAN an zwei Konten', async () => {
    await create({ name: 'A', role: 'einnahmen', bankAdapter: 'volksbank-owl', iban: IBAN_A });
    const res = await create({ name: 'B', role: 'sparen', bankAdapter: 'volksbank-owl', iban: IBAN_A });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toContain('„A“');
  });

  it('benennt um und ändert Rolle, Adapter und IBAN nachträglich', async () => {
    const { id } = (await create({ name: 'Alt', role: 'einnahmen', bankAdapter: 'volksbank-owl', iban: IBAN_A })).json();

    const res = await patch(id, { name: 'Neu', role: 'ausgaben', bankAdapter: 'comdirect', iban: IBAN_B });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ name: 'Neu', role: 'ausgaben', bankAdapter: 'comdirect', iban: IBAN_B });

    const cleared = await patch(id, { iban: null });
    expect(cleared.json().iban).toBeNull();
  });

  it('lässt die eigene IBAN beim Ändern anderer Felder stehen', async () => {
    const { id } = (await create({ name: 'A', role: 'einnahmen', bankAdapter: 'volksbank-owl', iban: IBAN_A })).json();
    const res = await patch(id, { name: 'A2', iban: IBAN_A });
    expect(res.statusCode).toBe(200);
    expect(res.json().iban).toBe(IBAN_A);
  });

  it('deaktiviert und reaktiviert statt zu löschen', async () => {
    const { id } = (await create({ name: 'Visa', role: 'kreditkarte', bankAdapter: 'volksbank-owl' })).json();

    expect((await patch(id, { active: false })).json().active).toBe(false);
    expect((await app.inject({ method: 'GET', url: `/api/accounts/${id}` })).json().active).toBe(false);
    expect((await patch(id, { active: true })).json().active).toBe(true);

    const del = await app.inject({ method: 'DELETE', url: `/api/accounts/${id}` });
    expect(del.statusCode).toBe(404);
  });

  it('listet aktive Konten vor deaktivierten', async () => {
    const { id } = (await create({ name: 'Aaa', role: 'sparen', bankAdapter: 'comdirect' })).json();
    await create({ name: 'Zzz', role: 'sparen', bankAdapter: 'comdirect' });
    await patch(id, { active: false });

    const names = (await app.inject({ method: 'GET', url: '/api/accounts' })).json().map((a: { name: string }) => a.name);
    expect(names).toEqual(['Zzz', 'Aaa']);
  });

  it('meldet 404 für unbekannte Konten', async () => {
    const res = await patch(999, { name: 'X' });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toContain('existiert nicht');
  });
});
