# Bankformate (CSV-Exporte)

Referenz für die Adapter aus Phase 2. Alle Beispielzeilen sind
**synthetisch**: Namen, Beträge und Referenzen erfunden, IBANs sind
bekannte Dokumentations-Beispiel-IBANs. Struktur, Spaltenreihenfolge,
Quoting und Schreibweisen entsprechen den echten Exporten (Stand
Oktober 2026).

Offen: **Encoding** beider Banken (noch nicht geprüft), siehe § 4.

---

## 1. Volksbank OWL – Girokonto, Sparkonto **und Visa**

Girokonto und Visa-Kreditkarte exportieren **dasselbe Format**. Ein Adapter
reicht; `volksbank-visa` kann denselben Parser nutzen und nur die
Besonderheiten der Kartenumsätze (§ 1.3) ergänzen.

### 1.1 Aufbau

- Kopfzeile in **Zeile 1**, keine Metadatenzeilen davor.
- Trennzeichen `;`, **kein Quoting** im Beispiel – trotzdem quote-aware
  parsen.
- Header in ASCII-Umschrift (`Waehrung`, `Glaeubiger`).
- Datum `TT.MM.JJJJ`, Betrag mit Dezimalkomma und Vorzeichen (`-7,75`),
  Tausenderpunkt möglich.

Kopfzeile (18 Spalten):

```
Bezeichnung Auftragskonto;IBAN Auftragskonto;BIC Auftragskonto;Bankname Auftragskonto;Buchungstag;Valutadatum;Name Zahlungsbeteiligter;IBAN Zahlungsbeteiligter;BIC (SWIFT-Code) Zahlungsbeteiligter;Buchungstext;Verwendungszweck;Betrag;Waehrung;Saldo nach Buchung;Bemerkung;Gekennzeichneter Umsatz;Glaeubiger ID;Mandatsreferenz
```

Mapping:

| Spalte | Feld |
|---|---|
| Buchungstag | `booking_date` |
| Valutadatum | `value_date` |
| Name Zahlungsbeteiligter | `counterparty` |
| IBAN Zahlungsbeteiligter | Gegen-IBAN (Umbuchungserkennung!) |
| Buchungstext | Vorgangsart (Kartenzahlung girocard, Basislastschrift, …) |
| Verwendungszweck | `purpose` |
| Betrag | `amount_cents` |
| Waehrung | `currency` |
| Saldo nach Buchung | Saldo – Grundlage für Saldoentwicklung (§ 12.5) |
| Glaeubiger ID, Mandatsreferenz | SEPA-Lastschrift-Merkmale – starke Schlüssel für Abo-/Fixkostenerkennung |

### 1.2 Beispiel Girokonto (synthetisch)

```
Ostwestfalenkonto (inkl. Onlinepaket);DE89370400440532013000;GENODEM1GTL;Volksbank in Ostwestfalen eG;02.10.2026;02.10.2026;BAECKEREI MUSTERMANN;DE02120300000000202051;BYLADEM1001;Kartenzahlung girocard;B.CKEREI MUSTERMANN/Hauptstr. 1/Musterstadt01.10.2026 um 06:34:58 Uhr 12345678/123456/ECTL/      12345678/0000000000/1/1227 REF 111111/260046;-7,75;EUR;693,95;;;DE00ZZZ00000000001;111111
Ostwestfalenkonto (inkl. Onlinepaket);DE89370400440532013000;GENODEM1GTL;Volksbank in Ostwestfalen eG;02.10.2026;02.10.2026;SUPERMARKT BEISPIEL, MUSTERSTADT;DE02120300000000202051;BYLADEM1001;Kartenzahlung girocard;SUPERMARKT BEISPIEL, MUSTERSTADT/MUSTERSTADT/DE                   01.10.2026 um 17:51:55 Uhr 87654321/654321/ECTL/      12345678/0000000000/1/1227 REF 222222/260046;-13,71;EUR;701,70;;;DE00ZZZ00000000002;222222
```

Beobachtungen:

- **Umlaute im Verwendungszweck als `.`** (`B.CKEREI`, `G.tersloh`) – kommt
  so von der Bank, ist kein Encoding-Fehler. Normalisierung muss damit
  leben; Regeln/Erkennung eher auf `counterparty` als auf `purpose`.
- Bei Kartenzahlungen steht der **tatsächliche Zahlungszeitpunkt** im
  Verwendungszweck (`01.10.2026 um 06:34:58 Uhr`), Buchungstag ist ein Tag
  später. Gebucht wird mit Buchungstag (§ 2.4); Zahlungszeitpunkt ggf.
  später auswerten.
- Saldo-Spalte erlaubt eine Plausibilitätsprüfung pro Zeile
  (Saldo_vorher + Betrag = Saldo_nachher) → fehlende Zeilen erkennbar.

### 1.3 Beispiel Visa (synthetisch)

```
VISA Charge/mtl. Belastung;DE12500105170648489890;GENODEM1GTL;Volksbank in Ostwestfalen eG;02.10.2026;01.10.2026;;;;Basislastschrift;PAYPAL *STREAMINGDIENST  GB  12345678901            EUR             14,99      1,75% AUSLANDSUMS.     0,26Umsatz vom 30.09.2026      Visa Hauptkarte;-15,25;EUR;-352,24;;;;
```

