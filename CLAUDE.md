# Haushaltsbuch – Projektspezifikation

Dauerhafte Spezifikation für dieses Repository. Gilt für jede Sitzung.
Quelle: „Haushaltsbuch — Anforderungen (Neuaufsatz)“ vom 3. Oktober 2026
plus Projektbriefing. Bei Widerspruch gilt dieses Dokument; Änderungen an
der Spezifikation werden hier nachgetragen, nicht nur im Chat beschlossen.

---

## 1. Zweck

Ein lokales Haushaltsbuch, das aus Kontoauszügen erkennt, wohin das Geld
fließt, und daraus **konkrete Hinweise** ableitet – nicht nur Zahlen anzeigt.

**Wichtigste Funktion:** die Deckungsprüfung des Ausgabenkontos (§ 11).

---

## 2. Prinzipien (nicht verhandelbar)

1. **Local-first.** Alle Daten bleiben auf dem Rechner. Keine Cloud, keine
   Telemetrie, keine externen Requests im Anwendungscode. Backend lauscht
   nur auf `127.0.0.1`.
2. **Echte Kontodaten nie ins Repository.** Fixtures sind synthetisch
   (erfundene Namen, erfundene IBANs, erfundene Beträge). `data/`, `*.db`
   und `*.csv` außerhalb von `backend/test/fixtures/` sind in `.gitignore`.
3. **Geld immer als INTEGER in Cent.** Nie `number` mit Nachkommastellen,
   nie `REAL` in SQLite. Formatierung (`1.234,56 €`) erst in der Oberfläche.
4. **Datumsangaben in der DB als ISO-8601-Text** (`YYYY-MM-DD`).
   Zeitstempel (z. B. `imported_at`) als ISO-8601 mit Uhrzeit.
5. **Ehrliche Auswertung.** Was nicht kategorisiert oder nicht importiert
   ist, wird sichtbar gemacht. Eine Auswertung mit 800 € Ausgaben, während
   300 € unsortiert danebenliegen, ist wertlos.
6. **Automatik schlägt vor, der Mensch entscheidet.** Erkannte Regeln,
   Umbuchungen und Abos werden nie stillschweigend angewendet. Sie bleiben
   sichtbar, korrigierbar und aufhebbar. Handarbeit wird nie von Automatik
   überschrieben.

---

## 3. Stack & Konventionen

| Bereich   | Wahl                                                        |
|-----------|-------------------------------------------------------------|
| Sprache   | TypeScript durchgehend, `strict` + `noUncheckedIndexedAccess` |
| Backend   | Fastify, ESM (`"type": "module"`, `NodeNext`)               |
| Datenbank | SQLite über `better-sqlite3` (synchron)                     |
| Frontend  | React + Vite                                                |
| Tests     | Vitest (Root-Config mit Projekten `backend` und `frontend`) |
| Laufzeit  | Node.js 24 LTS, 22 LTS unterstützt (`.nvmrc`, `engines`, `engine-strict`) |
| Struktur  | npm-Workspaces: `backend/`, `frontend/`                     |

**Windows ist Zielplattform.**

- `better-sqlite3` ist auf eine Version gepinnt, für die vorgebaute
  Binaries für Node 22 und 24 / Windows x64 existieren. Kein `node-gyp`-Build,
  kein Python, keine Visual-Studio-Build-Tools. Wer die Version oder die
  Node-Hauptversion ändert, prüft vorher, dass es Prebuilds gibt.
- Alle Abhängigkeiten exakt gepinnt (`save-exact=true` in `.npmrc`),
  `package-lock.json` wird committet.
- npm 11 führt Installskripte nur für Pakete aus, die unter `allowScripts`
  in der Root-`package.json` freigegeben sind (versionsgenau). Freigegeben:
  `esbuild`, `better-sqlite3`. Nach jedem Update dieser Pakete die neuen
  Versionen per `npm install-scripts approve <pkg>` freigeben und
  committen. Keine weiteren Pakete ohne Begründung freigeben.
- Sicherheitsupdates per gezieltem Pin auf die gefixte Version, nie
  `npm audit fix --force`.
- Skripte in `package.json` müssen unter `cmd.exe` laufen: keine
  Bash-Syntax, keine `rm -rf`, keine Umgebungsvariablen per `FOO=bar cmd`.

**Code-Konventionen**

- Bezeichner im Code und Datenbankschema auf Englisch, Enum-Werte für
  Rollen und Buckets wie unten spezifiziert, UI-Texte auf Deutsch.
- Backend-Imports mit `.js`-Endung (NodeNext).
- Vorzeichen: `amount_cents < 0` = Abfluss vom Konto, `> 0` = Zufluss.
- Alle Aggregationen (Summen, Monatswerte, Median, Deckung) im Backend
  per SQL bzw. in Backend-Services – nie im Browser.
- Fachlogik (Parser, Normalisierung, Erkennung) als reine Funktionen in
  `backend/src/lib` bzw. `backend/src/services`, damit sie ohne Server
  testbar ist.

**Ports:** Backend `127.0.0.1:3001`, Frontend `127.0.0.1:5173`. Vite leitet
`/api/*` an das Backend weiter, daher kein CORS nötig.

---

## 4. Ordnerstruktur

```
haushaltsbuch/
├─ CLAUDE.md              diese Spezifikation
├─ README.md              Setup & Start (Windows zuerst)
├─ package.json           Workspaces + gemeinsame Skripte
├─ tsconfig.base.json     gemeinsame Compiler-Optionen
├─ vitest.config.ts       Testprojekte backend/frontend
├─ data/                  (gitignored) SQLite-Datei, Exporte – zur Laufzeit angelegt
├─ backend/
│  ├─ src/
│  │  ├─ index.ts         Serverstart
│  │  ├─ app.ts           buildApp() – testbar ohne Port
│  │  ├─ db/              Verbindung, Migrationsrunner
│  │  │  └─ migrations/   001_….sql, 002_….sql – nie nachträglich ändern
│  │  ├─ adapters/        Bank-Adapter (CSV → einheitliche Buchungen)
│  │  ├─ routes/          HTTP-Endpunkte unter /api
│  │  ├─ services/        Fachlogik (Import, Regeln, Umbuchungen, Deckung …)
│  │  └─ lib/             Geld, Datum, Normalisierung, CSV-Grundlagen
│  └─ test/
│     └─ fixtures/        synthetische Kontoauszüge
└─ frontend/
   └─ src/
      ├─ api/             Fetch-Wrapper für /api
      ├─ pages/           Seiten (Dashboard, Konten, Buchungen …)
      ├─ components/      wiederverwendbare UI-Teile
      └─ lib/             Formatierung (Cent → „1.234,56 €“)
```

---

## 5. Konten & Rollen

Beliebig viele Konten. Jedes Konto hat eine **Rolle**, die bestimmt, wie es
ausgewertet wird – unabhängig vom Banktyp.

