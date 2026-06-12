// DA-UPH endpoints — PostgreSQL `uph` database (Die Attach hourly scan output).
// Port of Dashboad_API_rush da_uph_repo.rs.
// Connection string via DA_DB_URL env var.
// DA qty_good is INCREMENTAL (plain SUM, no delta/reset logic).

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { config } from '../config.js';
import { getPgPool } from '../db-pg.js';

// ── pkg_key expression ─────────────────────────────────────────────────────
const PKG_KEY = `CASE WHEN wl.mpc IS NOT NULL AND LENGTH(wl.mpc) >= 9
     THEN wl.package || '(' || SUBSTR(wl.mpc, 7, 3) || ')'
     ELSE COALESCE(wl.package, '') END`;

// ── Shift window ─────────────────────────────────────────────────────────
interface ShiftWin { start: string; end: string; hours: number[] }

function prevDay(date: string): string {
  const [y, m, d] = date.split('-').map(Number);
  const prev = new Date(y, m - 1, d - 1);
  return `${prev.getFullYear()}-${String(prev.getMonth()+1).padStart(2,'0')}-${String(prev.getDate()).padStart(2,'0')}`;
}

function shiftWindow(date: string, shift: string): ShiftWin {
  if (shift === 'D') {
    return { start: `${date} 07:00:00+07`, end: `${date} 18:59:59+07`, hours: Array.from({length:12},(_,i)=>7+i) };
  }
  const prev = prevDay(date);
  return { start: `${prev} 19:00:00+07`, end: `${date} 06:59:59+07`, hours: [19,20,21,22,23,0,1,2,3,4,5,6] };
}

function resolveShift(date?: string, shift?: string): [string, string] {
  const now = new Date();
  const h = now.getHours();
  let curDate: string;
  let curShift: string;
  if (h >= 7 && h < 19) {
    curDate = now.toISOString().slice(0, 10);
    curShift = 'D';
  } else if (h >= 19) {
    const next = new Date(now.getTime() + 86_400_000);
    curDate = next.toISOString().slice(0, 10);
    curShift = 'N';
  } else {
    curDate = now.toISOString().slice(0, 10);
    curShift = 'N';
  }
  return [
    /^\d{4}-\d{2}-\d{2}$/.test(date ?? '') ? date! : curDate,
    shift === 'D' || shift === 'N' ? shift : curShift,
  ];
}

function slotEndForHour(w: ShiftWin, hour: number): string {
  const date = hour <= 6 ? w.end.slice(0, 10) : w.start.slice(0, 10);
  const slot = `${date} ${String(hour).padStart(2,'0')}:59:59+07`;
  return slot < w.end ? slot : w.end;
}

// ── Auth & 503 helpers ─────────────────────────────────────────────────────

async function authCheck(req: FastifyRequest, reply: FastifyReply) {
  if (config.api.key && req.headers['x-api-key'] !== config.api.key) {
    await reply.code(401).send({ status: 'error', error: { code: 401, message: 'Invalid API key' } });
  }
}

function unavailable(reply: FastifyReply) {
  return reply.code(503).send({ status: 'unavailable', message: 'DA_DB_URL not configured or PostgreSQL uph database unreachable' });
}

// ── Route plugin ───────────────────────────────────────────────────────────

