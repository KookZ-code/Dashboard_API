import type { FastifyInstance } from 'fastify';
import { config } from '../config.js';
import {
  authPreHandler, buildWhere, makeReq, nDays,
  computeKpis, areaUtil, monthlyTrend,
  C, DOWN_TYPES, LOST_TYPES, r2,
} from '../helpers.js';

const v = () => config.view;

export default async function utilizationRoutes(app: FastifyInstance) {

  app.get<{ Querystring: { start?: string; end?: string; areas?: string; shift?: string } }>(
    '/api/v1/utilization/detail', { preHandler: authPreHandler }, async (req, reply) => {
      const { start, end, areas, shift } = req.query;
      const { where, params } = buildWhere({ start, end, areas, shift });
      const nd = nDays(start, end);
      const downIn = [...DOWN_TYPES].map(j => `'${j}'`).join(', ');
      const lostIn = [...LOST_TYPES].map(j => `'${j}'`).join(', ');

      const [kpiRs, monthRs, areaRs, mcCntRs, totalMcRs, scatterRs, topDownRs, topLostRs] = await Promise.all([
        makeReq(params).query(`
          SELECT [${C.JT}] AS job_type,
                 SUM(DATEDIFF(MINUTE,[${C.TECH}],[${C.END}])) AS total_min,
                 SUM(ISNULL(Waiting_time,0)) AS wait_min
          FROM ${v()} ${where} GROUP BY [${C.JT}]
        `),
        makeReq(params).query(`
          SELECT CONVERT(VARCHAR(7),[${C.OPR}],120) AS ym, [${C.JT}] AS job_type,
                 SUM(DATEDIFF(MINUTE,[${C.TECH}],[${C.END}])) AS total_min,
                 SUM(ISNULL(Waiting_time,0)) AS wait_min
          FROM ${v()} ${where}
          GROUP BY CONVERT(VARCHAR(7),[${C.OPR}],120),[${C.JT}] ORDER BY ym
        `),
        makeReq(params).query(`
          SELECT [${C.AREA}] AS area, [${C.JT}] AS job_type,
                 SUM(DATEDIFF(MINUTE,[${C.TECH}],[${C.END}])) AS total_min,
                 SUM(ISNULL(Waiting_time,0)) AS wait_min
          FROM ${v()} ${where} GROUP BY [${C.AREA}],[${C.JT}]
        `),
        makeReq(params).query(`
          SELECT [${C.AREA}] AS area, COUNT(DISTINCT [${C.MID}]) AS machine_count
          FROM ${v()} ${where} GROUP BY [${C.AREA}]
        `),
        makeReq(params).query(`
          SELECT COUNT(DISTINCT [${C.MID}]) AS machine_count FROM ${v()} ${where}
        `),
        makeReq(params).query(`
          SELECT [${C.MID}] AS machine_id, [${C.AREA}] AS area,
                 COUNT(*) AS freq,
                 ROUND(AVG(DATEDIFF(MINUTE,[${C.TECH}],[${C.END}]))*1.0,1) AS avg_dur_min,
                 ROUND(SUM(DATEDIFF(MINUTE,[${C.TECH}],[${C.END}]))/60.0,1) AS total_hours
          FROM ${v()} ${where} AND [${C.JT}] = 'M/C DOWN'
          GROUP BY [${C.MID}],[${C.AREA}] HAVING COUNT(*) >= 2 ORDER BY total_hours DESC
        `),
        makeReq(params).query(`
          SELECT TOP 10 [${C.SYM}] AS reason,
                 SUM(DATEDIFF(MINUTE,[${C.TECH}],[${C.END}]))/60.0 AS hours, COUNT(*) AS events
          FROM ${v()} ${where} AND [${C.JT}] IN (${downIn})
          AND [${C.SYM}] IS NOT NULL AND [${C.SYM}] != ''
          GROUP BY [${C.SYM}] ORDER BY hours DESC
        `),
        makeReq(params).query(`
          SELECT TOP 10 [${C.SYM}] AS reason,
                 SUM(DATEDIFF(MINUTE,[${C.TECH}],[${C.END}]))/60.0 AS hours, COUNT(*) AS events
          FROM ${v()} ${where} AND [${C.JT}] IN (${lostIn})
          AND [${C.SYM}] IS NOT NULL AND [${C.SYM}] != ''
          GROUP BY [${C.SYM}] ORDER BY hours DESC
        `),
      ]);

      const mcCount = Number((totalMcRs.recordset[0] as any)?.machine_count ?? 0);
      const kpis = computeKpis(kpiRs.recordset as any, mcCount, nd, shift);

      const topCauses = (rs: typeof topDownRs) => {
        const rows = rs.recordset as any[];
        const total = rows.reduce((s, r) => s + (Number(r.hours) || 0), 0) || 1;
        let cum = 0;
        return rows.map(r => {
          cum += Number(r.hours) || 0;
          return { reason: String(r.reason), hours: r2(Number(r.hours)), events: Number(r.events), cumulative_pct: r2(cum / total * 100) };
        });
      };

      const scatter = (scatterRs.recordset as any[]).map(r => ({
        code_machine:   String(r.machine_id ?? ''),
        area:           String(r.area ?? ''),
        frequency:      Number(r.freq ?? 0),
        avg_duration_h: r2(Number(r.avg_dur_min ?? 0) / 60),
      }));

      return reply.send({ status: 'ok', data: {
        raw: {
          kpi_totals: [
            { label: 'utilization', minutes: 0, pct: kpis.utilization_pct },
            { label: 'down',        minutes: 0, pct: kpis.downtime_pct },
            { label: 'pm',          minutes: 0, pct: kpis.pm_pct },
            { label: 'lost',        minutes: 0, pct: kpis.lost_time_pct },
          ],
          area_totals:   areaUtil(areaRs.recordset as any, mcCntRs.recordset as any, nd, shift),
          machine_count: mcCount,
          area_counts:   mcCntRs.recordset,
        },
        monthly_trend: monthlyTrend(monthRs.recordset as any, mcCount, shift),
        scatter,
        top_down:  topCauses(topDownRs),
        top_lost:  topCauses(topLostRs),
      }});
    }
  );

  app.get<{ Querystring: { start?: string; end?: string; areas?: string; shift?: string } }>(
    '/api/v1/utilization/by-machine', { preHandler: authPreHandler }, async (req, reply) => {
      const { start, end, areas, shift } = req.query;
      const { where, params } = buildWhere({ start, end, areas, shift });
      const nd = nDays(start, end);
      const h  = shift && ['DAY', 'NIGHT'].includes(shift.toUpperCase()) ? 12 : 24;

      const rs = await makeReq(params).query(`
        SELECT [${C.MID}] AS machine_id, [${C.AREA}] AS area, [${C.JT}] AS job_type,
               SUM(DATEDIFF(MINUTE,[${C.TECH}],[${C.END}])) AS total_min,
               SUM(ISNULL(Waiting_time,0)) AS wait_min
        FROM ${v()} ${where} GROUP BY [${C.MID}],[${C.AREA}],[${C.JT}]
      `);

      const map = new Map<string, { code_machine: string; area: string; down_min: number; pm_min: number; lost_min: number; wait_min: number }>();
      for (const r of rs.recordset as any[]) {
        const key = String(r.machine_id);
        if (!map.has(key)) map.set(key, { code_machine: key, area: String(r.area), down_min: 0, pm_min: 0, lost_min: 0, wait_min: 0 });
        const row = map.get(key)!;
        const tot = Number(r.total_min) || 0;
        if (r.job_type === 'M/C DOWN') row.down_min += tot;
        else if (r.job_type === 'PM')  row.pm_min   += tot;
        else                            row.lost_min += tot;
        row.wait_min += Number(r.wait_min) || 0;
      }

      const result = [...map.values()].map(r => {
        const avail = nd * h * 60 || 1;
        const used = r.down_min + r.pm_min + r.lost_min + r.wait_min;
        return {
          code_machine:    r.code_machine,
          area:            r.area,
          utilization_pct: r2(Math.max(0, 100 - used / avail * 100)),
          down_min:        r.down_min,
          pm_min:          r.pm_min,
          lost_min:        r.lost_min,
        };
      }).sort((a, b) => a.utilization_pct - b.utilization_pct);

      return reply.send({ status: 'ok', data: { rows: result } });
    }
  );

  app.get<{ Querystring: { start?: string; end?: string; areas?: string; shift?: string } }>(
    '/api/v1/utilization/attention', { preHandler: authPreHandler }, async (req, reply) => {
      const { start, end, areas, shift } = req.query;
      const { where, params } = buildWhere({ start, end, areas, shift });

      const rs = await makeReq(params).query(`
        SELECT TOP 10
          [${C.MID}] AS machine_id, [${C.AREA}] AS area,
          ROUND(SUM(DATEDIFF(MINUTE,[${C.TECH}],[${C.END}]))/60.0,1) AS down_hours,
          COUNT(*) AS event_count,
          ROUND(AVG(DATEDIFF(MINUTE,[${C.TECH}],[${C.END}]))*1.0,0) AS avg_mttr_min,
          ROUND(
            SUM(DATEDIFF(MINUTE,[${C.TECH}],[${C.END}]))/60.0*2.0
            + COUNT(*)
            + AVG(DATEDIFF(MINUTE,[${C.TECH}],[${C.END}]))/10.0
          ,1) AS score
        FROM ${v()} ${where} AND [${C.JT}] = 'M/C DOWN'
        GROUP BY [${C.MID}],[${C.AREA}] ORDER BY score DESC
      `);

      return reply.send({ status: 'ok', data: { rows: rs.recordset } });
    }
  );
}
