import type { AccountRole } from '../api/accounts';
import type { Bucket } from '../api/categories';
import type { Interval } from '../api/funding';
import type { CheckStatus, NoticeUnit, RecurringKind } from '../api/recurring';
import type { PatternType, RuleField } from '../api/rules';
import type { CardDateField, CardRule, TransferKind } from '../api/transfers';

export const ROLE_LABELS: Record<AccountRole, string> = {
  einnahmen: 'Einnahmen',
  ausgaben: 'Ausgaben',
  sparen: 'Sparen',
  kreditkarte: 'Kreditkarte',
};

export const ROLE_DESCRIPTIONS: Record<AccountRole, string> = {
  einnahmen: 'Gehalt kommt an, ein Teil der Ausgaben läuft direkt darüber',
  ausgaben: 'Per Dauerauftrag gespeist, Fixkosten werden hier abgebucht',
  sparen: 'Rücklagen; Zu- und Abflüsse sind keine echten Ausgaben',
  kreditkarte: 'Sammelabrechnung, wird vom Girokonto ausgeglichen',
};

export const BUCKET_LABELS: Record<Bucket, string> = {
  need: 'Bedarf (50 %)',
  want: 'Wünsche (30 %)',
  save: 'Sparen (20 %)',
};

export const bucketLabel = (bucket: Bucket | null) => (bucket === null ? 'keiner' : BUCKET_LABELS[bucket]);

export const RULE_FIELD_LABELS: Record<RuleField, string> = {
  counterparty: 'Gegenpartei',
  purpose: 'Verwendungszweck',
};

export const PATTERN_TYPE_LABELS: Record<PatternType, string> = {
  contains: 'enthält (Suchtext)',
  wildcard: 'Ausdruck mit Platzhaltern',
};

export const PATTERN_TYPE_HINTS: Record<PatternType, string> = {
  contains: 'Der Text muss irgendwo vorkommen. Groß-/Kleinschreibung egal, Sonderzeichen wie & , - * gelten wörtlich.',
  wildcard:
    '* = beliebig viele Zeichen, ? = genau ein Zeichen, alles andere wörtlich. Der Ausdruck muss den ganzen Text treffen: „REWE*“ = beginnt mit REWE.',
};

export const CARD_DATE_LABELS: Record<CardDateField, string> = {
  booking_date: 'Kaufdatum',
  bank_booking_date: 'Buchungstag der Bank',
  value_date: 'Valuta',
};

/** „nach Buchungstag der Bank, Stichtag einschließlich“. */
export function cardRuleLabel(rule: CardRule): string {
  return `nach ${CARD_DATE_LABELS[rule.date]}, Stichtag ${rule.cutoff === 'inclusive' ? 'einschließlich' : 'ausschließlich'}`;
}

export const TRANSFER_KIND_LABELS: Record<TransferKind, string> = {
  pair: 'Paar',
  one_sided: 'einseitig (vermutet)',
  card_settlement: 'Kartenabrechnung',
};

export const INTERVAL_LABELS: Record<Interval, string> = {
  biweekly: '14-tägig',
  monthly: 'monatlich',
  quarterly: 'quartalsweise',
  semiannual: 'halbjährlich',
  annual: 'jährlich',
};

export const BALANCE_SOURCE_LABELS = {
  bank: 'Saldo laut Bank',
  import: 'Kontostand laut Datei',
  manual: 'von Hand erfasster Kontostand',
} as const;

export const RECURRING_KIND_LABELS: Record<RecurringKind, string> = {
  fixed_cost: 'Fixkosten',
  subscription: 'Abo',
};

export const NOTICE_UNIT_LABELS: Record<NoticeUnit, string> = {
  days: 'Tage',
  weeks: 'Wochen',
  months: 'Monate',
};

export const CHECK_STATUS_LABELS: Record<CheckStatus, string> = {
  ok: 'passt',
  differs: 'Betrag weicht ab',
  missing: 'Abbuchung fehlt',
  ended: 'beendet?',
  no_bookings: 'keine passende Buchung',
  not_due: 'noch nichts fällig',
  inactive: 'inaktiv',
};