Besonderheiten der Kartenumsätze:

- **`Name Zahlungsbeteiligter` ist leer.** Der Händler steht am Anfang des
  Verwendungszwecks (bis zur ersten Lücke aus mehreren Leerzeichen bzw.
  Ländercode). `counterparty` daraus ableiten.
- `Buchungstext` ist `Basislastschrift` – irreführend, sagt nichts über die
  Art des Umsatzes.
- **Auslandseinsatzentgelt** steckt im Betrag: 14,99 + 0,26 = 15,25. Der
  Verwendungszweck nennt Originalbetrag und Gebühr.
- **Echtes Umsatzdatum** im Verwendungszweck (`Umsatz vom 30.09.2026`),
  abweichend von Buchungstag und Valuta. Für die Monatszuordnung von
  Kartenumsätzen (§ 11 Zeitversatz) ist das das relevante Datum – prüfen,
  ob es als `booking_date` verwendet werden soll.
- `Saldo nach Buchung` ist negativ = offener Kartenbetrag.
- `IBAN Auftragskonto` ist eine eigene Kontonummer der Karte (Format wie
  IBAN).

### 1.4 Gemeinsame Regeln

- Jede Zeile trägt `IBAN Auftragskonto`. Der Import prüft, dass sie zur
  IBAN des gewählten Kontos passt, und **warnt bei Abweichung** (falsche
  Datei fürs Konto erwischt). Enthält eine Datei mehrere Auftragskonten,
  nur die passenden Zeilen importieren und den Rest melden.

---

## 2. Comdirect – Girokonto

### 2.1 Aufbau

- **Alle Felder in Anführungszeichen**, Trennzeichen `;`, **Semikolon am
  Zeilenende** (leere 6. Spalte).
- Nur 5 Spalten, **keine eigene Spalte für Gegenpartei, Gegen-IBAN oder
  Saldo.**

Kopfzeile:

```
"Buchungstag";"Wertstellung (Valuta)";"Vorgang";"Buchungstext";"Umsatz in EUR";
```

Beispiel (synthetisch):

```
"02.10.2026";"02.10.2026";"Lastschrift / Belastung";"Auftraggeber: Beispiel Versicherung Aktiengesellschaft Buchungstext: BEITRAG 00/000000000 10/26 Ref. 0A0B0C0D0E0F0G0H/0000";"-27,88";
```

Mapping:

| Spalte | Feld |
|---|---|
| Buchungstag | `booking_date` |
| Wertstellung (Valuta) | `value_date` |
| Vorgang | Vorgangsart |
| Buchungstext | enthält **Gegenpartei, Verwendungszweck und Referenz** in einem Feld |
| Umsatz in EUR | `amount_cents`, Währung immer EUR |

### 2.2 Buchungstext zerlegen

Das Feld folgt dem Muster `<Label>: <Wert> <Label>: <Wert> …`. Bekannt:

- `Auftraggeber:` → `counterparty` (bei Lastschriften/Eingängen)
- `Buchungstext:` → `purpose`
- `Ref.` → Referenz (nicht in `purpose`, nicht in den Hash-Text)

Vermutlich weitere Labels, noch nicht gesehen und **zu verifizieren**:
`Empfänger:` (ausgehende Überweisung), `Kto/IBAN:`, `BLZ/BIC:`. Parser so
bauen, dass unbekannte Labels nicht verloren gehen (Rest landet in
`purpose`).

### 2.3 Zu prüfen beim echten Export

- Stehen **Metadatenzeilen vor der Kopfzeile** (Kontoname, Zeitraum, neuer
  Kontostand) oder **Fußzeilen** (alter Kontostand)? Header suchen, nicht
  annehmen.
- Gibt es Zeilen mit Buchungstag **`offen`** (vorgemerkte Umsätze)? Diese
  nicht als Buchung importieren, sondern melden – sie ändern sich noch.
- Saldo fehlt in den Zeilen. Falls ein Kontostand in den Metadaten steht,
  als Saldo zum Exportzeitpunkt übernehmen.

---

## 3. Konsequenzen für den Import

- Volksbank-Adapter liefert `counterparty_iban` mit → Umbuchungserkennung
  über eigene IBANs ist dort direkt möglich. Bei Comdirect nur über
  Betrag/Datum-Paarung und Verwendungszweck.
- Volksbank liefert Gläubiger-ID und Mandatsreferenz → in der Datenbank
  speichern (eigene Spalten, neue Migration), für Abo-Erkennung in Phase 6.
- Volksbank liefert Saldo pro Zeile → speichern; Comdirect nicht.

## 4. Offene Fragen

- [ ] Encoding Volksbank-Export (Editor → unten rechts)
- [ ] Encoding Comdirect-Export
- [ ] Comdirect: Zeilen vor/nach der Kopfzeile? Zeilen mit „offen“?
- [ ] Visa: `Umsatz vom`-Datum als Buchungsdatum verwenden? (Empfehlung: ja)
