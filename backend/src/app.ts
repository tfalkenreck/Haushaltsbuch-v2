import Fastify, { type FastifyInstance } from 'fastify';

export interface AppOptions {
  logger?: boolean;
}

/**
 * Baut die Fastify-Instanz ohne sie zu starten – so lässt sie sich in Tests
 * per app.inject() ansprechen. Routen kommen in den folgenden Phasen über
 * src/routes/ hinzu.
 */
export function buildApp(options: AppOptions = {}): FastifyInstance {
  const app = Fastify({ logger: options.logger ?? false });

  app.get('/api/health', async () => ({ status: 'ok' }));

  return app;
}
