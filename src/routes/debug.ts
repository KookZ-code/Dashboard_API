import type { FastifyInstance } from 'fastify';
import { authPreHandler } from '../helpers.js';

export default async function debugRoutes(app: FastifyInstance) {
  app.get('/api/v1/debug/ora', { preHandler: authPreHandler }, async (_req, reply) => {
    return reply.send({ status: 'ok', data: { ora_enabled: false, rows: 0, msg: 'Oracle not enabled' } });
  });
}