| Rolle (`role`) | Bedeutung                                                   |
|----------------|-------------------------------------------------------------|
| `einnahmen`    | Gehalt kommt an, ein Teil der Ausgaben läuft direkt darüber |
| `ausgaben`     | Per Dauerauftrag gespeist, Fixkosten werden hier abgebucht  |
| `sparen`       | Rücklagen; Zu- und Abflüsse sind keine echten Ausgaben      |
| `kreditkarte`  | Sammelabrechnung, wird vom Girokonto ausgeglichen           |

Konkret vorhanden:

| Konto     | Bank          | Rolle         | Bemerkung                              |
|-----------|---------------|---------------|----------------------------------------|
| Girokonto | Volksbank OWL | `einnahmen`   | teils auch Ausgaben                    |
| Sparkonto | Volksbank OWL | `sparen`      |                                        |
| Girokonto | Comdirect     | `ausgaben`    | Dauerauftrag am 11. vom Einnahmenkonto |
| Visa      | Volksbank OWL | `kreditkarte` | Sammelabbuchung vom Einnahmenkonto     |

Anforderungen:

- Konten anlegen, umbenennen, **deaktivieren statt löschen** (sonst
  verlieren Buchungen ihren Bezug).
- **Bank-Adapter und Rolle sind beim Anlegen wählbar und nachträglich
  änderbar. Nie fest verdrahtet** – kein Code darf von Kontoname oder Bank
  auf die Rolle schließen.
- Mehrere Konten bei derselben Bank möglich.
- Eigene IBAN pro Konto speicherbar (Basis für Umbuchungserkennung).
- Kontoübersicht mit Saldo, abgedecktem Zeitraum und verwendetem Adapter.

Bewusst nicht angelegt: Comdirect-Visa (vorhanden, aber ungenutzt). Ihr
monatliches Entgelt erscheint als Ausgabe auf dem Comdirect-Girokonto.

Außerhalb des Umfangs: Gemeinschaftskonto und geteilte Kosten.

---

## 6. Import

**Exakte Formate, Spalten-Mapping und Besonderheiten je Bank: `docs/bankformate.md` – vor jeder Arbeit an Adaptern lesen.**

**Adapter-Interface pro Bank.** Vorhanden: `volksbank-owl` (Girokonto,
Sparkonto und Visa – gleiches Format, siehe § 19), `comdirect`. CAMT.053 als
normierter Standardweg ist optional für später. Eine Banking-API
(FinTS/PSD2) ist außerhalb des Umfangs, muss aber später hinter dasselbe
Interface passen.

Ein Adapter liefert nur geparste Rohbuchungen; Duplikaterkennung,
Normalisierung, Regeln und Umbuchungserkennung passieren zentral danach.

**Deutsche Eigenheiten, die jeder Adapter beherrschen muss:**

- Encoding je nach Bank: ISO-8859-1, Windows-1252 oder UTF-8 mit BOM.
  **Explizit dekodieren (`TextDecoder` mit festem Label), nie UTF-8
  annehmen.** BOM entfernen.
- Semikolon als Trennzeichen, Dezimalkomma, Tausenderpunkt
  (`-1.234,56` → `-123456` Cent, ohne Float-Umweg).
- Datum `TT.MM.JJJJ` → `YYYY-MM-DD`.
- Metadatenzeilen vor der Kopfzeile bei manchen Banken, Kopfzeile in
  Zeile 1 bei anderen. **Die Kopfzeile wird gesucht**, nicht angenommen.
- Semikolon und Zeilenumbruch im Verwendungszweck → quote-aware parsen.
- Leere Zeilen mitten in der Datei, Summen-/Fußzeilen am Ende.

**Weitere Anforderungen:**

- **Duplikaterkennung** über `import_hash` = SHA-256 aus `account_id`,
  Buchungsdatum, Betrag, Verwendungszweck; Spalte `UNIQUE`. Dieselbe Datei
  mehrfach importieren erzeugt keine doppelten Buchungen.
- **Fehlermeldungen** nennen den verwendeten Adapter und die verfügbaren
  Alternativen („Comdirect-Adapter erkennt keine Kopfzeile. Verfügbar:
  volksbank-owl.“).
- **Abdeckung:** pro Konto anzeigen, für welche Monate Buchungen vorliegen
  und wo Lücken sind. Warnung, wenn eine Datei einen bereits abgedeckten
  Zeitraum überlappt oder eine Lücke offen lässt.
- **Ein Importvorgang ist als Einheit rückgängig machbar**
  (`import_batch_id`).

---

## 7. Datenmodell

Tabellen: `accounts` (inkl. `role`, `bank_adapter`, `iban`, `active`),
`import_batches`, `transactions`, `categories`, `rules`,
`recurring_items`, `savings_goals`, `transfers`.

`transactions`:
`id, account_id, booking_date, value_date, amount_cents, currency,
counterparty, counterparty_normalized, purpose, category_id,
recurring_item_id, transfer_id, import_batch_id, import_hash, imported_at,
notes`

Zusätzlich wird pro Buchung festgehalten, **woher** eine Zuordnung kommt
(Kategorie und Umbuchung: `manual` / `rule` / `auto`), damit Automatik
Handarbeit erkennen und nie überschreiben kann.

`counterparty_normalized`: lowercase, Sonderzeichen und Ziffernfolgen
entfernt, Rechtsformen (GmbH, AG, SE, KG, e.V. …) und Referenznummern
gestrippt, Mehrfach-Leerzeichen zusammengefasst. Basis für Regel-Matching,
Abo- und Umbuchungserkennung. Wird beim Import berechnet und ist
neu berechenbar, wenn sich die Normalisierung ändert.

`transfers` muss drei Fälle abbilden:

1. **Paar 1:1** – beide Seiten importiert (Girokonto ↔ Sparkonto).
2. **Einseitig, vermutet** – Gegenkonto nicht importiert, erkannt über
   Verwendungszweck oder eigene IBAN.
3. **1:n Kartenabrechnung** – eine Sammelabbuchung auf dem Girokonto
   gegenüber den Kartenumsätzen eines Abrechnungszeitraums.

Plus Herkunft (`auto` / `manual`) und Status (vorgeschlagen / bestätigt).

**Migrationen** als nummerierte SQL-Dateien in `backend/src/db/migrations/`
(`001_initial.sql`, `002_….sql`). **Bestehende Migrationen werden NIE
geändert** – jede Änderung ist eine neue Datei. Der Runner merkt sich
angewendete Migrationen in einer eigenen Tabelle.

SQLite-Pflicht pro Verbindung: `PRAGMA foreign_keys = ON`,
`PRAGMA journal_mode = WAL`. Mehrschrittige Schreibvorgänge (Import,
Rückgängig) in einer Transaktion.

