import { describe, expect, it } from 'vitest';
import {
  cardDebitHint,
  findCardPeriod,
  findStatementPeriod,
  looksLikeCardCredit,
  matchPairs,
  oneSidedEvidence,
  statementDateIn,
  type OwnAccount,
  type TransferCandidate,
} from '../src/services/transfer-detection.js';
import { IBAN } from './helpers/fixtures.js';

const accounts: OwnAccount[] = [
  { id: 1, name: 'Giro', role: 'einnahmen', iban: IBAN.volksbankGiro },
  { id: 2, name: 'Ausgaben', role: 'ausgaben', iban: IBAN.comdirectGiro },
  { id: 3, name: 'Spar', role: 'sparen', iban: IBAN.volksbankSpar },
  { id: 4, name: 'Visa', role: 'kreditkarte', iban: IBAN.volksbankVisa },
  { id: 5, name: 'Ohne IBAN', role: 'sparen', iban: null },
];

let nextId = 1;
function tx(accountId: number, bookingDate: string, amountCents: number, extra: Partial<TransferCandidate> = {}): TransferCandidate {
  return { id: nextId++, accountId, bookingDate, amountCents, counterparty: '', counterpartyIban: null, purpose: '', ...extra };
}

describe('matchPairs', () => {
  it('paart gleichen Betrag mit umgekehrtem Vorzeichen innerhalb weniger Tage', () => {
    const debit = tx(1, '2026-09-11', -123456);
    const credit = tx(2, '2026-09-12', 123456);
    expect(matchPairs([debit, credit], accounts)).toEqual([
      { debitId: debit.id, creditId: credit.id, reason: 'Betrag passt, 1 Tag(e) Abstand' },
    ]);
  });

  it('paart nicht über mehr als fünf Tage, nicht auf demselben Konto, nicht bei anderem Betrag', () => {
    expect(matchPairs([tx(1, '2026-09-01', -5000), tx(2, '2026-09-07', 5000)], accounts)).toEqual([]);
    expect(matchPairs([tx(1, '2026-09-01', -5000), tx(1, '2026-09-01', 5000)], accounts)).toEqual([]);
    expect(matchPairs([tx(1, '2026-09-01', -5000), tx(2, '2026-09-01', 5001)], accounts)).toEqual([]);
    expect(matchPairs([tx(1, '2026-09-01', -5000), tx(2, '2026-09-06', 5000)], accounts)).toHaveLength(1);
  });

  it('paart nicht, wenn die Gegen-IBAN zu einem fremden Konto gehört', () => {
    const toErika = tx(1, '2026-09-14', -5000, { counterpartyIban: 'DE02120300000000202051' });
    const fromErika = tx(2, '2026-09-15', 5000);
    expect(matchPairs([toErika, fromErika], accounts)).toEqual([]);
  });

  it('bevorzugt die passende IBAN vor dem kleineren Datumsabstand und nimmt jede Buchung nur einmal', () => {
    const toSpar = tx(1, '2026-09-11', -10000, { counterpartyIban: IBAN.volksbankSpar });
    const ausgabenSameDay = tx(2, '2026-09-11', 10000);
    const sparLater = tx(3, '2026-09-13', 10000);
    const pairs = matchPairs([toSpar, ausgabenSameDay, sparLater], accounts);
    expect(pairs).toHaveLength(1);
    expect(pairs[0]).toMatchObject({ debitId: toSpar.id, creditId: sparLater.id });
    expect(pairs[0]?.reason).toContain('Gegen-IBAN');
  });

  it('lässt Kreditkartenkonten aus (dort gilt die Kartenabrechnung)', () => {
    expect(matchPairs([tx(1, '2026-10-05', -10235), tx(4, '2026-10-05', 10235)], accounts)).toEqual([]);
  });
});

