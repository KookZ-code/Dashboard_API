// Must be set BEFORE any Date usage so new Date() / getHours() use Thai local time
process.env.TZ = 'Asia/Bangkok';

import 'dotenv/config';
import Fastify from 'fastify';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import { config } from './config.js';
import { pool } from './db.js';
import { initReplica, startReplicaSync } from './db-sqlite.js';
import masterRoutes      from './routes/master.js';
import overviewRoutes    from './routes/overview.js';
import utilizationRoutes from './routes/utilization.js';
import downtimeRoutes    from './routes/downtime.js';
import inventoryRoutes   from './routes/inventory.js';
import techRoutes        from './routes/tech.js';
import wbRoutes          from './routes/wb.js';
import daRoutes          from './routes/da.js';
import wbUphRoutes       from './routes/wb-uph.js';
import daUphRoutes       from './routes/da-uph.js';
import debugRoutes       from './routes/debug.js';
import liveRoutes        from './routes/live.js';
import authRoutes        from './routes/auth.js';
import usersRoutes       from './routes/users.js';
import permissionsRoutes, { ensurePermissionsTable } from './routes/permissions.js';

const app = Fastify({ logger: true });

// ── Swagger ───────────────────────────────────────────────────────────────
await app.register(swagger, {
  openapi: {
    info: { title: 'Dashboard API', version: '1.0.0', description: 'EMH Dashboard API — MSSQL / SQLite / PostgreSQL' },
    tags: [
      { name: 'health',      description: 'Health check' },
      { name: 'master',      description: 'Machine & area master data' },
      { name: 'overview',    description: 'Factory overview & open jobs' },
      { name: 'utilization', description: 'Machine utilization' },
      { name: 'downtime',    description: 'Downtime events & machines' },
      { name: 'inventory',   description: 'Equipment inventory & last package' },
      { name: 'tech',        description: 'Tech performance' },
      { name: 'wb',          description: 'Wire Bond packages & report' },
      { name: 'da',          description: 'Die Attach packages & report' },
      { name: 'wb-uph',      description: 'WB UPH monitor (SQLite central.db)' },
      { name: 'da-uph',      description: 'DA UPH monitor (PostgreSQL)' },
      { name: 'auth',        description: 'Authentication, users & permissions' },
    ],
  },
});
await app.register(swaggerUi, {
  routePrefix: '/docs',
  uiConfig: { docExpansion: 'list', deepLinking: true },
});

// ── Auto-tag routes by URL prefix ─────────────────────────────────────────
const TAG_MAP: [string, string][] = [
  ['/api/v1/wb-uph/',      'wb-uph'],
  ['/api/v1/da-uph/',      'da-uph'],
  ['/api/v1/inventory/',   'inventory'],
  ['/api/v1/utilization/', 'utilization'],
  ['/api/v1/downtime/',    'downtime'],
  ['/api/v1/overview/',    'overview'],
  ['/api/v1/overview',     'overview'],
  ['/api/v1/areas',        'master'],
  ['/api/v1/machines',     'master'],
  ['/api/v1/tech/',        'tech'],
  ['/api/v1/wb/',          'wb'],
  ['/api/v1/da/',          'da'],
  ['/api/v1/health',       'health'],
  ['/api/v1/live/',        'live'],
  ['/api/v1/auth/',        'auth'],
  ['/api/v1/users',        'auth'],
  ['/api/v1/permissions',  'auth'],
];
app.addHook('onRoute', (route) => {
  if (route.schema?.tags) return;
  const tag = TAG_MAP.find(([prefix]) => route.url.startsWith(prefix))?.[1];
  if (tag) route.schema = { ...route.schema, tags: [tag] };
});

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
await app.register(daRoutes);
await app.register(wbUphRoutes);
await app.register(daUphRoutes);
await app.register(debugRoutes);
await app.register(liveRoutes);
await app.register(authRoutes);
await app.register(usersRoutes);
await app.register(permissionsRoutes);

// ── Start ─────────────────────────────────────────────────────────────────
try {
  await pool.connect();
  console.log('[db] Connected to SQL Server');
  await ensurePermissionsTable();
  console.log('[db] Auth tables ready');
  await initReplica();
  console.log('[db] central.db replica ready');
  startReplicaSync();
  await app.listen({ port: config.api.port, host: config.api.host });
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