DB-Datei: `data/haushaltsbuch.db` (Pfad per Umgebungsvariable
überschreibbar; Tests nutzen `:memory:`).

---

## 8. Kategorien

Wurzelkategorien mit optionalen Unterkategorien. Jede Kategorie trägt einen
`bucket` für die 50/30/20-Auswertung: `need`, `want`, `save` oder keinen
(`NULL`, fließt nicht in die Rechnung ein).

| Bucket | Kategorien |
|--------|------------|
| `need` | Wohnen & Nebenkosten, Lebensmittel, Mobilität, Versicherungen, Gesundheit |
| `want` | Freizeit & Unterhaltung, Shopping & Kleidung, Restaurants & Cafés, Abos & Mitgliedschaften, Urlaub & Reisen, Bildung & Weiterbildung, Geschenke & Spenden |
| `save` | Sparen, Investieren, Altersvorsorge |
| ohne   | Einkommen, Bargeldabhebungen, Sonstiges, Umbuchung |

Anmerkungen: Mobilität ggf. später trennen (Arbeitsweg vs. Freizeit);
berufliche Weiterbildung wäre `need`.

Anforderungen:

- Kategorien über die Oberfläche anlegen, umbenennen, Bucket ändern – ohne
  Code.
- Unterkategorien erben den Bucket der Eltern, können aber abweichen.
- Bestehende Zuordnungen bleiben erhalten, wenn eine Kategorie geteilt oder
  umbenannt wird.
- Bargeldabhebungen gesondert ausweisen: Betrag pro Monat, mit Hinweis,
  dass der Verwendungszweck unbekannt bleibt.

---

## 9. Automatische Kategorisierung (Regeln)

- Regel = Muster auf Gegenpartei oder Verwendungszweck + Zielkategorie +
  Priorität.
- **Mustertyp ist ein explizites Feld**: einfacher Suchtext (enthält,
  case-insensitive, keine Sonderzeichen-Interpretation) **oder** Ausdruck
  mit Platzhaltern. Ein Eintrag wie `H&M` oder `real,-` darf sich nie
  unerwartet verhalten.
- Regeln laufen beim Import automatisch und lassen sich nachträglich auf
  den Bestand anwenden – dabei **nur unkategorisierte Buchungen**,
  Handarbeit wird nie überschrieben.
- **Lernen aus Korrekturen:** nach einer manuellen Umkategorisierung bietet
  die App an, daraus eine Regel zu machen. Nur anbieten, nie automatisch
  anlegen. Eine gelernte Regel muss gegen bestehende, allgemeinere Regeln
  gewinnen (höhere Priorität), sonst greift die Korrektur nie.
- Regelübersicht: anlegen, bearbeiten, löschen, Anzahl aktuell getroffener
  Buchungen anzeigen.

---

## 10. Umbuchungen zwischen eigenen Konten

Geld zwischen eigenen Konten ist **weder Einnahme noch Ausgabe**. Ohne diese
Unterscheidung zählt jede Überweisung doppelt.

Richtungen: `einnahmen → ausgaben` (Dauerauftrag am 11.),
`einnahmen ↔ sparen`, `giro → kreditkarte`, grundsätzlich jede Richtung
zwischen zwei angelegten Konten.

**Erkennung:** gleicher Betrag mit umgekehrtem Vorzeichen, Datum innerhalb
weniger Tage, beide Konten in der App angelegt → als Paar in `transfers`.

**Sonderfall:** Ist nur eines der Konten importiert, fehlt die Gegenbuchung.
Dann über Verwendungszweck, eigene IBAN als Gegenpartei oder manuelle
Markierung als *vermutete* Umbuchung erkennen.

**Wirkung:**

- Zählen nirgends als Einnahme oder Ausgabe: nicht im Dashboard, nicht im
  Budget, nicht in der Prognose, nicht bei Fixkosten/Abo-Erkennung.
- In der Transaktionsliste sichtbar, aber gekennzeichnet.
- Manuell setzbar und aufhebbar.
- Eigene Übersicht aller erkannten Umbuchungen, damit Fehlerkennungen
  auffallen – sonst verschwindet eine echte Ausgabe unbemerkt.

---

## 11. Kreditkarte

Die Visa wird einmal monatlich gesammelt vom Einnahmenkonto abgebucht.
Diese eine Abbuchung ist **nicht** die Ausgabe – die echten Ausgaben stehen
auf der Kartenabrechnung.

- Kreditkarte ist ein eigenes Konto mit eigenem Import.
- Die Einzelumsätze der Karte sind die Ausgaben und werden kategorisiert.
- Die Sammelabbuchung ist eine Umbuchung.
- **1:n statt 1:1:** ein Betrag auf dem Girokonto steht vielen
  Einzelumsätzen gegenüber. Zuordnung über die Summe der Kartenumsätze des
  Abrechnungszeitraums.
- **Zeitversatz:** Kartenumsätze zählen mit ihrem eigenen Datum, nicht mit
  dem der Abbuchung – sonst landen Septemberausgaben im Oktober.
- **Plausibilitätsprüfung:** Summe der Kartenumsätze muss der
  Sammelabbuchung entsprechen; sonst Hinweis (fehlender Import oder Umsatz).

---

## 12. Deckungsprüfung des Ausgabenkontos (wichtigste Funktion)

**Frage:** Reicht der monatliche Dauerauftrag noch für das, was tatsächlich
vom Ausgabenkonto abgebucht wird?

1. **Dauerauftrag erkennen:** Höhe und Termin der regelmäßigen Überweisung
   aufs Ausgabenkonto (hier: 11.), inklusive Änderungen über die Zeit.
2. **Tatsächliche Abbuchungen** pro Monat summieren – ohne die Umbuchung
   selbst.
3. **Differenz pro Monat** (Zufluss minus Abfluss), Unter- und Überdeckung
   deutlich unterscheidbar.
4. **Verlauf statt Momentaufnahme:** seit wann besteht eine Unterdeckung,
   wird sie größer? Ein schlechter Monat ist Zufall, drei in Folge ein
   Trend.
5. **Saldoentwicklung:** zehrt die Unterdeckung an einem Polster, oder ist
   das Konto schon im Minus?
6. **Empfehlung** für den neuen Dauerauftragsbetrag inklusive Puffer für
   schwankende Posten.
7. **Ursache benennen:** welche Einzelposten sind gestiegen und um wie viel.

Gilt sinngemäß für **jedes** per Dauerauftrag gespeiste Konto – nicht auf
das Comdirect-Konto verdrahten.

---

## 13. Ausgaben am Ausgabenkonto vorbei

Wiederkehrende Kosten, die noch direkt vom Einnahmenkonto abgebucht werden,
obwohl sie ihrer Art nach aufs Ausgabenkonto gehören (Versicherung,
Telefon, Abo, Mitgliedschaft).

