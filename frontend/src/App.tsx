import { useEffect, useState } from 'react';

type Status = 'prüfe…' | 'verbunden' | 'nicht erreichbar';

// Platzhalter fürs Gerüst: zeigt nur, ob Frontend → Backend funktioniert.
export function App() {
  const [status, setStatus] = useState<Status>('prüfe…');

  useEffect(() => {
    fetch('/api/health')
      .then((res) => setStatus(res.ok ? 'verbunden' : 'nicht erreichbar'))
      .catch(() => setStatus('nicht erreichbar'));
  }, []);

  return (
    <main style={{ fontFamily: 'system-ui, sans-serif', padding: '2rem' }}>
      <h1>Haushaltsbuch</h1>
      <p>Backend: {status}</p>
    </main>
  );
}
