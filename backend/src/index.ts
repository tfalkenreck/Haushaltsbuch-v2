import { buildApp } from './app.js';

// Nur lokal erreichbar – nie 0.0.0.0.
const HOST = '127.0.0.1';
const PORT = Number(process.env['PORT'] ?? 3001);

const app = buildApp({ logger: true });

try {
  await app.listen({ host: HOST, port: PORT });
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