- Kandidatenliste mit Betrag, Intervall, Gegenpartei.
- Pro Posten: „soll umgestellt werden“ oder „bleibt bewusst hier“ – damit
  die Liste nicht jeden Monat dieselben Fälle zeigt.
- Für markierte Posten ausrechnen, um wie viel der Dauerauftrag steigen
  müsste.
- Nach der Umstellung den Kontowechsel erkennen und nicht doppelt zählen.

---

## 14. Fixkosten und Abos

**Manuelles Anlegen ist der Hauptweg, nicht die Automatik.** Jede
Fixkostenposition und jedes Abo lässt sich von Hand anlegen: Gegenpartei,
Betrag, Intervall, nächster Termin. Jede Buchung lässt sich manuell als
wiederkehrend markieren; eine Fehlerkennung lässt sich entfernen.

**Soll/Ist-Abgleich:** eingetragenes Soll gegen tatsächliche Buchungen –
fehlt eine erwartete Abbuchung, weicht der Betrag ab (Preiserhöhung)?

**Automatische Erkennung als Komfort obendrauf**, nach jedem Import:

- Intervalle: 14-tägig, monatlich, quartalsweise, halbjährlich, jährlich.
- Toleranz beim Termin (Wochenenden, Feiertage).
- Großzügige Toleranz beim Betrag – deutlich weiter als 10 % (Strom mit
  Nachzahlung, Telefon mit Verbrauch).
- Jährliche Posten ohne mehrjährige Daten als „vermutet“ kennzeichnen.
- Gegenparteien mit wechselnden Zusätzen (Rechnungsnummern, Zeiträume)
  über `counterparty_normalized` zusammenfassen.
- Erkannt werden außerdem: Preiserhöhungen (Betrag, Zeitpunkt), beendete
  Abos (länger als ein Intervall keine Buchung), doppelte Abos beim selben
  Anbieter, Abos, die zum Vertragsende kündbar wären.
- Erkanntes wird **vorgeschlagen, nie automatisch übernommen.**

Bekannte Beispiele, die die alte Version nicht erkannt hat: Audible
10 €/Monat, Ring 8 €/Monat (vermutlich nicht importiertes Konto oder
schwankende Schreibweise der Gegenpartei).

---

## 15. Weitere Auswertungen

**Dashboard / Startseite**

- Oben die offenen Punkte, die Handlung erfordern: Unterdeckung des
  Ausgabenkontos, neue oder teurer gewordene Abos, unkategorisierte
  Buchungen, fehlende Importzeiträume.
- Monatsübersicht Einnahmen / Ausgaben / Saldo, gesamt oder pro Konto.
- Ausgaben nach Kategorie absteigend mit Anteil; Vergleich zum Vormonat;
  Verlauf über 12 Monate.
- Unkategorisierte Buchungen immer sichtbar (Anzahl und Summe) mit Sprung
  zur gefilterten Liste.
- Hinweis, wenn der betrachtete Monat nicht vollständig importiert ist –
  sonst sieht ein halber Monat aus wie ein sparsamer.

**Budget 50/30/20**

- Nettoeinkommen aus den wiederkehrenden Eingängen ableiten, nicht aus
  allen Gutschriften (Erstattungen und Umbuchungen verzerren).
- Ausgaben nach Bucket, Ist gegen Ziel. Der Nutzen liegt in der Abweichung
  pro Kategorie.

**Prognose**

- Fixkosten aus den Abos/Fixkosten mit Termin und Betrag.
- Variable Kategorien über den **Median** der letzten Monate, nicht den
  Mittelwert.
- Pro Kategorie, Monat und Gesamtsaldo; bekannte Einmalposten
  (Jahresbeiträge) im richtigen Monat.

**Sparziele**

- Ziel mit Betrag, Wunschdatum, Priorität; mehrere Ziele nach Priorität
  staffeln.
- Nötige Monatsrate gegen prognostizierten Überschuss.
- Rückkopplung: „Wenn diese Abos wegfallen, ist das Ziel N Monate früher
  erreicht.“
- Aktueller Stand ergibt sich aus dem Sparkonto, nicht aus Handpflege.

---

## 16. Betrieb

- Export aller Daten in ein offenes Format (JSON) per Knopfdruck und
  Re-Import davon auf einem neuen Rechner.
- Hinweis, wenn länger kein Export gemacht wurde.
- Startskript (Doppelklick), das Backend und Frontend zusammen startet.
- README mit funktionierender Windows-Anleitung (`npm.cmd`,
  Skriptfreigaben, Node-Version).
- Frischer Klon ohne Nacharbeit installierbar.

---

## 17. Phasenplan

| Phase | Inhalt | Status |
|-------|--------|--------|
| 0 | Spezifikation (diese Datei) und Projektgerüst | erledigt |
| 1 | Datenmodell (Migration 001), Migrationsrunner, Konten mit Rolle und wählbarem Adapter | erledigt |
| 2 | Import: Adapter-Interface, Volksbank OWL, Comdirect, Duplikaterkennung, Abdeckung, Rückgängig, Transaktionsliste | erledigt |
| 3 | Kategorisierung: Kategorien, Regeln, manuelles Umkategorisieren, Lernen aus Korrekturen | erledigt |
| 4 | Umbuchungen und Kreditkarte | erledigt |
| 5 | Deckungsprüfung und Ausgaben am Ausgabenkonto vorbei | erledigt |
| 6 | Fixkosten/Abos manuell plus automatische Erkennung | offen |
| 7 | Dashboard, Budget, Prognose, Sparziele | offen |
| 8 | Export/Re-Import, Startskript, Feinschliff | offen |

Status nach Abschluss einer Phase hier aktualisieren.

---

## 18. Arbeitsregeln für Claude

- **Nur die aktuelle Phase umsetzen.** Nicht vorgreifen, keine
  Platzhalter-Features für spätere Phasen.
- Vor dem Abschluss jeder Aufgabe: `npm run typecheck` und `npm test`
  grün.
- Jede Fachlogik bekommt Tests. Jeder Adapter bekommt synthetische
  Fixtures, die die deutschen Eigenheiten aus § 6 abdecken (Encoding,
  Metadatenzeilen, Semikolon im Verwendungszweck, Leerzeilen).
- Fixture-Dateien im echten Ziel-Encoding speichern (nicht als UTF-8
  „simuliert“). `.gitattributes` schützt sie vor Zeilenende-Konvertierung.
- Neue Abhängigkeiten nur mit Begründung, exakt gepinnt, Windows-Prebuilds
  prüfen.
- Keine Netzwerkzugriffe im Anwendungscode, keine Analytics, keine
  CDN-Fonts im Frontend.
- Bestehende Migrationen nie ändern.
- Geldbeträge nie durch Float schicken – auch nicht beim Parsen.
- Im Zweifel bei fachlichen Fragen nachfragen statt raten; Entscheidungen
  hier unter § 19 festhalten.

