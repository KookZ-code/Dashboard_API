import { FastifyInstance } from 'fastify';
import sql from 'mssql';
import jwt from 'jsonwebtoken';
import { pool } from '../db.js';
import { config } from '../config.js';

// Port of the Rust login flow (Dashboad_API_rush/src/handlers/auth.rs):
//   1. Badge + password are checked against the Microchip Account API.
//   2. The badge is looked up in dashboard_users; a first-time badge is created as `viewer`.
//   3. Users created this way keep a placeholder hash, because the password is never checked locally.

// Placeholder for the NOT NULL password_hash column of Microchip-managed users (same value as Rust).
const MICROCHIP_MANAGED_PLACEHOLDER = 'microchip-managed';
const INVALID_CREDENTIALS = 'รหัสพนักงานหรือรหัสผ่านไม่ถูกต้อง';

interface LoginBody { badgecode: string; password: string }

interface MicrochipResp {
  reply_code: number;          // 1 = success, anything else = failure
  fullname?: string | null;
  imglink?: string | null;
}

interface UserRow { id: number; username: string; role: string; display_name: string }

/**
 * Returns the Microchip profile when the badge and password are valid, otherwise null.
 * The API answers HTTP 200 even for bad credentials, so success is decided by reply_code only.
 * Any transport or parse error counts as a failed login (same as Rust).
 */
async function verifyWithMicrochip(badgecode: string, password: string): Promise<MicrochipResp | null> {
  try {
    const res = await fetch(config.microchip.apiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ badgecode, password }),
      signal: AbortSignal.timeout(config.microchip.timeoutSecs * 1000),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as MicrochipResp;
    return body.reply_code === 1 ? body : null;
  } catch {
    return null;
  }
}

/** Finds the user by badge code, or creates it as `viewer`. Refreshes the cached display name on known users. */
async function resolveUser(
  badgecode: string,
  fullname: string,
  log: { warn: (...args: unknown[]) => void },
): Promise<UserRow> {
  const found = await pool.request()
    .input('username', sql.NVarChar, badgecode)
    .query<UserRow>(`SELECT id, username, role, display_name FROM [dbo].[dashboard_users] WHERE username = @username`);

  if (found.recordset[0]) {
    try {
      await pool.request()
        .input('display_name', sql.NVarChar, fullname)
        .input('username', sql.NVarChar, badgecode)
        .query(`UPDATE [dbo].[dashboard_users] SET display_name = @display_name WHERE username = @username`);
    } catch (e) {
      // Best-effort: a failed name refresh must never fail the login.
      log.warn({ err: e }, 'failed to refresh display_name');
    }
    return found.recordset[0];
  }

  await pool.request()
    .input('username', sql.NVarChar, badgecode)
    .input('display_name', sql.NVarChar, fullname)
    .input('password_hash', sql.NVarChar, MICROCHIP_MANAGED_PLACEHOLDER)
    .input('role', sql.NVarChar, 'viewer')
    .query(`INSERT INTO [dbo].[dashboard_users] (username, display_name, password_hash, role)
            VALUES (@username, @display_name, @password_hash, @role)`);

  const created = await pool.request()
    .input('username', sql.NVarChar, badgecode)
    .query<UserRow>(`SELECT id, username, role, display_name FROM [dbo].[dashboard_users] WHERE username = @username`);
  if (!created.recordset[0]) throw new Error(`created user not found: ${badgecode}`);
  return created.recordset[0];
}

export default async function authRoutes(app: FastifyInstance) {

  // POST /api/v1/auth/login — public, no api key required
  app.post<{ Body: LoginBody }>('/api/v1/auth/login', async (req, reply) => {
    const { badgecode, password } = req.body ?? {};

    if (!badgecode || !password) {
      return reply.code(400).send({ status: 'error', error: { code: 400, message: 'badgecode and password required' } });
    }

    const deny = () => reply.code(401).send({ status: 'error', error: { code: 401, message: INVALID_CREDENTIALS } });

    const mc = await verifyWithMicrochip(badgecode, password);
    if (!mc) return deny();

    const fullname = mc.fullname ?? badgecode;
    const imageUrl = mc.imglink ?? null;

    let user: UserRow;
    try {
      user = await resolveUser(badgecode, fullname, req.log);
    } catch (e) {
      // Rust reports DB failures during login as a generic 401; keep the same behaviour.
      req.log.error({ err: e }, 'login: DB error');
      return deny();
    }

    const token = jwt.sign(
      {
        sub: badgecode,
        id: user.id,
        display_name: fullname,
        role: user.role,
        ...(imageUrl ? { img: imageUrl } : {}),
      },
      config.jwt.secret,
      { expiresIn: config.jwt.expireHours * 3600 },
    );

    return reply.send({
      status: 'ok',
      data: {
        token,
        user: {
          id: user.id,
          username: badgecode,
          display_name: fullname,
          role: user.role,
          ...(imageUrl ? { image_url: imageUrl } : {}),
        },
      },
    });
  });
}
