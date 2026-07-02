import { FastifyInstance } from 'fastify';
import sql from 'mssql';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { pool } from '../db.js';
import { config } from '../config.js';

interface LoginBody { username: string; password: string }

export default async function authRoutes(app: FastifyInstance) {

  // POST /api/v1/auth/login — public, no api key required
  app.post<{ Body: LoginBody }>('/api/v1/auth/login', async (req, reply) => {
    const { username, password } = req.body ?? {};

    if (!username || !password) {
      return reply.code(400).send({ status: 'error', error: { code: 400, message: 'username and password required' } });
    }

    let user: { id: number; username: string; password_hash: string; role: string; display_name: string } | null = null;
    try {
      const r = pool.request();
      r.input('username', sql.NVarChar, username);
      const result = await r.query(
        `SELECT id, username, password_hash, role, display_name
         FROM [dbo].[dashboard_users]
         WHERE username = @username`
      );
      user = result.recordset[0] ?? null;
    } catch (e) {
      return reply.code(500).send({ status: 'error', error: { code: 500, message: 'Database error' } });
    }

    if (!user) {
      return reply.code(401).send({ status: 'error', error: { code: 401, message: 'Invalid username or password' } });
    }

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) {
      return reply.code(401).send({ status: 'error', error: { code: 401, message: 'Invalid username or password' } });
    }

    const exp = Math.floor(Date.now() / 1000) + config.jwt.expireHours * 3600;
    const token = jwt.sign(
      { sub: user.username, id: user.id, display_name: user.display_name, role: user.role, exp },
      config.jwt.secret
    );

    return reply.send({
      status: 'ok',
      data: {
        token,
        user: { id: user.id, username: user.username, display_name: user.display_name, role: user.role },
      },
    });
  });
}
