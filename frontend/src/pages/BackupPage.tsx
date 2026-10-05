import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { downloadExport, fetchExportStatus, importExport, type ExportStatus } from '../api/backup';
import { notifyDataChanged } from '../lib/events';
import { formatTimestamp } from '../lib/format';

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

/**
 * Datensicherung (CLAUDE.md § 16): Export aller Daten als JSON per
 * Knopfdruck, Re-Import auf einem neuen Rechner in die leere Datenbank.
 * Vor jeder Datenbank-Umstellung (Migration) sichert die App die Datei
 * außerdem selbst nach data/backups/.
 */
export function BackupPage() {
  const [status, setStatus] = useState<ExportStatus | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  const reload = useCallback(() => {
    fetchExportStatus()
      .then(setStatus)
      .catch((err: unknown) => setError(message(err)));
  }, []);
  useEffect(reload, [reload]);

  async function run(action: () => Promise<string>) {
    setBusy(true);
    setError(null);
    setInfo(null);
    try {
      setInfo(await action());
      reload();
      notifyDataChanged();
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  }

  function handleImport(event: FormEvent) {
    event.preventDefault();
    if (!file) return;
    void run(async () => {
      const result = await importExport(file);
      const total = Object.values(result.rows).reduce((sum, n) => sum + n, 0);
      return `Übernommen: ${result.rows['accounts'] ?? 0} Konten, ${result.rows['transactions'] ?? 0} Buchungen – ${total} Einträge insgesamt.`;
    });
  }

  return (
    <section>
      <h2>Sicherung</h2>
      {error && <p className="error panel">{error}</p>}
      {info && <p className="panel notice">{info}</p>}

      <div className="panel">
        <h3>Export</h3>
        <p className="hint">
          Speichert alle Daten – Konten, Buchungen, Kategorien, Regeln, Umbuchungen, Fixkosten, Sparziele, Kontostände – in
          einer JSON-Datei (offenes Format, Beträge in Cent). Die Datei auf einen USB-Stick oder in eine Sicherung legen; sie
          enthält echte Kontodaten, also nicht weitergeben.
        </p>
        <p>
          {status?.lastExportAt ? <>Letzter Export: {formatTimestamp(status.lastExportAt)}</> : <>Noch nie exportiert.</>}
        </p>
        <button type="button" disabled={busy} onClick={() => void run(async () => `Gespeichert als „${await downloadExport()}“ (Ordner „Downloads“).`)}>
          Alle Daten exportieren
        </button>
      </div>

      <div className="panel">
        <h3>Re-Import auf einem neuen Rechner</h3>
        <p className="hint">
          Übernimmt eine Exportdatei – nur in eine leere Datenbank (direkt nach der Einrichtung) und nur vom selben
          Programmstand; vorher auf beiden Rechnern „Haushaltsbuch aktualisieren.cmd“ ausführen. Alles oder nichts: bei
          einem Fehler bleibt die Datenbank leer.
        </p>
        {status && !status.empty ? (
          <p className="muted">Diese Datenbank enthält schon Daten – ein Re-Import ist hier nicht möglich.</p>
        ) : (
          <form className="toolbar" onSubmit={handleImport}>
            <input type="file" accept=".json,application/json" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
            <button type="submit" disabled={busy || !file}>
              Exportdatei übernehmen
            </button>
          </form>
        )}
      </div>

      <div className="panel">
        <h3>Automatische Sicherung</h3>
        <p className="hint">
          Bevor ein Update die Datenbank umstellt (Migration), legt die App eine Kopie unter <code>data\backups\</code> an
          (Dateiname mit Datum und Uhrzeit, die letzten 10 bleiben). Zurückholen: App beenden, die Kopie nach{' '}
          <code>data\haushaltsbuch.db</code> kopieren und auf demselben Programmstand wieder starten.
        </p>
      </div>
    </section>
  );
}
