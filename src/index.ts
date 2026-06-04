import 'dotenv/config';
import Fastify from 'fastify';
import { config } from './config.js';
import { pool } from './db.js';
import masterRoutes      from './routes/master.js';
import overviewRoutes    from './routes/overview.js';
import utilizationRoutes from './routes/utilization.js';
import downtimeRoutes    from './routes/downtime.js';
import inventoryRoutes   from './routes/inventory.js';
import techRoutes        from './routes/tech.js';
import wbRoutes          from './routes/wb.js';
import debugRoutes       from './routes/debug.js';

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

// ── Routes ────────────────────────────────────────────────────────────────
await app.register(masterRoutes);
await app.register(overviewRoutes);
await app.register(utilizationRoutes);
await app.register(downtimeRoutes);
await app.register(inventoryRoutes);
await app.register(techRoutes);
await app.register(wbRoutes);
await app.register(debugRoutes);

// ── Start ─────────────────────────────────────────────────────────────────
try {
  await pool.connect();
  console.log('[db] Connected to SQL Server');
  await app.listen({ port: config.api.port, host: config.api.host });
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
