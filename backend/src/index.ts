import { buildApp } from './app.js';
import { openDatabase, resolveDbPath } from './db/connection.js';
import { migrate } from './db/migrate.js';

// Nur lokal erreichbar – nie 0.0.0.0.
const HOST = '127.0.0.1';
const PORT = Number(process.env['PORT'] ?? 3001);

const db = openDatabase(resolveDbPath());
const { applied } = migrate(db);

const app = buildApp({ db, logger: true });
if (applied.length > 0) app.log.info({ applied }, 'Migrationen angewendet');

app.addHook('onClose', async () => {
  db.close();
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void app.close().then(() => process.exit(0));
  });
}

try {
  await app.listen({ host: HOST, port: PORT });
} catch (err) {
  app.log.error(err);
  db.close();
  process.exit(1);
}
