import type { FastifyInstance } from 'fastify';
import sql from 'mssql';
import { pool } from '../db.js';
import { config } from '../config.js';
import { authPreHandler, parseAreas } from '../helpers.js';

const mt = () => config.machineTable;

// Map job_type → MachineStatus
function jobTypeToStatus(jobType: string | null): string {
  if (!jobType) return 'Running';
  const jt = jobType.toUpperCase();
  if (jt === 'M/C DOWN')             return 'M/C Down';
  if (jt === 'ENGINEERING DOWN' || jt === 'FACILITY DOWN') return 'M/C Down';
  if (jt === 'PM')                   return 'PM';
  if (jt === 'SETUP' || jt === 'SETUP BY OPERATOR') return 'Setup';
  if (jt === 'CONVERT')              return 'Convert';
  if (jt === 'CLEAN MOLD' || jt === 'CHANGE CAP')   return 'Setup';
  return 'Other';
}

export default async function liveRoutes(app: FastifyInstance) {

  app.get<{ Querystring: { areas?: string } }>(
    '/api/v1/live/machines', { preHandler: authPreHandler }, async (req, reply) => {
      const areaList = parseAreas(req.query.areas);

      // Build area filter
      let areaClause = '';
      const mcReq = pool.request();
      if (areaList?.length) {
        const phs = areaList.map((_, i) => `@a${i}`).join(', ');
        areaClause = `AND m.id_operation IN (${phs})`;
        areaList.forEach((a, i) => mcReq.input(`a${i}`, sql.VarChar, a));
      }

      // Get all non-deleted machines + their latest open job (if any)
      const rs = await mcReq.query(`
        SELECT
          m.code_machine,
          m.id_operation     AS area,
          m.model            AS model,
          m.flag_key         AS is_key,
          j.job_type,
          j.des_job          AS symptom,
          j.by_ack           AS tech_name,
          j.datex            AS started_at,
          j.[Package Type]   AS package_type,
          CASE
            WHEN j.job_type IS NULL THEN NULL
            ELSE DATEDIFF(MINUTE, j.datex, GETDATE())
          END AS elapsed_min
        FROM ${mt()} m
        LEFT JOIN (
          SELECT code_machine, job_type, des_job, by_ack, datex,
                 [Package Type], ROW_NUMBER() OVER (PARTITION BY code_machine ORDER BY datex DESC) AS rn
          FROM [dbo].[job_list]
          WHERE date_close IS NULL AND code_machine != '' AND LEN(code_machine) > 3
        ) j ON j.code_machine = m.code_machine AND j.rn = 1
        WHERE ISNULL(m.flag_delete, 0) != 1
          AND m.id_operation IS NOT NULL AND m.id_operation != ''
          ${areaClause}
        ORDER BY m.id_operation, m.code_machine
      `);

      const machines = (rs.recordset as any[]).map(r => ({
        code_machine: String(r.code_machine ?? ''),
        area:         String(r.area ?? ''),
        status:       jobTypeToStatus(r.job_type ?? null),
        job_type:     r.job_type ?? null,
        tech_name:    r.tech_name ?? null,
        symptom:      r.symptom ?? null,
        package_type: r.package_type ?? null,
        model:        r.model ?? null,
        elapsed_min:  r.elapsed_min != null ? Number(r.elapsed_min) : 0,
        started_at:   r.started_at instanceof Date ? r.started_at.toISOString() : null,
        is_key:       r.is_key === true || r.is_key === 1,
      }));

      return reply.send({ status: 'ok', data: machines });
    }
  );
}
