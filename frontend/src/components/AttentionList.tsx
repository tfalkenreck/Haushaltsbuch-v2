import type { ReactNode } from 'react';
import type { AttentionItem } from '../api/insights';
import { formatCents, formatDate, formatMonth, formatMonthCount } from '../lib/format';
import { INTERVAL_LABELS } from '../lib/labels';
import { hrefFor } from '../lib/route';

/** So viele Einträge zeigt ein Punkt, der Rest steht auf der verlinkten Seite. */
const MAX_ENTRIES = 5;

function Entries({ items }: { items: ReactNode[] }) {
  const shown = items.slice(0, MAX_ENTRIES);
  return (
    <ul className="attention">
      {shown.map((node, i) => (
        <li key={i}>{node}</li>
      ))}
      {items.length > MAX_ENTRIES && <li className="muted">… und {items.length - MAX_ENTRIES} weitere</li>}
    </ul>
  );
}

const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** Text, Einzelheiten und Sprungziel eines offenen Punkts. */
function describe(item: AttentionItem): { title: ReactNode; body?: ReactNode; href: string; action: string } {
  switch (item.kind) {
    case 'funding_deficit': {
      const direction = item.direction === 'growing' ? ', wird größer' : item.direction === 'shrinking' ? ', wird kleiner' : '';
      return {
        title: <>„{item.accountName}“: Dauerauftrag reicht nicht</>,
        body: (
          <Entries
            items={[
              item.deficitSince && (
                <>
                  Unterdeckung seit {formatMonth(item.deficitSince)}: {formatMonthCount(item.deficitStreak)} in Folge{direction}
                  {item.trendStatus === 'trend' ? ' – ein Trend, kein Zufall.' : ' – noch kein Trend.'}
                </>
              ),
              item.recommendedCents !== null && (
                <>
                  Empfehlung: Daueraufträge auf <strong>{formatCents(item.recommendedCents)}</strong> je Monat (
                  <span className="deficit">{formatCents(item.changeCents ?? 0)} mehr</span>).
                </>
              ),
              item.negativeBalance && (
                <span className="deficit">
                  Konto im Minus: {formatCents(item.negativeBalance.balanceCents)} am {formatDate(item.negativeBalance.date)}.
                </span>
              ),
            ].filter(Boolean)}
          />
        ),
        href: hrefFor('deckung', { accountId: item.accountId }),
        action: 'zur Deckungsprüfung',
      };
    }
    case 'recurring_suggestions':
      return {
        title: <>{count(item.entries.length, 'neuer Vorschlag', 'neue Vorschläge')} für Fixkosten &amp; Abos</>,
        body: (
          <Entries
            items={item.entries.map((e) => (
              <>
                {e.name}: {formatCents(e.amountCents)} {INTERVAL_LABELS[e.interval]}
                {e.duplicate && <> <span className="tag tag-warn">doppelt?</span></>}
              </>
            ))}
          />
        ),
        href: hrefFor('fixkosten'),
        action: 'übernehmen oder verwerfen',
      };
    case 'recurring_price': {
      const higher = item.entries.some((e) => e.lastCents !== null && e.lastCents > e.sollCents);
      return {
        title: higher ? 'Teurer geworden: Betrag weicht vom Soll ab' : 'Betrag weicht vom Soll ab',
        body: (
          <Entries
            items={item.entries.map((e) => (
              <>
                {e.name}: Soll {formatCents(e.sollCents)}, zuletzt{' '}
                <span className={e.lastCents !== null && e.lastCents > e.sollCents ? 'deficit' : undefined}>
                  {e.lastCents === null ? '–' : formatCents(e.lastCents)}
                </span>
              </>
            ))}
          />
        ),
        href: hrefFor('fixkosten'),
        action: 'zu Fixkosten & Abos',
      };
    }
    case 'recurring_missing':
      return {
        title: <>Erwartete Abbuchung fehlt bei {count(item.entries.length, 'Posten', 'Posten')}</>,
        body: (
          <Entries
            items={item.entries.map((e) =>
              e.ended ? <>{e.name}: mehrere Abbuchungen in Folge fehlen – beendet?</> : <>{e.name}: fällig am {formatDate(e.dueDate)}</>,
            )}
          />
        ),
        href: hrefFor('fixkosten'),
        action: 'zu Fixkosten & Abos',
      };
    case 'recurring_cancel':
      return {
        title: 'Kündigungsfrist naht',
        body: (
          <Entries
            items={item.entries.map((e) => (
              <>
                {e.name}: kündbar bis <strong>{formatDate(e.cancelBy)}</strong> (Vertragsende {formatDate(e.contractEndDate)})
              </>
            ))}
          />
        ),
        href: hrefFor('fixkosten'),
        action: 'zu Fixkosten & Abos',
      };
    case 'uncategorized':
      return {
        title: <>{count(item.count, 'Buchung', 'Buchungen')} ohne Kategorie</>,
        body: (
          <p className="hint">
            Abflüsse {formatCents(item.outflowCents)}
            {item.inflowCents > 0 && <>, Zuflüsse {formatCents(item.inflowCents)}</>} – fehlen in jeder Auswertung nach Kategorie und
            im Budget.
          </p>
        ),
        href: hrefFor('buchungen', { uncategorized: 1 }),
        action: 'kategorisieren',
      };
    case 'transfers_suggested':
      return {
        title: <>{count(item.count, 'erkannte Umbuchung', 'erkannte Umbuchungen')} noch nicht bestätigt</>,
        body: <p className="hint">Prüfen, damit keine echte Ausgabe unbemerkt als Umbuchung verschwindet.</p>,
        href: hrefFor('umbuchungen', { status: 'suggested' }),
        action: 'prüfen',
      };
    case 'card_mismatch': {
      const cards = [...new Set(item.entries.map((e) => e.cardAccountId))];
      return {
        title: <>{count(item.entries.length, 'Kartenabrechnung passt', 'Kartenabrechnungen passen')} nicht zur Summe der Kartenumsätze</>,
        body: (
          <Entries
            items={item.entries.map((e) => (
              <>
                {e.cardAccountName ?? 'Karte'}, {formatDate(e.periodStart)} – {formatDate(e.periodEnd)}: Abweichung{' '}
                {formatCents(e.differenceCents, { sign: true })} – fehlt ein Kartenimport oder ein Umsatz?
              </>
            ))}
          />
        ),
        href: hrefFor('umbuchungen', { accountId: cards.length === 1 ? cards[0] : undefined }),
        action: 'zu den Umbuchungen',
      };
    }
    case 'import_gap':
      return {
        title: <>„{item.accountName}“: {count(item.gaps.length, 'Importlücke', 'Importlücken')}</>,
        body: <Entries items={item.gaps.map((g) => <>{formatDate(g.start)} – {formatDate(g.end)} fehlt</>)} />,
        href: hrefFor('import', { accountId: item.accountId }),
        action: 'importieren',
      };
    case 'import_stale':
      return {
        title: <>„{item.accountName}“: seit {item.days} Tagen nicht importiert</>,
        body: <p className="hint">Importiert bis {formatDate(item.lastDate)} – Auswertungen danach sind unvollständig.</p>,
        href: hrefFor('import', { accountId: item.accountId }),
        action: 'importieren',
      };
    case 'never_imported':
      return {
        title: <>„{item.accountName}“: noch nichts importiert</>,
        href: hrefFor('import', { accountId: item.accountId }),
        action: 'importieren',
      };
    case 'needs_reimport':
      return {
        title: <>„{item.accountName}“: Kartenumsätze ohne Buchungstag der Bank</>,
        body: <p className="hint">Die Datei erneut importieren – vorhandene Buchungen werden ergänzt, nichts geht verloren.</p>,
        href: hrefFor('import', { accountId: item.accountId }),
        action: 'erneut importieren',
      };
  }
}

/** Offene Punkte der Startseite (CLAUDE.md § 15) – jeder mit Sprung zur passenden Seite. */
export function AttentionList({ items }: { items: AttentionItem[] }) {
  if (items.length === 0) return <p className="panel verdict verdict-ok">Keine offenen Punkte – alles erledigt.</p>;
  return (
    <ul className="attention-list">
      {items.map((item, i) => {
        const d = describe(item);
        return (
          <li key={`${item.kind}-${i}`} className={`panel attention-${item.severity}`}>
            <div className="attention-head">
              <strong>{d.title}</strong>
              <a href={d.href}>{d.action} →</a>
            </div>
            {d.body}
          </li>
        );
      })}
    </ul>
  );
}
