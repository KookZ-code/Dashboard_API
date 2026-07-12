import type { FastifyInstance } from 'fastify';
import sql from 'mssql';
import { pool } from '../db.js';
import { config } from '../config.js';
import { authPreHandler, parseAreas } from '../helpers.js';
import { getOracleLive } from './ora-util.js';

const mt = () => config.machineTable;

export default async function overviewRoutes(app: FastifyInstance) {

  app.get<{ Querystring: { areas?: string } }>(
    '/api/v1/overview', { preHandler: authPreHandler }, async (req, reply) => {
      const areaList = parseAreas(req.query.areas);

      // Build area clauses for job_list queries (area filter)
      let areaClause = '';
      const areaParamMap: Array<{ name: string; value: string }> = [];
      let mcClause = '';
      const mcParamMap: Array<{ name: string; value: string }> = [];

      if (areaList?.length) {
        const aphs = areaList.map((_, i) => `@ov_a${i}`).join(', ');
        areaClause = `AND id_operation IN (${aphs})`;
        areaList.forEach((a, i) => areaParamMap.push({ name: `ov_a${i}`, value: a }));

        const mphs = areaList.map((_, i) => `@mc_a${i}`).join(', ');
        mcClause = `AND id_operation IN (${mphs})`;
        areaList.forEach((a, i) => mcParamMap.push({ name: `mc_a${i}`, value: a }));
      }

      const kpiReq = pool.request();
      const matReq = pool.request();
      for (const p of areaParamMap) kpiReq.input(p.name, sql.VarChar, p.value);
      for (const p of mcParamMap)   kpiReq.input(p.name, sql.VarChar, p.value);
      for (const p of areaParamMap) matReq.input(p.name, sql.VarChar, p.value);

      const shiftCutoff = `CASE
        WHEN DATEPART(HOUR, GETDATE()) BETWEEN 7 AND 18
        THEN CAST(CAST(GETDATE() AS DATE) AS DATETIME) + '07:00'
        WHEN DATEPART(HOUR, GETDATE()) >= 19
        THEN CAST(CAST(GETDATE() AS DATE) AS DATETIME) + '19:00'
        ELSE CAST(DATEADD(DAY,-1,CAST(GETDATE() AS DATE)) AS DATETIME) + '19:00'
      END`;

      const [kpiRs, matRs] = await Promise.all([
        areaList?.length
          ? kpiReq.query(`
              SELECT
                (SELECT COUNT(*) FROM ${mt()}
                 WHERE id_operation IS NOT NULL AND id_operation != ''
                 AND flag_key = 1 AND ISNULL(flag_delete,0) != 1 ${mcClause}) AS total_key_machines,
                (SELECT COUNT(*) FROM [dbo].[job_list]
                 WHERE date_close IS NULL AND code_machine != '' AND date_ack IS NULL ${areaClause}) AS waiting_count,
                (SELECT COUNT(*) FROM [dbo].[job_list]
                 WHERE date_close IS NULL AND code_machine != '' AND date_ack IS NOT NULL ${areaClause}) AS on_process_count,
                (SELECT COUNT(*) FROM [dbo].[job_list]
                 WHERE date_close IS NULL AND code_machine != '' AND job_type = 'M/C DOWN' ${areaClause}) AS down_count,
                (SELECT COUNT(*) FROM [dbo].[job_list]
                 WHERE date_close IS NOT NULL AND code_machine != '' AND LEN(code_machine) > 3 ${areaClause}
                 AND date_close >= ${shiftCutoff}) AS closed_this_shift
            `)
          : pool.request().query(`
              SELECT
                ((SELECT COUNT(*) FROM dbo.machine
                  WHERE id_operation IS NOT NULL AND id_operation != ''
                  AND id_operation != 'WB' AND flag_key = 1 AND ISNULL(flag_delete,0) != 1)
                 +
                 (SELECT COUNT(*) FROM dbo.machine a
                  WHERE a.id_operation = 'WB' AND a.flag_key = 1 AND ISNULL(a.flag_delete,0) != 1
                  AND a.code_machine NOT LIKE '%[LR]'
                  AND NOT EXISTS (SELECT 1 FROM dbo.machine b WHERE b.id_operation = 'WB'
                    AND (b.code_machine = a.code_machine + 'L' OR b.code_machine = a.code_machine + 'R')))
                 +
                 (SELECT COUNT(*) FROM dbo.machine a
                  WHERE a.id_operation = 'WB' AND ISNULL(a.flag_delete,0) != 1
                  AND a.code_machine LIKE '%[LR]'
                  AND EXISTS (SELECT 1 FROM dbo.machine b WHERE b.id_operation = 'WB' AND b.flag_key = 1
                    AND b.code_machine = LEFT(a.code_machine, LEN(a.code_machine)-1)))
                ) AS total_key_machines,
                (SELECT COUNT(*) FROM [dbo].[job_list] WHERE date_close IS NULL AND code_machine != '' AND date_ack IS NULL) AS waiting_count,
                (SELECT COUNT(*) FROM [dbo].[job_list] WHERE date_close IS NULL AND code_machine != '' AND date_ack IS NOT NULL) AS on_process_count,
                (SELECT COUNT(*) FROM [dbo].[job_list] WHERE date_close IS NULL AND code_machine != '' AND job_type = 'M/C DOWN') AS down_count,
                (SELECT COUNT(*) FROM [dbo].[job_list]
                 WHERE date_close IS NOT NULL AND code_machine != '' AND LEN(code_machine) > 3
                 AND date_close >= ${shiftCutoff}) AS closed_this_shift
            `),
        areaList?.length
          ? matReq.query(`
              SELECT job_type,
                SUM(CASE WHEN date_ack IS NULL AND date_close IS NULL THEN 1 ELSE 0 END) AS waiting,
                SUM(CASE WHEN date_ack IS NOT NULL AND date_close IS NULL THEN 1 ELSE 0 END) AS on_process,
                SUM(CASE WHEN date_close IS NOT NULL THEN 1 ELSE 0 END) AS closed,
                COUNT(*) AS total
              FROM [dbo].[job_list]
              WHERE code_machine IS NOT NULL AND code_machine != '' AND LEN(code_machine) > 3 ${areaClause}
              GROUP BY job_type ORDER BY total DESC
            `)
          : pool.request().query(`
              SELECT job_type,
                SUM(CASE WHEN date_ack IS NULL AND date_close IS NULL THEN 1 ELSE 0 END) AS waiting,
                SUM(CASE WHEN date_ack IS NOT NULL AND date_close IS NULL THEN 1 ELSE 0 END) AS on_process,
                SUM(CASE WHEN date_close IS NOT NULL THEN 1 ELSE 0 END) AS closed,
                COUNT(*) AS total
              FROM [dbo].[job_list]
              WHERE code_machine IS NOT NULL AND code_machine != '' AND LEN(code_machine) > 3
              GROUP BY job_type ORDER BY total DESC
            `),
      ]);

      const kpi = { key_machines: 0, running: 0, mc_down: 0, waiting_for_tech: 0, on_process: 0, closed_this_shift: 0, last_updated: '' };
      if (kpiRs.recordset.length) {
        const r = kpiRs.recordset[0] as any;
        kpi.key_machines      = Number(r.total_key_machines ?? 0);
        kpi.waiting_for_tech  = Number(r.waiting_count ?? 0);
        kpi.on_process        = Number(r.on_process_count ?? 0);
        kpi.mc_down           = Number(r.down_count ?? 0);
        kpi.closed_this_shift = Number(r.closed_this_shift ?? 0);
        kpi.running = Math.max(0, kpi.key_machines - kpi.mc_down - kpi.waiting_for_tech - kpi.on_process);
        kpi.last_updated = new Date().toISOString();
      }

      const matrix = (matRs.recordset as any[]).map(r => ({
        job_type:   String(r.job_type ?? ''),
        waiting:    Number(r.waiting ?? 0),
        on_process: Number(r.on_process ?? 0),
        closed:     Number(r.closed ?? 0),
        total:      Number(r.total ?? 0),
      }));

      return reply.send({ status: 'ok', data: { kpi, matrix, updated_at: new Date().toISOString() } });
    }
  );

  app.get<{ Querystring: { areas?: string; job_type?: string } }>(
    '/api/v1/overview/open-jobs', { preHandler: authPreHandler }, async (req, reply) => {
      const { areas, job_type } = req.query;
      const areaList = parseAreas(areas);

      // Get Oracle live jobs for ISO/FS areas
      const oracleLiveRows = getOracleLive(areaList);
      const oracleJobs = oracleLiveRows.map(r => ({
        code_machine: r.machine_id,
        area: r.area,
        job_type: r.job_type,
        des_job: r.des_job || null,
        datex: new Date().toISOString(), // Oracle doesn't give exact start, use now
        date_ack: r.status === 'Waiting' ? null : new Date().toISOString(), // rough approx
        tech: r.badge || null,
        wait_min: r.wait_min,
        repair_min: r.repair_min,
        status: r.status,
        die_mask: r.die_mask || null,
        package_type: r.package_type || null,
        wire_type: null,
      }));

      const jobReq = pool.request();
      let extra = '';
      if (areaList?.length) {
        const phs = areaList.map((_, i) => `@a_${i}`).join(', ');
        extra += ` AND id_operation IN (${phs})`;
        areaList.forEach((a, i) => jobReq.input(`a_${i}`, sql.VarChar, a));
      }
      if (job_type) { extra += ` AND job_type = @jt`; jobReq.input('jt', sql.VarChar, job_type); }

      const rs = await jobReq.query(`
        SELECT code_machine, id_operation AS area, job_type, des_job,
               datex, date_ack, by_ack AS tech,
               CASE WHEN date_ack IS NULL THEN DATEDIFF(MINUTE, datex, GETDATE())
                    ELSE DATEDIFF(MINUTE, datex, date_ack) END AS wait_min,
               CASE WHEN date_ack IS NOT NULL THEN DATEDIFF(MINUTE, date_ack, GETDATE())
                    ELSE NULL END AS repair_min,
               CASE WHEN date_ack IS NULL THEN 'Waiting' ELSE 'On Process' END AS status,
               [mpc] AS die_mask, [Package Type] AS package_type, [Wire Type] AS wire_type
        FROM [dbo].[job_list]
        WHERE date_close IS NULL AND code_machine IS NOT NULL AND code_machine != ''
          AND LEN(code_machine) > 3 AND datex >= DATEADD(MONTH,-1,GETDATE())
          ${extra}
        ORDER BY datex ASC
      `);

      const mssqlJobs = (rs.recordset as any[]).map(r => ({
        code_machine: String(r.code_machine ?? ''),
        area:         String(r.area ?? ''),
        job_type:     String(r.job_type ?? ''),
        des_job:      r.des_job ?? null,
        datex:        r.datex instanceof Date ? r.datex.toISOString() : null,
        date_ack:     r.date_ack instanceof Date ? r.date_ack.toISOString() : null,
        tech:         r.tech ?? null,
        wait_min:     Number(r.wait_min ?? 0),
        repair_min:   r.repair_min != null ? Number(r.repair_min) : 0,
        status:       String(r.status ?? ''),
        die_mask:     r.die_mask ?? null,
        package_type: r.package_type ?? null,
        wire_type:    r.wire_type ?? null,
      }));

      // Merge and filter by job_type if specified
      let jobs = [...mssqlJobs, ...oracleJobs];
      if (job_type) {
        jobs = jobs.filter(j => j.job_type === job_type);
      }

      return reply.send({ status: 'ok', data: jobs });
    }
  );
}
