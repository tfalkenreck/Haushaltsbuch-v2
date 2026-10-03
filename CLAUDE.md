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
| 3 | Kategorisierung: Kategorien, Regeln, manuelles Umkategorisieren, Lernen aus Korrekturen | offen |
| 4 | Umbuchungen und Kreditkarte | offen |
| 5 | Deckungsprüfung und Ausgaben am Ausgabenkonto vorbei | offen |
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

**Offene Punkte**

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

