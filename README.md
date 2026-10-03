# Haushaltsbuch

Lokales Haushaltsbuch: liest Kontoauszüge (CSV) ein, erkennt Umbuchungen,
Kreditkartenabrechnungen und Fixkosten und prüft vor allem, ob der
Dauerauftrag aufs Ausgabenkonto noch reicht.

Alle Daten bleiben auf dem eigenen Rechner – keine Cloud, keine Telemetrie.
Die vollständige Spezifikation steht in [`CLAUDE.md`](CLAUDE.md).

> **Stand:** Projektgerüst (Phase 0). Die App zeigt bisher nur, ob Frontend
> und Backend miteinander sprechen.

---

## Voraussetzungen

| Was     | Version | Hinweis |
|---------|---------|---------|
| Node.js | **24 LTS** (22 LTS geht auch) | [nodejs.org](https://nodejs.org) → „LTS“, Windows-Installer (`.msi`, x64) |
| Git     | aktuell | [git-scm.com](https://git-scm.com) |

Nicht nötig: Python, Visual Studio Build Tools, `node-gyp`. Die
SQLite-Bibliothek (`better-sqlite3`) bringt für Node 22 und 24 fertige
Windows-Binaries mit.

Node-Version prüfen:

```powershell
node -v
```

Muss mit `v24.` oder `v22.` beginnen. Eine andere Hauptversion bricht die Installation
bewusst ab (`engine-strict`), statt still einen Compiler-Build zu versuchen.

---

## Einrichten unter Windows

In **PowerShell** im Projektordner:

```powershell
git clone <repo-url> haushaltsbuch
cd haushaltsbuch
npm.cmd install
```

> **Warum `npm.cmd` statt `npm`?** PowerShell startet bei `npm` das Skript
> `npm.ps1`, das die Standard-Ausführungsrichtlinie blockiert
> („Die Ausführung von Skripts ist auf diesem System deaktiviert“).
> `npm.cmd` umgeht das ohne Systemänderung. Alternativ einmalig:
> `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned` – danach geht auch
> `npm`. In der Eingabeaufforderung (`cmd.exe`) funktioniert `npm` immer.

Prüfen, ob alles läuft:

```powershell
npm.cmd test
npm.cmd run typecheck
```

---

## Starten

```powershell
npm.cmd run dev
```

Startet Backend und Frontend zusammen in einem Fenster. Dann im Browser:
**http://127.0.0.1:5173**

| Teil     | Adresse                 |
|----------|-------------------------|
| Frontend | http://127.0.0.1:5173   |
| Backend  | http://127.0.0.1:3001/api |

Beenden mit `Strg + C` (Rückfrage mit `J` bestätigen).

Ein Doppelklick-Startskript folgt in Phase 8.

---

## Stolpersteine unter Windows

**„Die Ausführung von Skripts ist auf diesem System deaktiviert“**
→ `npm.cmd` statt `npm` verwenden (siehe oben).

**esbuild: Installskript blockiert / „The package @esbuild/win32-x64 could
not be found“**
Vite und `tsx` nutzen esbuild. Dessen Installskript muss laufen dürfen, um
die passende Windows-Binary einzurichten. Prüfen und reparieren:

```powershell
npm.cmd config get ignore-scripts   # muss "false" sein
npm.cmd config set ignore-scripts false
npm.cmd rebuild esbuild
```

Hält ein Virenscanner `esbuild.exe` fest, den Projektordner dort als
Ausnahme eintragen und `npm.cmd rebuild esbuild` wiederholen.

**`better-sqlite3`: Fehler mit `node-gyp`, „gyp ERR!“ oder „Python not
found“**
Bedeutet fast immer: falsche Node-Version, für die es keine fertige Binary
gibt. Node 24 LTS installieren, dann:

```powershell
Remove-Item -Recurse -Force node_modules
npm.cmd install
```

**„Unsupported engine“ beim Installieren**
Node-Version passt nicht (siehe Voraussetzungen). Gewollt – nicht mit
`--force` übergehen.

**Port belegt („EADDRINUSE“ / „Port 5173 is already in use“)**
Ein alter Prozess läuft noch. Fenster schließen oder:

```powershell
Get-NetTCPConnection -LocalPort 3001,5173 | Select-Object OwningProcess
Stop-Process -Id <Prozess-ID>
```

**Skripte mit Unix-Syntax**
Alle `npm`-Skripte sind so geschrieben, dass sie unter `cmd.exe` laufen.
Neue Skripte bitte ebenso (kein `rm -rf`, kein `FOO=bar befehl`).

---

## Linux / macOS

Gleich, nur mit `npm` statt `npm.cmd`:

```bash
npm install
npm run dev
```

---

## Befehle

| Befehl                  | Wirkung |
|-------------------------|---------|
| `npm.cmd run dev`       | Backend + Frontend im Entwicklungsmodus |
| `npm.cmd test`          | alle Tests einmal |
| `npm.cmd run test:watch`| Tests im Beobachtungsmodus |
| `npm.cmd run typecheck` | TypeScript-Prüfung beider Teile |
| `npm.cmd run build`     | Produktionsbuild nach `dist/` |

---

## Projektstruktur

```
backend/    Fastify + SQLite (better-sqlite3)
  src/        app.ts, index.ts, db/, adapters/, routes/, services/, lib/
  test/       Tests und synthetische Fixtures
frontend/   React + Vite
  src/        api/, pages/, components/, lib/
data/       (wird zur Laufzeit angelegt, nicht im Repository)
```

---

## Datenschutz

- Die Datenbank liegt in `data/` und ist von der Versionierung
  ausgeschlossen – ebenso alle `.csv`-Dateien außer den synthetischen
  Test-Fixtures. Echte Kontoauszüge also gefahrlos im Projektordner
  ablegen, aber nie mit `git add -f` erzwingen.
- Backend und Frontend lauschen nur auf `127.0.0.1`, sind also von anderen
  Geräten im Netz nicht erreichbar.
- **Datensicherung:** Geht die Festplatte kaputt, ist alles weg. Bis zur
  Export-Funktion (Phase 8) den Ordner `data/` regelmäßig sichern – bei
  beendeter App.
