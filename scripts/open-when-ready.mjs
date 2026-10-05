// Öffnet die App im Standardbrowser, sobald Backend und Frontend antworten.
// Wird von `npm start` (und damit von „Haushaltsbuch starten.cmd“) neben
// Backend und Frontend gestartet. Fragt nur 127.0.0.1 ab – keine externen
// Zugriffe. Beendet sich immer mit 0, damit `concurrently` nichts abbricht.
import { spawn } from 'node:child_process';

const APP_URL = 'http://127.0.0.1:5173/';
const CHECKS = ['http://127.0.0.1:3001/api/health', APP_URL];
const TIMEOUT_MS = 120_000;
const INTERVAL_MS = 500;

async function reachable(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
    return res.ok;
  } catch {
    return false;
  }
}

function openBrowser(url) {
  const options = { detached: true, stdio: 'ignore' };
  const child =
    process.platform === 'win32'
      ? spawn('cmd.exe', ['/d', '/s', '/c', `start "" "${url}"`], { ...options, windowsVerbatimArguments: true })
      : spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [url], options);
  child.on('error', () => console.log(`Browser ließ sich nicht öffnen – bitte ${url} selbst aufrufen.`));
  child.unref();
}

const deadline = Date.now() + TIMEOUT_MS;
for (;;) {
  const results = await Promise.all(CHECKS.map(reachable));
  if (results.every(Boolean)) {
    console.log(`Haushaltsbuch läuft: ${APP_URL} – zum Beenden dieses Fenster schließen oder Strg+C.`);
    openBrowser(APP_URL);
    break;
  }
  if (Date.now() > deadline) {
    console.log(`Die App antwortet nach ${TIMEOUT_MS / 1000} Sekunden noch nicht – Meldungen oben prüfen, dann ${APP_URL} selbst aufrufen.`);
    break;
  }
  await new Promise((resolve) => setTimeout(resolve, INTERVAL_MS));
}
