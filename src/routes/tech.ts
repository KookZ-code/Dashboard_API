import type { FastifyInstance } from 'fastify';
import { pool } from '../db.js';
import { config } from '../config.js';
import { authPreHandler, buildTechWhere, makeReq, parseAreas } from '../helpers.js';

const v = () => config.view;

function norm(val: number, lo: number, hi: number, invert = false): number {
  if (hi === lo) return 50;
  const n = Math.max(0, Math.min(1, (val - lo) / (hi - lo)));
  return Math.round((invert ? 1 - n : n) * 1000) / 10;
}

function techScore(row: any, avgJobs: number) {
  const mttr = norm(Number(row.avg_repair_min)   ?? 999, 15,  480, true);
  const resp = norm(Number(row.avg_response_min) ?? 999, 5,   120, true);
  const ftfr = norm(Number(row.ftfr_pct)         ?? 0,   20,  80);
  const vol  = norm(avgJobs > 0 ? Number(row.job_count) / avgJobs : 0, 0.3, 1.5);
  const vers = norm(Number(row.area_count)        ?? 0,   0,   3);
  const score = Math.round((mttr * 0.30 + resp * 0.20 + ftfr * 0.25 + vol * 0.15 + vers * 0.10) * 10) / 10;
  const grade = score >= 85 ? 'A' : score >= 70 ? 'B' : score >= 55 ? 'C' : 'D';
  return {
    technician:       String(row.technician ?? ''),
    supervisor:       null,
    score,            grade,
    mttr_score:       mttr,
    response_score:   resp,
    ftfr_score:       ftfr,
    volume_score:     vol,
    versatility_score:vers,
    job_count:        Number(row.job_count ?? 0),
    avg_response_min: Number(row.avg_response_min ?? 0),
    avg_repair_min:   Number(row.avg_repair_min ?? 0),
    area_count:       Number(row.area_count ?? 0),
    ftfr_pct:         Number(row.ftfr_pct ?? 0),
  };
}

export default async function techRoutes(app: FastifyInstance) {

  app.get<{ Querystring: { start?: string; end?: string; areas?: string; shift?: string; job_type?: string } }>(
    '/api/v1/tech/metrics', { preHandler: authPreHandler }, async (req, reply) => {
      const { start, end, areas, shift, job_type } = req.query;
      const areaList = parseAreas(areas);
      const { where, params } = buildTechWhere({ start, end, areaList, shift, jobType: job_type });

      const rs = await makeReq(params).query(`
        WITH base AS (
          SELECT ISNULL(by_perform, by_ack) AS technician,
                 COUNT(*) AS job_count,
                 ROUND(AVG(ISNULL(Waiting_time,0)*1.0),1) AS avg_response_min,
                 ROUND(AVG(DATEDIFF(MINUTE,[date_ack],[date_close])*1.0),1) AS avg_repair_min,
                 COUNT(DISTINCT [id_operation]) AS area_count
          FROM ${v()} ${where}
          GROUP BY ISNULL(by_perform, by_ack)
        ),
        mc_jobs AS (
          SELECT ISNULL(by_perform, by_ack) AS technician,
                 code_machine, date_close,
                 LEAD(datex) OVER (
                   PARTITION BY ISNULL(by_perform, by_ack), code_machine ORDER BY datex
                 ) AS next_same_date
          FROM ${v()} ${where} AND [job_type] = 'M/C DOWN'
        ),
        ftfr AS (
          SELECT technician,
                 COUNT(*) AS mc_total,
                 SUM(CASE WHEN next_same_date IS NULL
                          OR DATEDIFF(DAY, date_close, next_same_date) > 7
                     THEN 1 ELSE 0 END) AS first_fixes
          FROM mc_jobs GROUP BY technician
        )
        SELECT b.technician, b.job_count, b.avg_response_min, b.avg_repair_min, b.area_count,
               COALESCE(ROUND(CAST(f.first_fixes AS FLOAT)/NULLIF(f.mc_total,0)*100,1),100) AS ftfr_pct
        FROM base b LEFT JOIN ftfr f ON b.technician = f.technician
        ORDER BY b.job_count DESC
      `);

      const rows = rs.recordset as any[];
      if (!rows.length) return reply.send({ status: 'ok', data: { rows: [] } });
      const avgJobs = rows.reduce((s, r) => s + Number(r.job_count || 0), 0) / rows.length || 1;
      const result = rows.map(r => techScore(r, avgJobs)).sort((a, b) => b.score - a.score);
      return reply.send({ status: 'ok', data: { rows: result } });
    }
  );

  app.get('/api/v1/tech/list', { preHandler: authPreHandler }, async (_req, reply) => {
    const rs = await pool.request().query(`
      SELECT [Badge],[Name],[NameTH],[AERA],[Job Desc],[Supv],[Group]
      FROM [dbo].[TechnicianList]
    `);
    return reply.send({ status: 'ok', data: { rows: rs.recordset } });
  });
}