---

## 19. Entscheidungen & offene Punkte

**Getroffen am 3. Oktober 2026**

| Frage | Entscheidung |
|-------|--------------|
| Neu bauen oder umbauen? | Neu bauen |
| Bestand übernehmen? | Nein, leere Datenbank |
| Wichtigste Funktion | Deckungsprüfung des Ausgabenkontos |
| Abo-Erkennung | Automatik optional, manuelles Anlegen genügt |
| Banken | Volksbank OWL, Comdirect |
| Konten | drei plus Kreditkarte (§ 5) |
| Gemeinschaftskonto | nicht enthalten |
| Banking-API | außerhalb des Umfangs, CSV-Import reicht |
| Vitest-Advisory GHSA-82fw-gwwq-j7x9 | erledigt: Vitest 5.0.3 (Beginn Phase 1) |
| Hash-Kollision bei echten Doppelbuchungen | `import_hash` enthält zusätzlich die laufende Nummer identischer Zeilen (gleiches Konto, Datum, Betrag, Verwendungszweck) innerhalb einer Datei. Zwei echte Bäcker-Zahlungen bleiben zwei Buchungen; derselbe Export erneut importiert bleibt duplikatfrei |
| Visa-Buchungsdatum | Kaufdatum aus `Umsatz vom …` im Verwendungszweck ist `booking_date` |
| Visa-Format | identisch mit Volksbank-Girokonto (gleiche 18 Spalten); Unterschiede nur im Inhalt, siehe `docs/bankformate.md` |

**Getroffen in Phase 1 (3. Oktober 2026, von Tim bestätigt)**

| Frage | Entscheidung |
|-------|--------------|
| Typsicherheit in SQLite | Alle Tabellen `STRICT`: ein `REAL` in einer Cent-Spalte wird von der DB abgelehnt. Datumsspalten per `CHECK … GLOB` auf `YYYY-MM-DD` |
| Kategorien-Seed | Eigene Migration `002_seed_categories.sql`, läuft genau einmal; danach gehören die Kategorien dem Nutzer |
| Bucket-Vererbung | `categories.inherit_bucket` (nur Unterkategorien): 1 = Bucket der Eltern, 0 = eigener Bucket inkl. „keiner“ (`NULL`) |
| Herkunft der Zuordnung | `transactions.category_source` (`manual`/`rule`/`auto`) und `transfer_source` (`manual`/`auto`); `manual` mit leerer Zuordnung = bewusst „keine Kategorie“ bzw. „keine Umbuchung“, Automatik lässt die Buchung in Ruhe |
| Kartenabrechnung 1:n | Nur Sammelabbuchung (und ggf. Gutschrift aufs Kartenkonto) tragen `transfer_id`; die Kartenumsätze bleiben Ausgaben und werden über `to_account_id` + `period_start`/`period_end` zugeordnet |
| Bank-Adapter-Werte | Prüfung gegen die Registry `backend/src/adapters/registry.ts` statt DB-`CHECK` – neue Adapter brauchen keine Migration. Rollen dagegen per `CHECK` (neue Rolle = neue Migration) |
| Migrationsschutz | Runner speichert SHA-256 jeder Migration (Zeilenenden normalisiert) und bricht ab, wenn eine angewendete Datei geändert wurde |
| IBAN | Normalisiert (ohne Leerzeichen, groß) gespeichert, Prüfziffer (Mod 97) geprüft, je IBAN höchstens ein Konto |
| API-Format | JSON in camelCase (`bankAdapter`), DB in snake_case |

**Getroffen in Phase 2 (3. Oktober 2026)**

| Frage | Entscheidung |
|-------|--------------|
| Volksbank-Visa-Adapter | Kein eigener Adapter: `volksbank-owl` liest Giro, Sparkonto und Visa. Kartenbesonderheiten greifen am **Inhalt der Zeile** (leerer „Name Zahlungsbeteiligter“ → Händler aus dem Verwendungszweck, „Umsatz vom“ → `booking_date`), nie an Konto, Rolle oder Name. Migration 003 stellt Konten mit `volksbank-visa` auf `volksbank-owl` um |
| Zusatzfelder (Migration 003) | `transactions`: `booking_text` (Vorgangsart), `creditor_id`, `mandate_reference`, `balance_after_cents`, `bank_reference` (Comdirect „Ref.“); Gegen-IBAN steckt schon in `counterparty_iban`. `import_batches`: `balance_cents`/`balance_date` (Kontostand laut Datei), `rows_skipped` |
| Hash-Text | `import_hash` = SHA-256 über JSON `[account_id, booking_date, amount_cents, purpose, laufende Nummer]`; `purpose` ist der Verwendungszweck nach dem Parsen (Comdirect ohne `Ref.`) |
| Kontosaldo in der Übersicht | Aus dem jüngsten Importvorgang mit Saldo (nach `balance_date`): Volksbank = Saldo der jüngsten Zeile laut Saldo-Kette, Comdirect = „Neuer Kontostand“ aus den Metadaten |
| Saldo-Kette | Volksbank: Saldo_vorher + Betrag = Saldo_nachher wird je Auftragskonto geprüft; Brüche erscheinen als Warnung („fehlt dort eine Buchung?“), der Import läuft trotzdem |
| Auftragskonto-Prüfung | IBAN am Konto: nur passende Zeilen, Rest gemeldet; gehört die ganze Datei zu einem anderen Konto → Abbruch. Ohne IBAN am Konto: Import mit Hinweis; mehrere Auftragskonten oder IBAN eines anderen angelegten Kontos → Abbruch |
| Abdeckung | Grundlage sind die Zeiträume der Importvorgänge (nicht nur Buchungstage). Ohne Angabe gilt erste bis letzte Buchung der Datei; beim Import kann der Exportzeitraum angegeben werden, damit buchungsfreie Tage am Rand keine Scheinlücke erzeugen. Monate: vollständig / teilweise / fehlt, bis zum aktuellen Monat |
| Nichts Neues in der Datei | Kein leerer Importvorgang, nur Meldung |
| Comdirect-Tabellenende | Die erste Zeile nach der Kopfzeile, die keine Buchung ist (Leerzeilen ausgenommen), beendet die Tabelle; alles danach wird gemeldet, eine zweite Tabelle mit Warnung. `offen`-Zeilen → „vorgemerkt“, nicht importiert. Bankentgelte ohne `Auftraggeber:` → Gegenpartei `comdirect` |
| Windows-1252 | Eigene Dekodiertabelle statt `TextDecoder`: Node 22 dekodiert 0x80–0x9F (€, –, „“) als Steuerzeichen. „ISO-8859-1“ wird wie im Web-Standard als Windows-1252 gelesen |
| Datei-Upload | Rohe Bytes (`application/octet-stream`), keine Multipart-Abhängigkeit; das Encoding bestimmt allein der Adapter |

