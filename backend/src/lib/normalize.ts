/**
 * Rechtsformen und Zusätze, die beim Vergleich von Gegenparteien keine
 * Rolle spielen. Angegeben nach Vereinfachung (klein, Umlaute
 * umschrieben, Satzzeichen als Leerzeichen); längere Formen zuerst.
 */
const LEGAL_FORMS = [
  'gesellschaft mit beschraenkter haftung',
  'kommanditgesellschaft auf aktien',
  'offene handelsgesellschaft',
  'kommanditgesellschaft',
  'aktiengesellschaft',
  'eingetragener verein',
  'eingetragene genossenschaft',
  'ug haftungsbeschraenkt',
  'gmbh co kg',
  'ag co kg',
  'co kg',
  'gmbh',
  'mbh',
  'kgaa',
  'ag',
  'se',
  'kg',
  'ohg',
  'ug',
  'e v',
  'ev',
  'eg',
  'ltd',
  'inc',
  'llc',
  'plc',
  'sarl',
];

const LEGAL_FORM_PATTERN = new RegExp(`(?:^| )(?:${LEGAL_FORMS.join('|')})(?= |$)`, 'g');

/** Zusätze wie „Niederlassung Luxemburg“, „Zweigniederlassung Deutschland“. */
const BRANCH_PATTERN = /(?:^| )(?:zweig)?niederlassung(?: [a-z]+)?(?= |$)/g;

/**
 * Normalisierte Gegenpartei (CLAUDE.md § 7): klein, Umlaute umschrieben,
 * Sonderzeichen und alles mit Ziffern (Referenz-, Rechnungsnummern,
 * Datumsangaben) entfernt, Rechtsformen in Kurz- und Langform sowie
 * Niederlassungs-Zusätze gestrippt, Leerraum zusammengefasst.
 *
 * `B+V Lebensversicherung AG Niederlassung Luxemburg` und
 * `B + V LEBENSVERSICHERUNG AKTIENGESELLSCHAFT` ergeben beide
 * `b v lebensversicherung`.
 */
export function normalizeCounterparty(input: string): string {
  let text = input
    .toLowerCase()
    .replace(/ä/g, 'ae')
    .replace(/ö/g, 'oe')
    .replace(/ü/g, 'ue')
    .replace(/ß/g, 'ss')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '');

  // Tokens mit Ziffern (inkl. angehängter Satzzeichen wie „01.“) entfernen,
  // bevor Satzzeichen zu Leerzeichen werden.
  text = text
    .split(/\s+/)
    .filter((token) => !/\d/.test(token))
    .join(' ');

  text = text.replace(/[^a-z]+/g, ' ').trim();

  // Mehrfach anwenden: „… GmbH Niederlassung Köln“ hat zwei Zusätze.
  let previous: string;
  do {
    previous = text;
    text = text.replace(BRANCH_PATTERN, ' ').replace(LEGAL_FORM_PATTERN, ' ').replace(/\s+/g, ' ').trim();
  } while (text !== previous);

  return text;
}
