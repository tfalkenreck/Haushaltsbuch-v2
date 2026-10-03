import type { AccountRole } from '../api/accounts';

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
