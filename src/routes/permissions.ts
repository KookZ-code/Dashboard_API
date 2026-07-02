import { FastifyInstance } from 'fastify';
import sql from 'mssql';
import { pool } from '../db.js';
import { authPreHandler } from '../helpers.js';

// Ensure dashboard_role_permissions table exists with default data
export async function ensurePermissionsTable(): Promise<void> {
  const r = pool.request();
  await r.query(`
    IF NOT EXISTS (
      SELECT 1 FROM INFORMATION_SCHEMA.TABLES
      WHERE TABLE_SCHEMA='dbo' AND TABLE_NAME='dashboard_role_permissions'
    )
    BEGIN
      CREATE TABLE [dbo].[dashboard_role_permissions] (
        id   INT IDENTITY PRIMARY KEY,
        role NVARCHAR(50)  NOT NULL,
        path NVARCHAR(200) NOT NULL,
        CONSTRAINT UQ_role_path UNIQUE (role, path)
      );
      INSERT INTO [dbo].[dashboard_role_permissions] (role, path) VALUES
        ('supervisor','/'),('supervisor','/live'),('supervisor','/inventory'),
        ('supervisor','/wb-report'),('supervisor','/da-report'),
        ('supervisor','/downtime'),('supervisor','/utilization'),
        ('supervisor','/machine-detail'),('supervisor','/timeline'),
        ('supervisor','/store-items'),
        ('viewer','/'),('viewer','/live'),('viewer','/inventory'),
        ('viewer','/wb-report'),('viewer','/da-report');
    END
  `);
}

export default async function permissionsRoutes(app: FastifyInstance) {

  // GET /api/v1/permissions
  app.get('/api/v1/permissions', { preHandler: authPreHandler }, async (_req, reply) => {
    const r = pool.request();
    const result = await r.query(`SELECT role, path FROM [dbo].[dashboard_role_permissions] ORDER BY role, path`);
    const map: Record<string, string[]> = {};
    for (const row of result.recordset) {
      if (!map[row.role]) map[row.role] = [];
      map[row.role].push(row.path);
    }
    return reply.send({ status: 'ok', data: map });
  });

  // PUT /api/v1/permissions/:role
  app.put<{ Params: { role: string }; Body: { paths: string[] } }>(
    '/api/v1/permissions/:role', { preHandler: authPreHandler }, async (req, reply) => {
      const { role } = req.params;
      if (!['supervisor','viewer'].includes(role)) {
        return reply.code(400).send({ status: 'error', error: { code: 400, message: 'can only modify supervisor or viewer permissions' } });
      }

      // Delete existing then insert new
      const del = pool.request();
      del.input('role', sql.NVarChar, role);
      await del.query(`DELETE FROM [dbo].[dashboard_role_permissions] WHERE role=@role`);

      for (const path of (req.body?.paths ?? [])) {
        const ins = pool.request();
        ins.input('role', sql.NVarChar, role);
        ins.input('path', sql.NVarChar, path);
        await ins.query(`INSERT INTO [dbo].[dashboard_role_permissions] (role, path) VALUES (@role, @path)`);
      }

      return reply.send({ status: 'ok', data: { role } });
    }
  );
}
