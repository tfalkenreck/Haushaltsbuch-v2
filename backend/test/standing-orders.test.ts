import { describe, expect, it } from 'vitest';
import { detectStandingOrders, endedSince, type IncomingTransfer } from '../src/services/standing-orders.js';

let nextId = 1;
const t = (date: string, amountCents: number, extra: Partial<IncomingTransfer> = {}): IncomingTransfer => ({
  transactionId: nextId++,
  date,
  amountCents,
  sourceAccountId: 1,
  text: '',
  ...extra,
});

describe('detectStandingOrders', () => {
  it('trennt mehrere Daueraufträge am selben Tag, auch mit gleichem Betrag, und verfolgt Änderungen', () => {
    const transfers = ['2026-07', '2026-08', '2026-09'].flatMap((m) => [
      t(`${m}-11`, 1000),
      t(`${m}-11`, m === '2026-09' ? 7000 : 6000),
      t(`${m}-11`, 1000),
      t(`${m}-11`, 10000),
    ]);
    const { orders, extraTransactionIds } = detectStandingOrders(transfers, '2026-09-30');
    expect(orders.map((o) => [o.dayOfMonth, o.amountCents, o.occurrences.length, o.changes.length])).toEqual([
      [11, 10000, 3, 0],
      [11, 7000, 3, 1],
      [11, 1000, 3, 0],
      [11, 1000, 3, 0],
    ]);
    expect(orders[1]?.changes).toEqual([{ date: '2026-09-11', fromCents: 6000, toCents: 7000 }]);
    expect(extraTransactionIds).toEqual([]);
  });

  it('toleriert Verschiebungen auf den nächsten Bankarbeitstag, auch über das Monatsende', () => {
    const { orders } = detectStandingOrders(
      [t('2026-08-31', 5000), t('2026-10-01', 5000), t('2026-10-30', 5000), t('2026-11-30', 5000)],
      '2026-11-30',
    );
    expect(orders).toHaveLength(1);
    // Der 01.10. ist die Ausführung für September.
    expect(orders[0]?.occurrences.map((o) => o.month)).toEqual(['2026-08', '2026-09', '2026-10', '2026-11']);
    expect(orders[0]?.dayOfMonth).toBe(30);
  });

  it('übersteht eine ausgelassene Ausführung', () => {
    const { orders } = detectStandingOrders([t('2026-06-11', 5000), t('2026-08-11', 5000), t('2026-09-11', 5000)], '2026-09-30');
    expect(orders).toHaveLength(1);
    expect(orders[0]?.occurrences).toHaveLength(3);
  });

  it('hält Daueraufträge von verschiedenen Konten auseinander', () => {
    const { orders } = detectStandingOrders(
      [t('2026-08-11', 5000), t('2026-09-11', 5000), t('2026-08-11', 5000, { sourceAccountId: 2 }), t('2026-09-11', 5000, { sourceAccountId: 2 })],
      '2026-09-30',
    );
    expect(orders.map((o) => o.sourceAccountId).sort()).toEqual([1, 2]);
  });

  it('erkennt beendete Daueraufträge', () => {
    const { orders } = detectStandingOrders([t('2026-06-11', 5000), t('2026-07-11', 5000)], '2026-09-30');
    expect(orders[0]?.active).toBe(false);
    expect(endedSince(orders[0]!)).toBe('2026-08');
    // Nächste Ausführung noch nicht fällig: läuft.
    expect(detectStandingOrders([t('2026-08-11', 5000), t('2026-09-11', 5000)], '2026-09-30').orders[0]?.active).toBe(true);
  });

  it('nimmt eine einzelne Umbuchung nur als (vermuteten) Dauerauftrag, wenn sie so heißt', () => {
    const single = t('2026-09-11', 5000, { text: 'Dauerauftrag Haushalt' });
    const extra = t('2026-09-15', 30000, { text: 'Zuschuss Urlaub' });
    const { orders, extraTransactionIds } = detectStandingOrders([single, extra], '2026-09-30');
    expect(orders).toMatchObject([{ suspected: true, amountCents: 5000 }]);
    expect(extraTransactionIds).toEqual([extra.transactionId]);
  });
});
