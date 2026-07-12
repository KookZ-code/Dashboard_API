import type { FastifyInstance } from 'fastify';
import { authPreHandler } from '../helpers.js';
import { oracleCache } from '../db-oracle.js';

export default async function debugRoutes(app: FastifyInstance) {
  app.get('/api/v1/debug/ora', { preHandler: authPreHandler }, async (_req, reply) => {
    return reply.send({
      status: 'ok',
      data: {
        ora_enabled: oracleCache.enabled,
        hist_rows: 0, // TODO: expose from cache if needed
        live_rows: 0,
        msg: oracleCache.enabled ? 'Oracle enabled (ISO/FS)' : 'Oracle disabled',
      },
    });
  });
}