describe('oneSidedEvidence', () => {
  it('erkennt die eigene IBAN als Gegen-IBAN', () => {
    const t = tx(3, '2026-08-11', 10000, { counterpartyIban: IBAN.volksbankGiro });
    expect(oneSidedEvidence(t, accounts)).toEqual({ transactionId: t.id, otherAccountId: 1, reason: 'Gegen-IBAN gehört zum Konto „Giro“' });
  });

  it('erkennt eine eigene IBAN im Text, auch mit Leerzeichen', () => {
    const t = tx(2, '2026-09-02', -5000, { purpose: 'Kto/IBAN: DE60 1234 5678 0000 0000 03 Rücklage' });
    expect(oneSidedEvidence(t, accounts)).toMatchObject({ otherAccountId: 3 });
  });

  it('erkennt Umbuchungen am Verwendungszweck', () => {
    expect(oneSidedEvidence(tx(1, '2026-09-21', -2500, { purpose: 'Umbuchung Tagesgeld' }), accounts)).toMatchObject({
      otherAccountId: null,
      reason: 'Verwendungszweck enthält „Umbuchung“',
    });
    expect(oneSidedEvidence(tx(1, '2026-09-21', -2500, { purpose: 'Übertrag auf eigenes Konto' }), accounts)).not.toBeNull();
    expect(oneSidedEvidence(tx(1, '2026-09-21', -2500, { purpose: 'Miete Musterstr. 5' }), accounts)).toBeNull();
  });

  it('nimmt nie Kartenumsätze als Umbuchung', () => {
    expect(oneSidedEvidence(tx(4, '2026-09-21', -2500, { purpose: 'UMBUCHUNG REISEBUERO' }), accounts)).toBeNull();
  });
});

describe('Kartenabrechnung erkennen', () => {
  const visa = accounts[3] as OwnAccount;

  it('erkennt den Ausgleich auf dem Kartenkonto', () => {
    expect(looksLikeCardCredit(tx(4, '2026-10-05', 10235, { purpose: 'AUSGLEICH KARTENKONTO' }), visa, accounts)).toBe(true);
    expect(looksLikeCardCredit(tx(4, '2026-10-05', 1999, { purpose: 'GUTSCHRIFT HAENDLER' }), visa, accounts)).toBe(false);
    expect(looksLikeCardCredit(tx(4, '2026-10-05', -1999, { purpose: 'AUSGLEICH' }), visa, accounts)).toBe(false);
  });

  it('unterscheidet starke (IBAN) und schwache (Begriff) Hinweise auf der Abbuchung', () => {
    expect(cardDebitHint(tx(1, '2026-10-05', -10235, { counterpartyIban: IBAN.volksbankVisa }), visa, accounts)).toBe('iban');
    expect(cardDebitHint(tx(1, '2026-10-05', -10235, { purpose: 'Abrechnung Kreditkarte 09/2026' }), visa, accounts)).toBe('word');
    expect(cardDebitHint(tx(2, '2026-10-01', -190, { purpose: 'Entgelt Visa-Kreditkarte' }), visa, accounts)).toBe('word');
    expect(cardDebitHint(tx(1, '2026-10-05', -10235, { purpose: 'Miete' }), visa, accounts)).toBeNull();
    // Nennt ein anderes eigenes Konto: keine Kartenabrechnung.
    expect(cardDebitHint(tx(1, '2026-10-05', -10235, { purpose: 'Visa', counterpartyIban: IBAN.volksbankSpar }), visa, accounts)).toBeNull();
  });
});

