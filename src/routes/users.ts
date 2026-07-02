import { FastifyInstance } from 'fastify';
import sql from 'mssql';
import bcrypt from 'bcrypt';
import { pool } from '../db.js';
import { authPreHandler } from '../helpers.js';

export default async function usersRoutes(app: FastifyInstance) {

  // GET /api/v1/users
  app.get('/api/v1/users', { preHandler: authPreHandler }, async (_req, reply) => {
    const r = pool.request();
    const result = await r.query(
      `SELECT id, username, display_name, role, created_at
       FROM [dbo].[dashboard_users] ORDER BY id`
    );
    return reply.send({ status: 'ok', data: result.recordset });
  });

  // POST /api/v1/users
  app.post<{ Body: { username: string; display_name: string; password: string; role: string } }>(
    '/api/v1/users', { preHandler: authPreHandler }, async (req, reply) => {
      const { username, display_name, password, role } = req.body ?? {};
      if (!username?.trim()) return reply.code(400).send({ status: 'error', error: { code: 400, message: 'username required' } });
      if ((password ?? '').length < 6) return reply.code(400).send({ status: 'error', error: { code: 400, message: 'password min 6 characters' } });
      if (!['admin','supervisor','viewer'].includes(role)) return reply.code(400).send({ status: 'error', error: { code: 400, message: 'invalid role' } });

      const hash = await bcrypt.hash(password, 12);
      const r = pool.request();
      r.input('username', sql.NVarChar, username);
      r.input('display_name', sql.NVarChar, display_name ?? username);
      r.input('hash', sql.NVarChar, hash);
      r.input('role', sql.NVarChar, role);
      await r.query(
        `INSERT INTO [dbo].[dashboard_users] (username, display_name, password_hash, role)
         VALUES (@username, @display_name, @hash, @role)`
      );

      const r2 = pool.request();
      r2.input('username', sql.NVarChar, username);
      const created = await r2.query(`SELECT id, username, display_name, role, created_at FROM [dbo].[dashboard_users] WHERE username = @username`);
      return reply.code(201).send({ status: 'ok', data: created.recordset[0] });
    }
  );

  // PUT /api/v1/users/:id
  app.put<{ Params: { id: string }; Body: { display_name: string; role: string } }>(
    '/api/v1/users/:id', { preHandler: authPreHandler }, async (req, reply) => {
      const { display_name, role } = req.body ?? {};
      if (!['admin','supervisor','viewer'].includes(role)) return reply.code(400).send({ status: 'error', error: { code: 400, message: 'invalid role' } });
      const r = pool.request();
      r.input('id', sql.Int, Number(req.params.id));
      r.input('display_name', sql.NVarChar, display_name);
      r.input('role', sql.NVarChar, role);
      await r.query(`UPDATE [dbo].[dashboard_users] SET display_name=@display_name, role=@role WHERE id=@id`);
      return reply.send({ status: 'ok', data: { id: Number(req.params.id) } });
    }
  );

  // PUT /api/v1/users/:id/password
  app.put<{ Params: { id: string }; Body: { password: string } }>(
    '/api/v1/users/:id/password', { preHandler: authPreHandler }, async (req, reply) => {
      const { password } = req.body ?? {};
      if ((password ?? '').length < 6) return reply.code(400).send({ status: 'error', error: { code: 400, message: 'password min 6 characters' } });
      const hash = await bcrypt.hash(password, 12);
      const r = pool.request();
      r.input('id', sql.Int, Number(req.params.id));
      r.input('hash', sql.NVarChar, hash);
      await r.query(`UPDATE [dbo].[dashboard_users] SET password_hash=@hash WHERE id=@id`);
      return reply.send({ status: 'ok', data: { id: Number(req.params.id) } });
    }
  );

  // DELETE /api/v1/users/:id
  app.delete<{ Params: { id: string } }>(
    '/api/v1/users/:id', { preHandler: authPreHandler }, async (req, reply) => {
      const r = pool.request();
      r.input('id', sql.Int, Number(req.params.id));
      await r.query(`DELETE FROM [dbo].[dashboard_users] WHERE id=@id`);
      return reply.send({ status: 'ok', data: { deleted: Number(req.params.id) } });
    }
  );
}
