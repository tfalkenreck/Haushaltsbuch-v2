import { describe, expect, it } from 'vitest';
import { addMonths } from '../src/lib/date.js';
import { cancelInfo, checkItem, dueDatesBetween, type CheckBooking, type CheckItem } from '../src/services/recurring-check.js';

const item = (extra: Partial<CheckItem> = {}): CheckItem => ({
  amountCents: 999,
  interval: 'monthly',
  nextDueDate: '2026-10-07',
  contractEndDate: null,
  noticePeriodValue: null,
  noticePeriodUnit: null,
  active: true,
  ...extra,
});

let id = 1;
const monthly = (start: string, amounts: number[]): CheckBooking[] =>
  amounts.map((amountCents, i) => ({ transactionId: id++, date: addMonths(start, i), amountCents }));

const ctx = { dataEnd: '2026-09-30', covered: [{ start: '2026-01-01', end: '2026-09-30' }], today: '2026-10-03' };

describe('Termine', () => {
  it('rechnet Monatsenden ohne Drift und 14-tägig in Tagen', () => {
    expect(dueDatesBetween('2026-01-31', 'monthly', '2026-01-01', '2026-04-30')).toEqual(['2026-01-31', '2026-02-28', '2026-03-31', '2026-04-30']);
    expect(dueDatesBetween('2026-10-07', 'quarterly', '2026-01-01', '2026-12-31')).toEqual(['2026-01-07', '2026-04-07', '2026-07-07', '2026-10-07']);
    expect(dueDatesBetween('2026-06-05', 'biweekly', '2026-06-01', '2026-07-10')).toEqual(['2026-06-05', '2026-06-19', '2026-07-03']);
  });
});

describe('Soll/Ist-Abgleich', () => {
  it('ordnet jede Abbuchung ihrem Termin zu und nennt den nächsten Termin', () => {
    const check = checkItem(item(), monthly('2026-01-07', [999, 999, 999, 999, 999, 999, 999, 999, 999]), ctx);
    expect(check).toMatchObject({ status: 'ok', missingCount: 0, nextDueDate: '2026-10-07', scheduleFromBookings: false, extraBookings: [] });
    expect(check.occurrences).toHaveLength(9);
    expect(check.occurrences[0]).toMatchObject({ dueDate: '2026-09-07', state: 'ok', date: '2026-09-07' });
  });

  it('erkennt Preiserhöhungen und schlägt das neue Soll vor', () => {
    const check = checkItem(item(), monthly('2026-01-07', [999, 999, 999, 999, 999, 1299, 1299, 1299, 1299]), ctx);
    expect(check).toMatchObject({
      status: 'differs',
      suggestedAmountCents: 1299,
      priceChange: { date: '2026-06-07', fromCents: 999, toCents: 1299 },
    });
    expect(check.occurrences[0]).toMatchObject({ state: 'differs', amountCents: 1299 });
  });

  it('meldet eine fehlende Abbuchung, zwei in Folge als beendet', () => {
    const bookings = monthly('2026-01-07', [999, 999, 999, 999, 999, 999, 999, 999, 999]);
    // August fehlt, September da: fehlt mittendrin.
    const middle = bookings.filter((b) => b.date !== '2026-08-07');
    expect(checkItem(item(), middle, ctx)).toMatchObject({ status: 'ok', missingCount: 1 });
    // September fehlt.
    expect(checkItem(item(), bookings.slice(0, 8), ctx)).toMatchObject({ status: 'missing', missingCount: 1 });
    expect(checkItem(item(), bookings.slice(0, 7), ctx)).toMatchObject({ status: 'ended', missingCount: 2 });
  });

  it('wertet Termine in Importlücken nicht als fehlend', () => {
    const covered = [
      { start: '2026-01-01', end: '2026-06-30' },
      { start: '2026-08-01', end: '2026-09-30' },
    ];
    const bookings = monthly('2026-01-07', [999, 999, 999, 999, 999, 999, 999, 999, 999]).filter((b) => b.date !== '2026-07-07');
    const check = checkItem(item(), bookings, { ...ctx, covered });
    expect(check.status).toBe('ok');
    expect(check.occurrences.find((o) => o.dueDate === '2026-07-07')?.state).toBe('not_imported');
  });

  it('meldet einen Posten ohne passende Buchung (Konto nicht importiert, andere Schreibweise?)', () => {
    const check = checkItem(item({ nextDueDate: '2026-10-10', amountCents: 2000 }), [], ctx);
    expect(check.status).toBe('no_bookings');
    expect(check.occurrences.map((o) => [o.dueDate, o.state])).toEqual([
      ['2026-09-10', 'missing'],
      ['2026-08-10', 'missing'],
      ['2026-07-10', 'missing'],
    ]);
    expect(checkItem(item({ nextDueDate: '2026-10-10' }), [], { ...ctx, dataEnd: null, covered: [] }).status).toBe('not_due');
    expect(checkItem(item({ active: false }), [], ctx).status).toBe('inactive');
  });

  it('richtet sich nach den Buchungen, wenn der eingetragene Termin nicht passt', () => {
    const check = checkItem(item({ nextDueDate: '2026-10-20' }), monthly('2026-05-01', [999, 999, 999, 999, 999]), ctx);
    expect(check).toMatchObject({ status: 'ok', scheduleFromBookings: true, nextDueDate: '2026-11-01' });
  });

  it('zählt eine Abbuchung in der Toleranz am Ende der Importe schon mit', () => {
    const check = checkItem(item({ nextDueDate: '2026-09-28' }), monthly('2026-07-28', [999, 999, 999]), ctx);
    expect(check.occurrences.map((o) => o.dueDate)).toEqual(['2026-09-28', '2026-08-28', '2026-07-28']);
    expect(check.extraBookings).toEqual([]);
  });
});

describe('Kündigung zum Vertragsende', () => {
  it('rechnet die Frist und warnt rechtzeitig', () => {
    const contract = (contractEndDate: string, value: number | null, unit: 'days' | 'weeks' | 'months' | null) =>
      item({ contractEndDate, noticePeriodValue: value, noticePeriodUnit: unit });
    expect(cancelInfo(contract('2027-06-30', 3, 'months'), '2026-10-03')).toEqual({
      contractEndDate: '2027-06-30',
      cancelBy: '2027-03-30',
      state: 'open',
    });
    expect(cancelInfo(contract('2027-01-31', 3, 'months'), '2026-10-03')).toMatchObject({ cancelBy: '2026-10-31', state: 'soon' });
    expect(cancelInfo(contract('2026-12-31', 6, 'weeks'), '2026-12-01')).toMatchObject({ cancelBy: '2026-11-19', state: 'passed' });
    expect(cancelInfo(contract('2026-09-30', 14, 'days'), '2026-10-03')).toMatchObject({ state: 'expired' });
    expect(cancelInfo(item(), '2026-10-03')).toBeNull();
  });
});
