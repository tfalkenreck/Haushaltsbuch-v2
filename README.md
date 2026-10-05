# Haushaltsbuch

Lokales Haushaltsbuch: liest Kontoauszüge (CSV) ein, erkennt Umbuchungen,
Kreditkartenabrechnungen und Fixkosten und prüft vor allem, ob der
Dauerauftrag aufs Ausgabenkonto noch reicht.

Alle Daten bleiben auf dem eigenen Rechner – keine Cloud, keine Telemetrie.
Die vollständige Spezifikation steht in [`CLAUDE.md`](CLAUDE.md).

> **Stand:** Phase 8 – fertig. Konten mit Rolle und Bank-Adapter,
> CSV-Import (Volksbank OWL Giro/Spar/Visa, Comdirect) mit
> Duplikaterkennung, Abdeckung und Rückgängig; Kategorien und Regeln;
> Umbuchungen und Kartenabrechnungen (Zuordnungsregel je Karte
> kalibriert); Deckungsprüfung des Ausgabenkontos; Fixkosten und Abos
> (Verträge über Mandatsreferenz, Gläubiger-ID und IBAN getrennt);
> Übersicht, Budget 50/30/20, Prognose, Sparziele; Export/Re-Import,
> automatische Sicherung vor Datenbank-Umstellungen, Start per Doppelklick.

---

## Kurz: Benutzen unter Windows

| Was | Wie |
|-----|-----|
| **Starten** | Doppelklick auf **`Haushaltsbuch starten.cmd`** – der Browser öffnet sich von selbst, sobald die App bereit ist |
| **Beenden** | Das schwarze Fenster „Haushaltsbuch“ schließen |
| **Aktualisieren** | App beenden, Doppelklick auf **`Haushaltsbuch aktualisieren.cmd`** |
| **Sichern** | In der App: Reiter **Sicherung** → „Alle Daten exportieren“ (die Übersicht erinnert nach 30 Tagen) |

Die einmalige Einrichtung steht im nächsten Abschnitt.

---

## Einrichten (einmalig)

### Voraussetzungen