export default async function daUphRoutes(app: FastifyInstance): Promise<void> {

  // 1. Summary
  app.get<{ Querystring: { date?: string; shift?: string; packages?: string } }>(
    '/api/v1/da-uph/summary', { preHandler: authCheck }, async (req, reply) => {
      const pool = getPgPool();
      if (!pool) return unavailable(reply);
      try {
        const [date, shift] = resolveShift(req.query.date, req.query.shift);
        const pkgs = (req.query.packages ?? '').split(',').map(s => s.trim()).filter(Boolean);
        const w = shiftWindow(date, shift);
        const hasPkg = pkgs.length > 0;
        const pkgClause = hasPkg ? `AND (${PKG_KEY}) = ANY($3)` : '';
        const sql = `
          SELECT COALESCE(SUM(o.qty_good), 0)::int8   AS total_bonded,
                 COUNT(DISTINCT o.machine_id)::int8   AS active_machines,
                 COUNT(DISTINCT o.operator_id)::int8  AS active_operators
          FROM output_record o
          LEFT JOIN wafer_lot wl ON wl.wafer_lot_id = o.wafer_lot_id
          WHERE o.created_at >= $1::timestamptz AND o.created_at <= $2::timestamptz ${pkgClause}`;
        const vals: any[] = [w.start, w.end];
        if (hasPkg) vals.push(pkgs);
        const res = await pool.query(sql, vals);
        const r = res.rows[0];
        return reply.send({ status: 'ok', data: { total_bonded: Number(r.total_bonded), active_machines: Number(r.active_machines), active_operators: Number(r.active_operators) } });
      } catch (err) {
        return reply.code(503).send({ status: 'unavailable', message: err instanceof Error ? err.message : String(err) });
      }
    }
  );

  // 2. Hourly
  app.get<{ Querystring: { date?: string; shift?: string; packages?: string } }>(
    '/api/v1/da-uph/hourly', { preHandler: authCheck }, async (req, reply) => {
      const pool = getPgPool();
      if (!pool) return unavailable(reply);
      try {
        const [date, shift] = resolveShift(req.query.date, req.query.shift);
        const pkgs = (req.query.packages ?? '').split(',').map(s => s.trim()).filter(Boolean);
        const w = shiftWindow(date, shift);
        const hasPkg = pkgs.length > 0;
        const pkgClause = hasPkg ? `AND (${PKG_KEY}) = ANY($3)` : '';
        const sql = `
          SELECT (${PKG_KEY}) AS pkg_key,
                 EXTRACT(HOUR FROM o.created_at AT TIME ZONE 'Asia/Bangkok')::int AS hr,
                 COALESCE(SUM(o.qty_good), 0)::int8 AS bonded
          FROM output_record o
          LEFT JOIN wafer_lot wl ON wl.wafer_lot_id = o.wafer_lot_id
          WHERE o.created_at >= $1::timestamptz AND o.created_at <= $2::timestamptz ${pkgClause}
          GROUP BY pkg_key, hr`;
        const vals: any[] = [w.start, w.end];
        if (hasPkg) vals.push(pkgs);
        const res = await pool.query(sql, vals);

        const n = w.hours.length;
        const buckets = new Map<string, number[]>();
        for (const r of res.rows) {
          const slot = w.hours.indexOf(Number(r.hr));
          if (slot < 0) continue;
          if (!buckets.has(r.pkg_key)) buckets.set(r.pkg_key, new Array(n).fill(0));
          buckets.get(r.pkg_key)![slot] += Number(r.bonded);
        }
        // incremental → cumulative running sum
        const pkgMap: Record<string, number[]> = {};
        for (const [pkg, perHour] of buckets) {
          let acc = 0;
          pkgMap[pkg] = perHour.map(v => { acc += v; return acc; });
        }
        return reply.send({ status: 'ok', data: { packages: pkgMap } });
      } catch (err) {
        return reply.code(503).send({ status: 'unavailable', message: err instanceof Error ? err.message : String(err) });
      }
    }
  );

  // 3. Packages
  app.get<{ Querystring: { date?: string; shift?: string; hour?: string; packages?: string } }>(
    '/api/v1/da-uph/packages', { preHandler: authCheck }, async (req, reply) => {
      const pool = getPgPool();
      if (!pool) return unavailable(reply);
      try {
        const [date, shift] = resolveShift(req.query.date, req.query.shift);
        const w = shiftWindow(date, shift);
        const hour = req.query.hour !== undefined ? Number(req.query.hour) : w.hours[w.hours.length - 1];
        const slotEnd = slotEndForHour(w, hour);
        const pkgs = (req.query.packages ?? '').split(',').map(s => s.trim()).filter(Boolean);
        const hasPkg = pkgs.length > 0;
        const pkgClause = hasPkg ? `AND (${PKG_KEY}) = ANY($3)` : '';
        const sql = `
          SELECT (${PKG_KEY}) AS package, COALESCE(SUM(o.qty_good), 0)::int8 AS bonded
          FROM output_record o
          LEFT JOIN wafer_lot wl ON wl.wafer_lot_id = o.wafer_lot_id
          WHERE o.created_at >= $1::timestamptz AND o.created_at <= $2::timestamptz ${pkgClause}
          GROUP BY (${PKG_KEY})
          ORDER BY bonded DESC`;
        const vals: any[] = [w.start, slotEnd];
        if (hasPkg) vals.push(pkgs);
        const res = await pool.query(sql, vals);
        return reply.send({ status: 'ok', data: res.rows.map(r => ({ package: r.package, bonded: Number(r.bonded) })) });
      } catch (err) {
        return reply.code(503).send({ status: 'unavailable', message: err instanceof Error ? err.message : String(err) });
      }
    }
  );

  // 4. Machines
  app.get<{ Querystring: { date?: string; shift?: string; hour?: string; package?: string } }>(
    '/api/v1/da-uph/machines', { preHandler: authCheck }, async (req, reply) => {
      const pool = getPgPool();
      if (!pool) return unavailable(reply);
      const pkg = req.query.package;
      if (!pkg) return reply.code(400).send({ status: 'error', error: { code: 400, message: 'package required' } });
      try {
        const [date, shift] = resolveShift(req.query.date, req.query.shift);
        const w = shiftWindow(date, shift);
        const hour = req.query.hour !== undefined ? Number(req.query.hour) : w.hours[w.hours.length - 1];
        const slotEnd = slotEndForHour(w, hour);
        const pkgMatch = pkg.includes('(')
          ? `(${PKG_KEY}) = $3`
          : `(wl.package = $3 OR (${PKG_KEY}) LIKE $3 || '(%')`;
        const sql = `
          SELECT m.code AS machine_id,
                 COALESCE((array_agg(op.badge ORDER BY o.created_at DESC))[1], '') AS badge_no,
                 COALESCE(SUM(o.qty_good), 0)::int8 AS bonded_unit,
                 TO_CHAR(MAX(o.created_at) AT TIME ZONE 'Asia/Bangkok', 'YYYY-MM-DD HH24:MI:SS') AS last_scan_ts,
                 COALESCE(MAX(m.target_uph), 0)::int8 AS target_uph,
                 COALESCE((array_agg((${PKG_KEY}) ORDER BY o.created_at DESC))[1], '') AS pkg_mpc,
                 CASE WHEN EXTRACT(EPOCH FROM (MAX(o.created_at) - $1::timestamptz)) > 0
                      THEN COALESCE(SUM(o.qty_good), 0)::float8 /
                           (EXTRACT(EPOCH FROM (MAX(o.created_at) - $1::timestamptz)) / 3600.0)
                      ELSE 0.0
                 END AS uph
          FROM output_record o
          JOIN machine m         ON m.id = o.machine_id
          LEFT JOIN operator op  ON op.id = o.operator_id
          LEFT JOIN wafer_lot wl ON wl.wafer_lot_id = o.wafer_lot_id
          WHERE o.created_at >= $1::timestamptz AND o.created_at <= $2::timestamptz AND ${pkgMatch}
          GROUP BY m.code
          ORDER BY bonded_unit DESC`;
        const res = await pool.query(sql, [w.start, slotEnd, pkg]);
        const out = res.rows.map(r => ({
          machine_id:   r.machine_id,
          badge_no:     r.badge_no,
          uph:          parseFloat(r.uph),
          bonded_unit:  Number(r.bonded_unit),
          last_scan_ts: r.last_scan_ts ?? null,
          pkg_mpc:      r.pkg_mpc,
          target_uph:   Number(r.target_uph),
        }));
        return reply.send({ status: 'ok', data: out });
      } catch (err) {
        return reply.code(503).send({ status: 'unavailable', message: err instanceof Error ? err.message : String(err) });
      }
    }
  );

  // 5. Records
  app.get<{ Querystring: { date?: string; shift?: string; machine_id?: string; package?: string } }>(
    '/api/v1/da-uph/records', { preHandler: authCheck }, async (req, reply) => {
      const pool = getPgPool();
      if (!pool) return unavailable(reply);
      const { machine_id, package: pkg } = req.query;
      if (!machine_id || !pkg) return reply.code(400).send({ status: 'error', error: { code: 400, message: 'machine_id and package required' } });
      try {
        const [date, shift] = resolveShift(req.query.date, req.query.shift);
        const w = shiftWindow(date, shift);
        const pkgMatch = pkg.includes('(')
          ? `(${PKG_KEY}) = $2`
          : `(wl.package = $2 OR (${PKG_KEY}) LIKE $2 || '(%')`;
        const baseSelect = `
          SELECT TO_CHAR(o.created_at AT TIME ZONE 'Asia/Bangkok', 'YYYY-MM-DD HH24:MI:SS') AS created_at,
                 COALESCE(o.mtai_lot_id, o.wafer_lot_id, '') AS lot_id,
                 (${PKG_KEY}) AS package_mpc,
                 o.qty_good AS qty_good,
                 COALESCE(op.badge, '') AS badge_no
          FROM output_record o
          JOIN machine m         ON m.id = o.machine_id
          LEFT JOIN operator op  ON op.id = o.operator_id
          LEFT JOIN wafer_lot wl ON wl.wafer_lot_id = o.wafer_lot_id
          WHERE m.code = $1 AND ${pkgMatch}`;
        const currentRes = await pool.query(
          `${baseSelect} AND o.created_at >= $3::timestamptz AND o.created_at <= $4::timestamptz ORDER BY o.created_at ASC`,
          [machine_id, pkg, w.start, w.end]
        );
        const prevRes = await pool.query(
          `${baseSelect} AND o.created_at < $3::timestamptz ORDER BY o.created_at DESC LIMIT 5`,
          [machine_id, pkg, w.start]
        );
        const mapRec = (r: any, withDelta: boolean) => ({
          created_at:   r.created_at,
          lot_id:       r.lot_id,
          package_mpc:  r.package_mpc,
          uph:          0,
          bonded_unit:  Number(r.qty_good),
          delta_bonded: withDelta ? Number(r.qty_good) : 0,
          badge_no:     r.badge_no,
        });
        const prevTail = prevRes.rows.map(r => mapRec(r, false)).reverse();
        return reply.send({ status: 'ok', data: { current: currentRes.rows.map(r => mapRec(r, true)), prev_tail: prevTail } });
      } catch (err) {
        return reply.code(503).send({ status: 'unavailable', message: err instanceof Error ? err.message : String(err) });
      }
    }
  );

  // 6. Monitor
  app.get<{ Querystring: { date?: string; shift?: string } }>(
    '/api/v1/da-uph/monitor', { preHandler: authCheck }, async (req, reply) => {
      const pool = getPgPool();
      if (!pool) return unavailable(reply);
      try {
        const [date, shift] = resolveShift(req.query.date, req.query.shift);
        const w = shiftWindow(date, shift);
        const now = new Date();
        const asOf = `${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}`;
        const THRESHOLD_MIN = 120;

        const activeSql = `
          SELECT m.code AS machine_id,
                 TO_CHAR(MAX(o.created_at) AT TIME ZONE 'Asia/Bangkok', 'YYYY-MM-DD HH24:MI:SS') AS last_scan_ts,
                 ROUND(EXTRACT(EPOCH FROM (NOW() - MAX(o.created_at))) / 60)::int8 AS since_min,
                 COALESCE((array_agg((${PKG_KEY}) ORDER BY o.created_at DESC))[1], '') AS package
          FROM output_record o
          JOIN machine m         ON m.id = o.machine_id
          LEFT JOIN wafer_lot wl ON wl.wafer_lot_id = o.wafer_lot_id
          WHERE o.created_at >= $1::timestamptz AND o.created_at <= $2::timestamptz
          GROUP BY m.code`;
        const activeRes = await pool.query(activeSql, [w.start, w.end]);
        const activeIds = new Set(activeRes.rows.map((r: any) => r.machine_id));

        const rows: any[] = activeRes.rows.map((r: any) => {
          const since = Number(r.since_min);
          return { machine_id: r.machine_id, package: r.package, last_scan_ts: r.last_scan_ts, since_min: since, status: since <= THRESHOLD_MIN ? 'active' : 'stale' };
        });

        const fleetRes = await pool.query('SELECT code FROM machine WHERE active = 1');
        for (const r of fleetRes.rows) {
          if (activeIds.has(r.code)) continue;
          rows.push({ machine_id: r.code, package: '', last_scan_ts: null, since_min: null, status: 'no_data' });
        }

        const order = (s: string) => s === 'no_data' ? 0 : s === 'stale' ? 1 : 2;
        rows.sort((a, b) => {
          const diff = order(a.status) - order(b.status);
          return diff !== 0 ? diff : (b.since_min ?? 9999) - (a.since_min ?? 9999);
        });

        return reply.send({ status: 'ok', data: { rows, as_of: asOf, threshold_min: THRESHOLD_MIN } });
      } catch (err) {
        return reply.code(503).send({ status: 'unavailable', message: err instanceof Error ? err.message : String(err) });
      }
    }
  );
}
