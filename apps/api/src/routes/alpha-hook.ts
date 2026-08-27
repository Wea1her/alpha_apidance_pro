import { AlphaHookIngestor } from '@alpha-research/alpha';
import type { FastifyInstance } from 'fastify';
import { secretsEqual } from '../plugins/security.js';
import type { ApiDatabase } from '../types.js';

export interface AlphaHookRouteOptions {
  database: ApiDatabase;
  hookSecret: string;
}

export function registerAlphaHookRoute(app: FastifyInstance, options: AlphaHookRouteOptions): void {
  const ingestor = new AlphaHookIngestor(options.database);

  app.post<{ Params: { secret: string } }>('/webhooks/alpha/:secret', async (request, reply) => {
    if (!secretsEqual(request.params.secret, options.hookSecret)) {
      return reply.code(404).send({ error: 'not_found' });
    }
    const result = await ingestor.ingest(request.body);
    return reply.code(result.duplicate ? 200 : 202).send({
      accepted: true,
      duplicate: result.duplicate,
      status: result.decodeStatus
    });
  });
}
