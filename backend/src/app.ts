import Fastify, { type FastifyInstance } from 'fastify';
import type { Db } from './db/connection.js';
import { AppError } from './lib/errors.js';
import { accountRoutes } from './routes/accounts.js';

export interface AppOptions {
  /** Geöffnete und migrierte Datenbank (Tests: ':memory:'). */
  db: Db;
  logger?: boolean;
}

/**
 * Baut die Fastify-Instanz ohne sie zu starten – so lässt sie sich in Tests
 * per app.inject() ansprechen.
 */
export function buildApp(options: AppOptions): FastifyInstance {
  const app = Fastify({ logger: options.logger ?? false });

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof AppError) {
      return reply.status(error.statusCode).send({ error: error.message });
    }
    const statusCode = (error as { statusCode?: number }).statusCode;
    if (statusCode !== undefined && statusCode >= 400 && statusCode < 500) {
      return reply.status(statusCode).send({ error: `Ungültige Anfrage: ${(error as Error).message}` });
    }
    app.log.error(error);
    return reply.status(500).send({ error: 'Interner Fehler' });
  });

  app.get('/api/health', async () => ({ status: 'ok' }));

  accountRoutes(app, options.db);

  return app;
}
