/**
 * Erzeugt synthetische Volksbank-Exporte (UTF-8 mit BOM, 18 Spalten wie
 * docs/bankformate.md § 1) für Tests, die viele Monate brauchen. Das
 * Encoding-Verhalten des Adapters prüfen die festen Fixtures; hier geht
 * es um den Inhalt.
 */

export interface VbRow {
  /** Buchungstag `YYYY-MM-DD`. */
  date: string;
  amountCents: number;
  counterparty?: string;
  counterpartyIban?: string;
  bookingText?: string;
  purpose?: string;
  creditorId?: string;
  mandateReference?: string;
}

const HEADER = [
  'Bezeichnung Auftragskonto',
  'IBAN Auftragskonto',
  'BIC Auftragskonto',
  'Bankname Auftragskonto',
  'Buchungstag',
  'Valutadatum',
  'Name Zahlungsbeteiligter',
  'IBAN Zahlungsbeteiligter',
  'BIC (SWIFT-Code) Zahlungsbeteiligter',
  'Buchungstext',
  'Verwendungszweck',
  'Betrag',
  'Waehrung',
  'Saldo nach Buchung',
  'Bemerkung',
  'Gekennzeichneter Umsatz',
  'Glaeubiger ID',
  'Mandatsreferenz',
].join(';');

/** Cent → deutscher Betrag (`-1.234,56`), ohne Float. */
export function germanAmount(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  const euros = String(Math.floor(abs / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return `${sign}${euros},${String(abs % 100).padStart(2, '0')}`;
}

const german = (iso: string) => `${iso.slice(8, 10)}.${iso.slice(5, 7)}.${iso.slice(0, 4)}`;

/** Export eines Kontos, neueste Buchung zuerst, mit Saldo-Kette ab `openingCents`. */
export function volksbankCsv(iban: string, rows: VbRow[], openingCents = 0): Uint8Array {
  const sorted = rows.map((r, i) => ({ r, i })).sort((a, b) => a.r.date.localeCompare(b.r.date) || a.i - b.i);
  let balance = openingCents;
  const lines = sorted.map(({ r }) => {
    balance += r.amountCents;
    return [
      'Testkonto',
      iban,
      'GENODEM1GTL',
      'Volksbank in Ostwestfalen eG',
      german(r.date),
      german(r.date),
      r.counterparty ?? '',
      r.counterpartyIban ?? '',
      '',
      r.bookingText ?? 'Lastschrift',
      r.purpose ?? '',
      germanAmount(r.amountCents),
      'EUR',
      germanAmount(balance),
      '',
      '',
      r.creditorId ?? '',
      r.mandateReference ?? '',
    ].join(';');
  });
  const text = `﻿${[HEADER, ...lines.reverse()].join('\r\n')}\r\n`;
  return new TextEncoder().encode(text);
}
