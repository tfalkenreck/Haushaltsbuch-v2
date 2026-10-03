/**
 * Muster für Kategorisierungsregeln (CLAUDE.md § 9). Der Mustertyp ist
 * immer explizit – ein Eintrag wie `H&M` oder `real,-` verhält sich nie
 * unerwartet:
 *
 * - `contains`: einfacher Suchtext. Der Text muss irgendwo vorkommen,
 *   Groß-/Kleinschreibung egal, kein Zeichen hat eine Sonderbedeutung.
 * - `wildcard`: Ausdruck mit Platzhaltern. `*` = beliebig viele Zeichen,
 *   `?` = genau ein Zeichen, alles andere wörtlich. Der Ausdruck muss den
 *   ganzen Text treffen (`REWE*` = beginnt mit „REWE“).
 *
 * In beiden Fällen zählt mehrfacher Leerraum (Banken füllen Kartenumsätze
 * mit Leerzeichen auf, Verwendungszwecke enthalten Zeilenumbrüche) wie ein
 * einzelnes Leerzeichen.
 */

export const PATTERN_TYPES = ['contains', 'wildcard'] as const;
export type PatternType = (typeof PATTERN_TYPES)[number];

export const RULE_FIELDS = ['counterparty', 'purpose'] as const;
export type RuleField = (typeof RULE_FIELDS)[number];

/** Vergleichsform: klein, Leerraum zusammengefasst, außen getrimmt. */
export function foldText(text: string): string {
  return text.toLowerCase().replace(/\s+/g, ' ').trim();
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Prüft ein Muster; liefert eine deutsche Fehlermeldung oder null. */
export function patternProblem(type: PatternType, pattern: string): string | null {
  const folded = foldText(pattern);
  if (folded === '') return 'Das Muster darf nicht leer sein.';
  if (folded.length > 200) return 'Das Muster darf höchstens 200 Zeichen lang sein.';
  if (type === 'wildcard' && folded.replace(/[*?\s]/g, '') === '') {
    return 'Ein Ausdruck mit Platzhaltern braucht mindestens ein festes Zeichen.';
  }
  return null;
}

export type Matcher = (text: string) => boolean;

/** Baut eine Prüffunktion für ein Muster. */
export function compilePattern(type: PatternType, pattern: string): Matcher {
  const folded = foldText(pattern);
  if (type === 'contains') {
    return (text) => folded !== '' && foldText(text).includes(folded);
  }
  const source = [...folded]
    .map((c) => (c === '*' ? '.*' : c === '?' ? '.' : escapeRegExp(c)))
    .join('');
  const regex = new RegExp(`^${source}$`, 'su');
  return (text) => regex.test(foldText(text));
}

/**
 * Vorschlag für einen Suchtext aus einer Gegenpartei bzw. einem
 * Verwendungszweck: die Wörter bis zum ersten mit Ziffern (Rechnungs-,
 * Kunden-, Kartennummern ändern sich von Buchung zu Buchung).
 * `AMAZON PAYMENTS EUROPE 302-1234567` → `AMAZON PAYMENTS EUROPE`.
 */
export function suggestSearchText(text: string, maxWords = 6): string | null {
  const words = text.trim().split(/\s+/).filter((w) => w !== '');
  const leading: string[] = [];
  for (const word of words) {
    if (/\d/.test(word)) break;
    leading.push(word);
  }
  const chosen = (leading.length > 0 ? leading : words.filter((w) => !/\d/.test(w))).slice(0, maxWords);
  const result = chosen.join(' ').slice(0, 80).trim();
  return result === '' ? null : result;
}