| Was     | Version | Hinweis |
|---------|---------|---------|
| Node.js | **24 LTS** (22 LTS geht auch) | [nodejs.org](https://nodejs.org) → „LTS“, Windows-Installer (`.msi`, x64) |
| Git     | aktuell | [git-scm.com](https://git-scm.com) – Standardeinstellungen genügen |

Nicht nötig: Python, Visual Studio Build Tools, `node-gyp`. Die
SQLite-Bibliothek (`better-sqlite3`) bringt für Node 22 und 24 fertige
Windows-Binaries mit.

Node-Version prüfen (PowerShell oder Eingabeaufforderung):

```powershell
node -v
```

Muss mit `v24.` oder `v22.` beginnen. Eine andere Hauptversion bricht die
Installation bewusst ab (`engine-strict`), statt still einen Compiler-Build
zu versuchen.

### Herunterladen

In **PowerShell** in dem Ordner, in dem das Haushaltsbuch liegen soll:

```powershell
git clone <repo-url> haushaltsbuch
```

Danach im Explorer den Ordner `haushaltsbuch` öffnen und
**`Haushaltsbuch starten.cmd`** doppelklicken. Beim ersten Start
installiert das Skript die Abhängigkeiten (`npm install`, ein bis zwei
Minuten), danach startet die App und öffnet den Browser.

Tipp: Rechtsklick auf `Haushaltsbuch starten.cmd` → „Verknüpfung erstellen“
und die Verknüpfung auf den Desktop ziehen.

Fragt Windows beim ersten Start „Windows hat den Start einer unbekannten
App verhindert“ (SmartScreen): „Weitere Informationen“ → „Trotzdem
ausführen“. Die Skripte sind einfache Textdateien und lassen sich im Editor
ansehen.

---

## Starten und Beenden

**`Haushaltsbuch starten.cmd`** startet Backend und Frontend zusammen in
einem Fenster und öffnet **http://127.0.0.1:5173** im Standardbrowser,
sobald beide antworten. Das Fenster offen lassen, solange die App benutzt
wird; Schließen beendet sie.

Von Hand (PowerShell im Projektordner) geht dasselbe mit:

```powershell
npm.cmd start      # wie das Startskript, inkl. Browser
npm.cmd run dev    # ohne Browser
```

| Teil     | Adresse                   |
|----------|---------------------------|
| Frontend | http://127.0.0.1:5173     |
| Backend  | http://127.0.0.1:3001/api |

> **Warum `npm.cmd` statt `npm`?** PowerShell startet bei `npm` das Skript
> `npm.ps1`, das die Standard-Ausführungsrichtlinie blockiert
> („Die Ausführung von Skripts ist auf diesem System deaktiviert“).
> `npm.cmd` umgeht das ohne Systemänderung. In der Eingabeaufforderung
> (`cmd.exe`) und in den `.cmd`-Skripten funktioniert es ohnehin.

---

## Aktualisieren

1. App beenden (Fenster „Haushaltsbuch“ schließen).
2. Doppelklick auf **`Haushaltsbuch aktualisieren.cmd`**. Das Skript
   - holt die neueste Version (`git pull`),
   - installiert die Abhängigkeiten (`npm install`),
   - führt die Tests aus (`npm test`).
3. Wieder starten. Stellt das Update die Datenbank um (Migration), sichert
   die App sie vorher automatisch (siehe unten).

Schlägt ein Schritt fehl, bricht das Skript ab und lässt das Fenster offen.
Typisch bei `git pull`: lokale Änderungen an Dateien des Projekts –
`git status` zeigt sie.

---

## Datensicherung

### Export (von Hand, empfohlen monatlich)

Reiter **Sicherung** → **„Alle Daten exportieren“** speichert eine Datei
`haushaltsbuch-JJJJ-MM-TT-export.json` im Download-Ordner: alle Konten,
Buchungen, Kategorien, Regeln, Umbuchungen, Fixkosten, Sparziele und
Kontostände in einem offenen Format (JSON, Beträge in Cent). Die Übersicht
erinnert, wenn der letzte Export länger als **30 Tage** zurückliegt.

Die Datei enthält echte Kontodaten: auf einen USB-Stick oder in eine eigene
Sicherung legen, nicht weitergeben. (`*-export.json` ist von Git
ausgeschlossen.)

### Re-Import auf einem neuen Rechner

1. Auf dem neuen Rechner einrichten (siehe oben) und einmal starten.
2. Beide Rechner auf denselben Stand bringen (`Haushaltsbuch aktualisieren.cmd`) –
   der Re-Import verlangt denselben Programmstand.
3. Reiter **Sicherung** → Exportdatei auswählen → **„Exportdatei übernehmen“**.

Der Re-Import geht nur in eine **leere** Datenbank (direkt nach der
Einrichtung) und ist „alles oder nichts“: bei einem Fehler bleibt die
Datenbank leer.

### Automatische Sicherung vor Datenbank-Umstellungen

Bevor die App nach einem Update die Datenbank umstellt, kopiert sie sie
nach `data\backups\haushaltsbuch-JJJJ-MM-TT_HHMMSS-vor-NNN.db`
(SQLite-Backup, auch bei laufender Datenbank vollständig). Die letzten
**10** Sicherungen bleiben, ältere werden gelöscht. Schlägt die Sicherung
fehl, startet die App nicht und ändert nichts.

Zurückholen: App beenden, die gewünschte Sicherung nach
`data\haushaltsbuch.db` kopieren (die alte vorher umbenennen, die Dateien
`haushaltsbuch.db-wal` und `-shm` daneben löschen) und mit dem Programmstand
von damals starten – neuere Programmstände stellen sie beim Start wieder um.

### Datenbank-Datei

Die SQLite-Datei liegt unter `data\haushaltsbuch.db` und wird beim ersten
Start samt Ordner angelegt. Ein anderer Pfad lässt sich über die
Umgebungsvariable `HAUSHALTSBUCH_DB` setzen (relativ zum Projektordner oder
absolut), in PowerShell z. B.:

```powershell
$env:HAUSHALTSBUCH_DB = "data\test.db"; npm.cmd start
```

Sicherungen landen dann in `backups\` neben dieser Datei.

---

## Stolpersteine unter Windows

**„Die Ausführung von Skripts ist auf diesem System deaktiviert“**
→ `npm.cmd` statt `npm` verwenden (siehe oben) oder die `.cmd`-Skripte
doppelklicken.

**Der Browser öffnet sich nicht**
Die Adresse **http://127.0.0.1:5173** selbst aufrufen. Antwortet die App
nach zwei Minuten noch nicht, steht der Grund in den Meldungen im Fenster.

**„install-scripts … not yet covered by allowScripts“ (npm 11)**
npm 11 führt Installskripte nur für freigegebene Pakete aus. Hier brauchen
`esbuild` (Vite, `tsx`) und `better-sqlite3` ihr Skript, um die
Windows-Binaries einzurichten. Die Freigaben stehen versionsgenau unter
`allowScripts` in der `package.json` und sind committet – ein frischer Klon
braucht nichts zu tun.

Erscheint die Warnung nach einem Versionsupdate erneut, die neuen Versionen
freigeben, nachbauen und die geänderte `package.json` committen:

```
npm install-scripts approve esbuild
npm install-scripts approve better-sqlite3
npm rebuild esbuild better-sqlite3
```

Nur Pakete freigeben, deren Skript bekannt und nötig ist
(`npm install-scripts ls` zeigt sie).

**„The package @esbuild/win32-x64 could not be found“**
Das esbuild-Skript ist nicht gelaufen: wie oben freigeben und
`npm rebuild esbuild`. Hält ein Virenscanner `esbuild.exe` fest, den
Projektordner dort als Ausnahme eintragen und den Rebuild wiederholen.

**`better-sqlite3`: Fehler mit `node-gyp`, „gyp ERR!“ oder „Python not
found“**
Bedeutet fast immer: falsche Node-Version, für die es keine fertige Binary
gibt. Node 24 LTS installieren, dann:

```powershell
Remove-Item -Recurse -Force node_modules
npm.cmd install
```

**`npm install` beim Aktualisieren: „EBUSY“ / „EPERM“ bei `better_sqlite3.node`**
Die App läuft noch und hält die Datei fest. Fenster „Haushaltsbuch“
schließen und das Update-Skript erneut starten.

**„Unsupported engine“ beim Installieren**
Node-Version passt nicht (siehe Voraussetzungen). Gewollt – nicht mit
`--force` übergehen.

**Port belegt („EADDRINUSE“ / „Port 5173 is already in use“)**
Ein altes Fenster läuft noch. Schließen oder:

```powershell
Get-NetTCPConnection -LocalPort 3001,5173 | Select-Object OwningProcess
Stop-Process -Id <Prozess-ID>
```

**Skripte mit Unix-Syntax**
Alle `npm`-Skripte sind so geschrieben, dass sie unter `cmd.exe` laufen.
Neue Skripte bitte ebenso (kein `rm -rf`, kein `FOO=bar befehl`). Die
`.cmd`-Dateien werden mit CRLF-Zeilenenden ausgecheckt (`.gitattributes`).

---

## Linux / macOS

Gleich, nur mit `npm` statt `npm.cmd` und ohne die `.cmd`-Skripte:

```bash
npm install
npm start          # öffnet den Browser
git pull --ff-only && npm install && npm test   # aktualisieren
```

---

## Befehle

| Befehl                  | Wirkung |
|-------------------------|---------|
| `npm.cmd start`         | Backend + Frontend, öffnet den Browser (wie das Startskript) |
| `npm.cmd run dev`       | Backend + Frontend ohne Browser |
| `npm.cmd test`          | alle Tests einmal |
| `npm.cmd run test:watch`| Tests im Beobachtungsmodus |
| `npm.cmd run typecheck` | TypeScript-Prüfung beider Teile |
| `npm.cmd run build`     | Produktionsbuild nach `dist/` |

---

## Projektstruktur

```
Haushaltsbuch starten.cmd       Start per Doppelklick
Haushaltsbuch aktualisieren.cmd git pull, npm install, npm test
backend/    Fastify + SQLite (better-sqlite3)
  src/        app.ts, index.ts, db/ (inkl. Sicherung), adapters/, routes/, services/, lib/
  test/       Tests und synthetische Fixtures
frontend/   React + Vite
  src/        api/, pages/, components/, lib/
scripts/    open-when-ready.mjs (öffnet den Browser, sobald die App antwortet)
data/       Datenbank und Sicherungen (zur Laufzeit angelegt, nicht im Repository)
```

---

## Datenschutz

- Die Datenbank und ihre Sicherungen liegen in `data/` und sind von der
  Versionierung ausgeschlossen – ebenso alle `.csv`-Dateien außer den
  synthetischen Test-Fixtures und alle `*-export.json`. Echte Kontoauszüge
  also gefahrlos im Projektordner ablegen, aber nie mit `git add -f`
  erzwingen.
- Backend und Frontend lauschen nur auf `127.0.0.1`, sind also von anderen
  Geräten im Netz nicht erreichbar. Die App stellt keine Verbindungen ins
  Internet her.
