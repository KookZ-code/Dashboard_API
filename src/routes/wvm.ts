import type { FastifyInstance } from 'fastify';
import sql from 'mssql';
import { pool } from '../db.js';
import { authPreHandler } from '../helpers.js';

const WVM_VIEW = '[MTHAI_ppm_db1].[dbo].[vw_job_listx_WBjobforWVM]';

interface WvmQuerystring {
  date_start?: string;
  date_end?: string;
  site?: string;
  machine?: string;
}

interface WvmRow {
  lot_no: string;
  machine: string;
  job_type: string;
  des_job: string | null;
  requested_by: string | null;
  date_close: string | null;
  package: string | null;
  wire_type: string | null;
  process_type: string | null;
  by_perform: string | null;
  mpc: string | null;
}

interface SiteGroup {
  setup_lots: string[];
  setup_count: number;
  rows: WvmRow[];
}

function groupSetupLots(rows: WvmRow[]): Record<'mtai' | 'mmt', SiteGroup> {
  const buckets: Record<'mtai' | 'mmt', SiteGroup> = {
    mtai: { setup_lots: [], setup_count: 0, rows: [] },
    mmt:  { setup_lots: [], setup_count: 0, rows: [] },
  };
  const seen: Record<'mtai' | 'mmt', Set<string>> = {
    mtai: new Set<string>(),
    mmt:  new Set<string>(),
  };

  for (const r of rows) {
    const lot = String(r.lot_no ?? '').trim();
    const key: 'mtai' | 'mmt' | null = /^MTAI/i.test(lot) ? 'mtai' : /^MMT/i.test(lot) ? 'mmt' : null;
    if (!key) continue;

    buckets[key].rows.push(r);
    if (!seen[key].has(lot)) {
      seen[key].add(lot);
      buckets[key].setup_lots.push(lot);
    }
  }

  buckets.mtai.setup_count = buckets.mtai.setup_lots.length;
  buckets.mmt.setup_count = buckets.mmt.setup_lots.length;
  return buckets;
}

export default async function wvmRoutes(app: FastifyInstance) {
  app.get<{ Querystring: WvmQuerystring }>(
    '/api/v1/wvm-setup-lots',
    { preHandler: authPreHandler },
    async (req, reply) => {
      const { date_start, date_end, site, machine } = req.query;

      // Validate required params
      if (!date_start || !date_end) {
        return reply.code(400).send({
          status: 'error',
          error: { code: 400, message: 'date_start and date_end are required' },
        });
      }

      // Parse and validate dates
      const startDt = new Date(date_start);
      const endDt = new Date(date_end);
      if (isNaN(startDt.getTime()) || isNaN(endDt.getTime())) {
        return reply.code(400).send({
          status: 'error',
          error: { code: 400, message: 'date_start/date_end must be valid ISO 8601 datetimes' },
        });
      }

      if (endDt <= startDt) {
        return reply.code(400).send({
          status: 'error',
          error: { code: 400, message: 'date_end must be after date_start' },
        });
      }

      // Build WHERE clause
      const req2 = pool.request();
      req2.input('date_start', sql.DateTime2, startDt);
      req2.input('date_end', sql.DateTime2, endDt);

      let extra = '';
      if (site && /^MTAI$/i.test(site)) {
        extra += ` AND lot_no LIKE 'MTAI%'`;
      } else if (site && /^MMT$/i.test(site)) {
        extra += ` AND lot_no LIKE 'MMT%'`;
      }

      if (machine) {
        extra += ` AND code_machine LIKE @machine`;
        req2.input('machine', sql.VarChar, `%${machine}%`);
      }

      // Execute query
      const rs = await req2.query(`
        SELECT
          lot_no, code_machine AS machine, job_type, des_job,
          req AS requested_by, date_close,
          [Package Type] AS package, [Wire Type] AS wire_type,
          [Process Type] AS process_type, by_perform, mpc
        FROM ${WVM_VIEW}
        WHERE date_close BETWEEN @date_start AND @date_end ${extra}
        ORDER BY date_close ASC
      `);

      // Map rows to response shape
      const mapped: WvmRow[] = (rs.recordset as any[]).map(r => ({
        lot_no: String(r.lot_no ?? ''),
        machine: String(r.machine ?? ''),
        job_type: String(r.job_type ?? ''),
        des_job: r.des_job ?? null,
        requested_by: r.requested_by ?? null,
        date_close:
          r.date_close instanceof Date ? r.date_close.toISOString() : null,
        package: r.package ?? null,
        wire_type: r.wire_type ?? null,
        process_type: r.process_type ?? null,
        by_perform: r.by_perform ?? null,
        mpc: r.mpc ?? null,
      }));

      // Group by site prefix
      const buckets = groupSetupLots(mapped);

      return reply.send({
        status: 'ok',
        data: {
          date_start,
          date_end,
          generated_at: new Date().toISOString(),
          mtai: buckets.mtai,
          mmt: buckets.mmt,
        },
      });
    }
  );
}