**Korrektur Phase 2 (3. Oktober 2026)**

| Frage | Entscheidung |
|-------|--------------|
| Visa: Kaufdatum vs. Buchungstag | `booking_date` bleibt das Kaufdatum (alle Auswertungen). Zusätzlich `transactions.bank_booking_date` = Buchungstag laut Bank (Migration 004). Exportzeitraum-Prüfung, abgeleiteter Zeitraum und Monatszählung der Abdeckung nutzen den Buchungstag, weil die Bank ihren Export danach filtert. Nicht im `import_hash` |
| Altbestand ohne Buchungstag | Migration 004 übernimmt `booking_date` für Zeilen ohne „Umsatz vom“; Kartenumsätze bleiben `NULL`. Betroffene Importe/Konten tragen `needsReimport`, die Oberfläche bittet um Rückgängig + Neuimport |

**Getroffen in Phase 3 (3. Oktober 2026)**

| Frage | Entscheidung |
|-------|--------------|
| Mustertypen | `contains` = Suchtext, irgendwo enthalten, Groß-/Kleinschreibung egal, kein Zeichen mit Sonderbedeutung. `wildcard` = `*` beliebig viele, `?` genau ein Zeichen, Rest wörtlich, muss den **ganzen** Feldtext treffen. Beide: mehrfacher Leerraum/Zeilenumbruch zählt als ein Leerzeichen. Geprüft wird der Originaltext (nicht `counterparty_normalized`), damit `H&M` wörtlich gilt |
| Regel-Reihenfolge | Höhere Priorität gewinnt, bei Gleichstand das längere Muster, dann die ältere Regel. Regeln mit deaktivierter Kategorie oder inaktive Regeln greifen nicht |
| Wer wird kategorisiert | Regeln (beim Import und „Regeln anwenden“) setzen nur Buchungen mit `category_id IS NULL AND category_source IS NULL`. Auch per Regel gesetzte Kategorien werden nicht umgeworfen, wenn sich Regeln ändern |
| Manuell | Setzen = `category_source 'manual'` (auch „bewusst keine Kategorie“). „Automatik zulassen“ hebt das auf und wendet die Regeln sofort auf die Buchung an |
| Unkategorisiert | = `category_id IS NULL`, einschließlich „bewusst keine“ – sie fehlen ja trotzdem in jeder Kategorie-Auswertung. Anzahl und Summen (Zu-/Abflüsse getrennt) stehen auf jeder Seite |
| Regelvorschlag | Nach manueller Kategorisierung: Suchtext auf die Gegenpartei (leer → Verwendungszweck), Wörter bis zur ersten Ziffernfolge. Priorität = höchste Priorität aller anderen auf die Buchung passenden Regeln + 1. Gleiches Muster vorhanden → diese Regel wird geändert statt eine zweite angelegt. Kein Vorschlag, wenn die bestehenden Regeln schon so entscheiden. Angelegt wird nur auf Knopfdruck; „gleich anwenden“ wirkt nur auf unkategorisierte Buchungen, bei denen die neue Regel gewinnt |
| Regel löschen | Wahlweise mit Entfernen der von ihr gesetzten Kategorien; Handarbeit bleibt immer |
| Kategorien | Zwei Ebenen. Löschen nur unbenutzt (keine Buchungen, Regeln, Unterkategorien, Fixkosten), sonst deaktivieren. Name je Ebene eindeutig (ohne Groß-/Kleinschreibung). Neue Unterkategorie erbt standardmäßig; eine Wurzel, die Unterkategorie wird, behält ihren Bucket |
| Kategorie-Filter | Filter auf eine Wurzel schließt ihre Unterkategorien ein |
| „Auch diese umstellen“ (Nachtrag, von Tim gewünscht) | Der Regelvorschlag zählt Buchungen, die eine andere Regel anders einsortiert hat **und** bei denen die neue Regel gewinnt. Ausdrücklicher Knopf zeigt sie vorher als Liste (abwählbar); umgestellt wird beim Speichern nur, was bei erneuter Prüfung noch `category_source = 'rule'` hat – von Hand gesetzte Kategorien nie |

**Nachtrag zu Phase 2 (3. Oktober 2026, von Tim gewünscht)**

| Frage | Entscheidung |
|-------|--------------|
| Erneuter Import vorhandener Buchungen | Gleicher `import_hash` → fehlende Bankangaben werden nachgetragen statt nur übersprungen: `bank_booking_date`, `value_date`, `counterparty_iban`, `creditor_id`, `mandate_reference`, `balance_after_cents`, `bank_reference`, leere `booking_text`/`counterparty`. Nur leere Felder, vorhandene Werte nie überschrieben; Kategorie, Umbuchung, Notizen und alle manuellen Zuordnungen bleiben. Die Meldung nennt die Zahl ergänzter Buchungen. Damit verschwindet `needsReimport` ohne Rückgängig |
| Zeitraum beim Nachtrag | Stammt die Buchung aus einem Import **derselben Datei** (gleicher SHA-256), übernimmt dieser Importvorgang den jetzt aus dem Buchungstag der Bank berechneten Zeitraum – wie nach Rückgängig + Neuimport. Andere Importvorgänge behalten ihren Zeitraum |

**Getroffen in Phase 4 (3. Oktober 2026)**