describe('findCardPeriod', () => {
  const purchases = [
    { bookingDate: '2026-09-10', amountCents: -4210 },
    { bookingDate: '2026-09-20', amountCents: -1525 },
    { bookingDate: '2026-09-28', amountCents: -4500 },
    { bookingDate: '2026-10-03', amountCents: -1999 },
  ];

  it('findet den Zeitraum, dessen Kartenumsätze genau die Abbuchung ergeben', () => {
    expect(findCardPeriod(purchases, 10235, '2026-10-05', null)).toEqual({
      start: '2026-09-10',
      end: '2026-09-28',
      sumCents: 10235,
      exact: true,
    });
  });

  it('beginnt nach der vorigen Abrechnung und rechnet Erstattungen gegen', () => {
    const withRefund = [...purchases, { bookingDate: '2026-09-22', amountCents: 1000 }];
    expect(findCardPeriod(withRefund, 5025, '2026-10-05', '2026-09-15')).toEqual({
      start: '2026-09-15',
      end: '2026-09-28',
      sumCents: 5025,
      exact: true,
    });
  });

  it('teilt nie einen Kauftag und zählt Käufe am Abbuchungstag nicht mit', () => {
    const sameDay = [
      { bookingDate: '2026-09-10', amountCents: -1000 },
      { bookingDate: '2026-09-10', amountCents: -500 },
      { bookingDate: '2026-10-05', amountCents: -700 },
    ];
    expect(findCardPeriod(sameDay, 1000, '2026-10-05', null).exact).toBe(false);
    expect(findCardPeriod(sameDay, 1500, '2026-10-05', null)).toMatchObject({ exact: true, end: '2026-09-10' });
  });

  it('fällt ohne passende Summe auf den ganzen Zeitraum bis zum Vortag zurück', () => {
    expect(findCardPeriod(purchases, 25000, '2026-10-05', null)).toEqual({
      start: '2026-09-10',
      end: '2026-10-04',
      sumCents: 12234,
      exact: false,
    });
    expect(findCardPeriod([], 25000, '2026-10-05', null)).toMatchObject({ start: '2026-09-04', end: '2026-10-04', sumCents: 0 });
  });
});

describe('Abrechnungsdatum', () => {
  it('liest „Abrechnung vom TT.MM.JJJJ“ aus dem Text', () => {
    expect(statementDateIn('AUSGLEICH KARTENKONTO Abrechnung vom 18.09.2026')).toBe('2026-09-18');
    expect(statementDateIn('ABRECHNUNG VOM  01.10.2026 VISA')).toBe('2026-10-01');
    expect(statementDateIn('Abrechnung Kreditkarte 09/2026')).toBeNull();
    expect(statementDateIn('Abrechnung vom 31.02.2026')).toBeNull();
  });
});

describe('findStatementPeriod', () => {
  // Kaufdatum und Buchungstag der Bank weichen ab.
  const purchases = [
    { bookingDate: '2026-08-04', bankBookingDate: '2026-08-05', amountCents: -8000 },
    { bookingDate: '2026-08-17', bankBookingDate: '2026-08-19', amountCents: -3000 },
    { bookingDate: '2026-08-25', bankBookingDate: '2026-08-26', amountCents: -12050 },
    { bookingDate: '2026-09-10', bankBookingDate: '2026-09-11', amountCents: -4790 },
    // Kauf vor, Buchung nach dem Abrechnungsdatum: gehört zur nächsten Abrechnung.
    { bookingDate: '2026-09-17', bankBookingDate: '2026-09-19', amountCents: -6499 },
  ];

  it('nimmt Kartenumsätze nach Buchungstag der Bank bis einschließlich Abrechnungsdatum', () => {
    expect(findStatementPeriod(purchases, 19840, '2026-09-18', '2026-08-19')).toEqual({
      start: '2026-08-19',
      end: '2026-09-18',
      sumCents: 19840,
      exact: true,
    });
    // Das Verfahren nach Kaufdatum hätte den Kauf vom 17.09. mitgezählt.
    expect(findCardPeriod(purchases, 19840, '2026-09-22', '2026-08-19').exact).toBe(false);
  });

  it('sucht ohne vorige Abrechnung den Beginn, ab dem die Summe passt', () => {
    expect(findStatementPeriod(purchases, 8000, '2026-08-18', null)).toEqual({
      start: '2026-08-05',
      end: '2026-08-18',
      sumCents: 8000,
      exact: true,
    });
  });

  it('meldet eine Abweichung und beginnt ersatzweise nach demselben Tag im Vormonat', () => {
    expect(findStatementPeriod(purchases, 99999, '2026-09-18', null)).toEqual({
      start: '2026-08-19',
      end: '2026-09-18',
      sumCents: 19840,
      exact: false,
    });
  });

  it('zählt Altbestand ohne Buchungstag mit dem Kaufdatum', () => {
    expect(findStatementPeriod([{ bookingDate: '2026-09-01', amountCents: -1000 }], 1000, '2026-09-18', '2026-08-19')).toMatchObject({
      exact: true,
    });
  });
});
