import type { AccountRole } from '../api/accounts';
import type { Bucket } from '../api/categories';
import type { PatternType, RuleField } from '../api/rules';
import type { TransferKind } from '../api/transfers';

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

export const TRANSFER_KIND_LABELS: Record<TransferKind, string> = {
  pair: 'Paar',
  one_sided: 'einseitig (vermutet)',
  card_settlement: 'Kartenabrechnung',
};
