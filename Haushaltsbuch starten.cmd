@echo off
rem Haushaltsbuch starten (Doppelklick): Backend und Frontend zusammen,
rem der Browser öffnet sich, sobald die App erreichbar ist.
rem Beenden: dieses Fenster schließen (oder Strg+C und mit J bestätigen).
setlocal
chcp 65001 >nul
cd /d "%~dp0"
title Haushaltsbuch

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js wurde nicht gefunden. Bitte Node.js 24 LTS von https://nodejs.org installieren
  echo und dieses Skript danach erneut starten.
  pause
  exit /b 1
)

if not exist "node_modules\" (
  echo Erster Start: Abhängigkeiten werden installiert ^(npm install^) ...
  call npm.cmd install
  if errorlevel 1 (
    echo.
    echo Die Installation ist fehlgeschlagen – siehe Meldungen oben und README.md, Abschnitt „Stolpersteine“.
    pause
    exit /b 1
  )
)

echo Haushaltsbuch startet – der Browser öffnet sich gleich von selbst (http://127.0.0.1:5173).
echo Dieses Fenster offen lassen, solange die App benutzt wird.
echo.
call npm.cmd start
echo.
echo Haushaltsbuch wurde beendet.
pause