| Frage | Entscheidung |
|-------|--------------|
| Wirkung erkannter Umbuchungen | Jede Buchung mit `transfer_id` zählt sofort nirgends als Einnahme oder Ausgabe – auch nicht in der Leiste der unkategorisierten Buchungen und in den Summen der Buchungsliste (dort separat ausgewiesen). Erkanntes trägt `status = 'suggested'` und steht in der Übersicht „Umbuchungen“ zum Bestätigen oder Aufheben; von Hand Gesetztes ist `confirmed` |
| Unkategorisiert (Änderung zu Phase 3) | = `category_id IS NULL AND transfer_id IS NULL`. Umbuchungen brauchen keine Kategorie |
| Kategorien | Die Erkennung ändert nie eine Kategorie; eine per Regel oder von Hand gesetzte Kategorie bleibt an der Umbuchung stehen (zählt aber nicht) |
| Wer wird erkannt | Nur Buchungen mit `transfer_id IS NULL AND transfer_source IS NULL`. „Keine Umbuchung“ und „Aufheben“ setzen `transfer_source = 'manual'` ohne `transfer_id`; „Automatik zulassen“ hebt das auf und erkennt sofort neu |
| Reihenfolge der Erkennung | Nach jedem Import (und Rückgängig, „Erkennung jetzt ausführen“) über alle Konten: 1. Kartenabrechnungen, 2. Gegenbuchung zu automatisch erkannten einseitigen Umbuchungen (→ Paar), 3. Paare, 4. vermutete einseitige |
| Paar | Gleicher Betrag, umgekehrtes Vorzeichen, Buchungsdatum höchstens **5 Tage** auseinander (Karfreitag–Ostermontag), zwei verschiedene Konten, keine Kreditkartenkonten. Ausgeschlossen, wenn eine Seite eine Gegen-IBAN nennt, die nicht zum anderen Konto gehört. Vorrang: passende IBAN, dann kleinster Abstand |
| Einseitig, vermutet | Gegen-IBAN = IBAN eines anderen angelegten Kontos, eine solche IBAN im Text (auch mit Leerzeichen), oder Verwendungszweck mit „Umbuchung“, „Übertrag“, „eigenes Konto“, „Kontoausgleich“. Kartenumsätze nie |
| Kartenabrechnung erkennen | Ausgleich auf dem Kartenkonto (Gutschrift mit „Ausgleich“, „Kartenkonto“, „Abrechnung“ … oder eigener IBAN) plus Abbuchung gleichen Betrags (≤ 5 Tage) auf einem anderen Konto. Ohne importierten Ausgleich: Abbuchung nennt die IBAN der Karte, oder nennt „Visa“/„Kreditkarte“/„Mastercard“ **und** der Betrag entspricht genau einer Summe von Kartenumsätzen (sonst würden Kartenentgelte wie „Entgelt Visa-Kreditkarte“ erfasst) |
| Abrechnungszeitraum | Zusammenhängende Kaufdaten (`booking_date`) vor dem Tag der Abrechnung, deren Summe (Käufe minus Erstattungen) genau dem Betrag entspricht; Beginn = Tag nach dem Ende der vorigen Abrechnung derselben Karte, sonst frei gesucht (bis 62 Tage zurück). Ein Kauftag wird nie geteilt; bevorzugt das späteste Ende. Ohne exakte Summe: vom Beginn bis zum Vortag der Abrechnung. Vorgeschlagene automatische Zeiträume werden bei jeder Erkennung neu bestimmt (neue Kartenumsätze), bestätigte und von Hand angelegte bleiben |
| Plausibilität | Wird bei jeder Anzeige gerechnet: Abbuchung minus Summe der Kartenumsätze im Zeitraum. Abweichung ≠ 0 → Hinweis „fehlt ein Kartenimport oder ein Umsatz?“; fehlende Seite (Abbuchung bzw. Ausgleich nicht importiert) wird ebenfalls angezeigt |
| Von Hand markieren | Mit Gegenkonto: dort wird die Gegenbuchung gesucht (gleicher Betrag, ≤ 5 Tage, nie eine als „keine Umbuchung“ markierte) → Paar, sonst einseitig. Ist das Gegenkonto eine Kreditkarte (bzw. die Buchung ein Ausgleich auf der Karte) → Kartenabrechnung mit berechnetem Zeitraum. Ohne Gegenkonto: einseitig |
| Aufheben | „Aufheben“ in der Übersicht: alle Buchungen der Umbuchung → „keine Umbuchung“ (kommen nicht wieder). „Keine Umbuchung“ an einer Buchung: nur diese wird gesperrt; die Gegenbuchung einer automatischen Umbuchung wird frei, eine manuelle bleibt mit der übrigen Seite (Paar → einseitig) |
| Rückgängig | Umbuchungen ohne Buchung verschwinden; automatische Paare mit nur noch einer Seite werden aufgelöst und die übrige Buchung neu erkannt; manuelle werden einseitig |

**Korrektur Phase 4 nach dem Echtdaten-Test (3. Oktober 2026)**

| Frage | Entscheidung |
|-------|--------------|
| Abrechnungszeitraum der Karte | Nennt der Ausgleich (oder die Abbuchung) „Abrechnung vom TT.MM.JJJJ“, umfasst der Zeitraum die Kartenumsätze nach **Buchungstag der Bank** (`bank_booking_date`, Altbestand: Kaufdatum) vom Tag nach der vorigen Abrechnung derselben Karte bis einschließlich dieses Datums. Ohne vorige Abrechnung (oder länger als 62 Tage zurück): frühester Buchungstag, ab dem die Summe genau passt, sonst Tag nach demselben Datum im Vormonat. Ohne Datum im Text: bisheriges Verfahren nach Kaufdatum. Die Kartenumsätze zählen in allen Auswertungen weiter mit dem Kaufdatum |
| Kennzeichnung | `transfers.period_basis` (Migration 005): `bank_booking_date` bzw. `booking_date`; die Plausibilitätsprüfung und der Link in die Buchungsliste (`dateBasis=bank`) nutzen dasselbe Datum. Abrechnungen aus der Zeit davor (`NULL`) werden bei der nächsten Erkennung einmalig neu berechnet – auch bestätigte und von Hand angelegte |
| Sammelbestätigung | „Alle Paare bestätigen, deren Gegen-IBAN ein eigenes Konto ist“: nur vorgeschlagene Paare, bei denen eine Seite die IBAN des **anderen beteiligten** Kontos als Gegen-IBAN nennt. Anzahl steht auf dem Knopf und in der Rückfrage |

**Getroffen in Phase 5 (3. Oktober 2026)**

