import 'dotenv/config';
import Fastify from 'fastify';
import { config } from './config.js';
import { pool } from './db.js';
import wbRoutes from './routes/wb.js';

const app = Fastify({ logger: true });

// ── Health endpoint (no auth) ─────────────────────────────────────────────
app.get('/api/v1/health', async (_req, reply) => {
  try {
    await pool.request().query('SELECT 1');
    return reply.send({ status: 'ok', db: 'ok', version: '1.0.0' });
  } catch (err) {
    return reply.code(503).send({
      status: 'error',
      db: 'error',
      message: err instanceof Error ? err.message : String(err),
    });
  }
});

// ── WB routes ─────────────────────────────────────────────────────────────
await app.register(wbRoutes);

// ── Start ─────────────────────────────────────────────────────────────────
try {
  await pool.connect();
  console.log('[db] Connected to SQL Server');
  await app.listen({ port: config.api.port, host: config.api.host });
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
