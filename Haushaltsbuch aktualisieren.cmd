@echo off
rem Haushaltsbuch aktualisieren (Doppelklick): neueste Version holen
rem (git pull), Abhängigkeiten installieren (npm install), Tests ausführen
rem (npm test). Die Datenbank sichert die App beim nächsten Start selbst,
rem bevor ein Update sie umstellt (data\backups\).
setlocal
chcp 65001 >nul
cd /d "%~dp0"
title Haushaltsbuch aktualisieren

echo Bitte die App vorher beenden (Fenster „Haushaltsbuch“ schließen).
pause

where git >nul 2>nul
if errorlevel 1 (
  echo Git wurde nicht gefunden. Bitte Git von https://git-scm.com installieren.
  goto fehler
)

echo.
echo [1/3] Neueste Version holen (git pull) ...
git pull --ff-only
if errorlevel 1 (
  echo git pull ist fehlgeschlagen – gibt es lokale Änderungen? „git status“ zeigt sie.
  goto fehler
)

echo.
echo [2/3] Abhängigkeiten installieren (npm install) ...
call npm.cmd install
if errorlevel 1 goto fehler

echo.
echo [3/3] Tests (npm test) ...
call npm.cmd test
if errorlevel 1 (
  echo Tests sind fehlgeschlagen – die App lieber noch nicht benutzen und den Fehler melden.
  goto fehler
)

echo.
echo Fertig: Haushaltsbuch ist aktuell. Starten mit „Haushaltsbuch starten.cmd“.
pause
exit /b 0

:fehler
echo.
echo Aktualisierung abgebrochen – siehe Meldungen oben.
pause
exit /b 1