| Frage | Entscheidung |
|-------|--------------|
| Welche Konten | Jedes Konto mit Rolle `ausgaben` (laut § 5 „per Dauerauftrag gespeist“); die API rechnet für jedes Konto. Kein Bezug auf Name oder Bank |
| Dauerauftrag erkennen | Unter den Umbuchungen aufs Konto (Analyse, nichts wird gespeichert): eine Reihe setzt sich fort, wenn sie vom selben Konto kommt und höchstens 4 Tage vom Termin des Folgemonats (oder übernächsten, eine Ausführung darf fehlen) abweicht; ein Termin am 30., ausgeführt am 01., zählt zum Vormonat. Je Buchungstag gemeinsam zugeordnet: gleicher Betrag zuerst, sonst nächster Betrag = Betragsänderung. Mehrere gleiche Daueraufträge am selben Tag bleiben getrennt. Ab zwei Ausführungen Dauerauftrag; eine einzelne nur mit „Dauerauftrag“ im Text (vermutet). Beendet, wenn die nächste Ausführung bis zum Ende der Importe überfällig ist. Übrige Umbuchungen = Sonderüberweisungen |
| Monatsrechnung | Nach Buchungsdatum. Zufluss = Umbuchungen der Daueraufträge; Abbuchungen = Abflüsse ohne Umbuchungen minus Gutschriften ohne Umbuchung (Erstattungen); Differenz = Daueraufträge − Abbuchungen. Sonderüberweisungen und Umbuchungen weg vom Konto stehen separat („weitere Umbuchungen“) und zählen nicht in die Differenz – sie überdecken eine Unterdeckung nur |
| Verlauf | Nur vollständig importierte Monate, Fenster bis 12 Monate. Unterdeckungen in Folge bis zum letzten vollständigen Monat: 1–2 = Einzelfall, ab 3 = Trend; wächst/schrumpft = letzter gegen ersten Monat der Folge |
| Empfehlung | Durchschnitt (nicht Median – Jahresbeiträge müssen mitfinanziert sein) der Abbuchungen im Fenster + Puffer (80.-Perzentil nach Nearest-Rank minus Durchschnitt) + umzustellende Posten aus § 13, aufgerundet auf volle 10 €; ab 3 vollständigen Monaten. Verglichen mit der Summe der laufenden Daueraufträge |
| Ursachen | Abbuchungen je Posten (normalisierte Gegenpartei, sonst Gläubiger-ID, sonst Anfang des Verwendungszwecks), Durchschnitt je Monat der letzten 3 vollständigen gegen bis zu 6 davor; Anstieg ab 5 € gelistet, „neu“ wenn vorher nicht vorhanden. Preiserhöhung nur, wenn der alte Betrag mindestens zweimal in Folge gleich war. Gutschriften zählen hier nicht |
| Kontostand | Anker = Tagesendstand aus „Saldo nach Buchung“ (Reihenfolge innerhalb eines Tages über die Saldo-Kette), Kontostand laut Datei, von Hand erfasster Stand (`balance_anchors`, Stand am Ende des Tages, ein Eintrag je Tag). Jedes Datum rechnet vom nächstgelegenen Anker über die Buchungen (Buchungstag der Bank) – nie über eine Importlücke hinweg. Ohne Import-Saldo zeigt die Kontenübersicht den daraus gerechneten Stand |
| Saldoentwicklung | Konto im Minus / Polster; Reichweite = Guthaben ÷ durchschnittliche Unterdeckung der aktuellen Folge (abgerundet auf Monate) |
| § 13 Kandidaten | Wiederkehrende Abbuchungen (ohne Umbuchungen und Bargeld) auf aktiven Konten mit Rolle `einnahmen`, je Vertrag (Posten-Schlüssel plus Mandatsreferenz). Intervall aus dem mittleren Abstand (14-tägig 12–16, monatlich 26–35, quartalsweise 84–98, halbjährlich 175–190, jährlich 350–380 Tage; eine ausgelassene Abbuchung erlaubt); monatlich ab 3, 14-tägig ab 4, sonst ab 2 Abbuchungen; Betrag bis ±50 % vom Median, eine Ausreißerin erlaubt. Bewusst schlicht, die volle Abo-Erkennung kommt in Phase 6 |
| § 13 Entscheidung | `bypass_decisions` je Herkunftskonto und Vertrag: `move` (Ziel = Ausgabenkonto, automatisch bei genau einem) oder `keep`; zurücknehmbar. „Erhöhung“ = Summe der Monatsbeträge laufender `move`-Posten |
| § 13 Kontowechsel | Bleibt die Abbuchung auf dem Einnahmenkonto über ihren Termin hinaus aus (Toleranz 5–31 Tage je Intervall) und erscheint dieselbe Gegenpartei danach auf einem Ausgabenkonto → „umgestellt“, zählt nicht mehr in die Erhöhung (sie steckt dann in den Abbuchungen). Ohne Gegenstück → „beendet“ |

**Offene Punkte**

- **Deckungsprüfung an echten Daten prüfen:** Erkennung der Daueraufträge
  (Toleranz 4 Tage, Betragsänderung vs. neuer Dauerauftrag am selben Tag)
  und die Kandidaten für § 13 sind nur synthetisch getestet.

- **Umbuchungs-Erkennung an echten Daten prüfen:** Text der Visa-
  Sammelabbuchung auf dem Girokonto und des Ausgleichs auf dem
  Kartenkonto sind nur synthetisch nachgebildet. Beim ersten echten Import
  prüfen, ob die Begriffe in `transfer-detection.ts` passen.

- **Encoding der Exporte** (Volksbank, Comdirect) und Comdirect-Metadaten-
  bzw. „offen“-Zeilen noch ungeprüft – siehe `docs/bankformate.md` § 4.
- **Rollup-Pin per `overrides` (`rollup@4.63.6`):** Rollup 4.64.0
  (Abhängigkeit von Vite, erschienen 2. Oktober 2026) hängt beim
  Tree-Shaking von `react-dom` in einer Endlosschleife, `vite build`
  kommt nie an. Override entfernen, sobald eine gefixte Rollup-Version
  erscheint (prüfen: `npm run build` muss in wenigen Sekunden durchlaufen).
- **Rolle „Depot / Altersvorsorge“** steht im Anforderungsdokument, ist
  aber kein aktuelles Konto. Erst ergänzen, wenn ein solches Konto
  hinzukommt.


**Erkenntnisse aus dem ersten Echtdaten-Test (3. Oktober 2026)**

- **Kartenabrechnung passt nicht zur Summe (10 von 10 Abrechnungen)** –
  umgesetzt (siehe „Korrektur Phase 4 nach dem Echtdaten-Test“), an echten
  Daten noch zu prüfen:
  Beispiel: Ausgleich 504,20 € mit Text „Abrechnung vom 18.09.2026“, die
  Erkennung wählte Kartenumsätze 27.08.–28.09. (Kaufdatum) mit Summe
  438,39 €. Wahrscheinliche Ursache: Der Abrechnungszeitraum der Bank
  endet am **Abrechnungsdatum aus dem Text** und richtet sich nach dem
  **Buchungstag der Bank** (`bank_booking_date`), nicht nach dem Kaufdatum.
  Ein Kauf am 17.09., gebucht am 19.09., gehört zur nächsten Abrechnung.
- **Mehrere Daueraufträge aufs Ausgabenkonto** – umgesetzt in Phase 5: Am 11. gehen mehrere
  Überweisungen vom Einnahmen- aufs Ausgabenkonto (z. B. 10 €, 60 €,
  10 €, 100 €), dazu weitere an anderen Tagen. Die Deckungsprüfung (§ 12)
  muss **alle** Umbuchungen aufs Ausgabenkonto pro Monat summieren und
  die einzelnen Daueraufträge getrennt erkennen und anzeigen.
- **Comdirect liefert keinen Saldo** (weder in Zeilen noch in
  Metadaten) – umgesetzt in Phase 5. Für die Saldoentwicklung (§ 12.5) braucht es einen manuell
  erfassten Kontostand mit Datum; der Verlauf wird daraus über die
  Buchungen vor- und zurückgerechnet.

**Merkposten für spätere Phasen**

- Phase 7 (Startseite): Anzahl unbestätigter Umbuchungen und nicht
  passender Kartenabrechnungen als offene Punkte anzeigen.
- Phase 8 (Feinschliff): Der heutige Tag zählt in der Abdeckung als
  Lücke („03.10.2026 – 03.10.2026“) – heute und Zukunft nie als Lücke
  werten.
