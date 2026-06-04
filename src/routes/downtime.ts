import type { FastifyInstance } from 'fastify';
import sql from 'mssql';
import { pool } from '../db.js';
import { config } from '../config.js';
import { authPreHandler, buildWhere, makeReq, parseAreas, C, DOWN_TYPES, r2 } from '../helpers.js';

const v = () => config.view;

function pivotMachinesByReason(
  rows: Array<{ code_machine: string; area: string; reason: string; hours: number }>,
  topN = 30,
): Record<string, unknown>[] {
  const map = new Map<string, Record<string, unknown>>();
  for (const r of rows) {
    const key = `${r.code_machine}|${r.area}`;
    if (!map.has(key)) map.set(key, { code_machine: r.code_machine, area: r.area, total_hours: 0 });
    const row = map.get(key)!;
    row[r.reason]    = ((row[r.reason]    as number) || 0) + (r.hours || 0);
    row.total_hours  = ((row.total_hours  as number) || 0) + (r.hours || 0);
  }
  return [...map.values()]
    .sort((a, b) => (b.total_hours as number) - (a.total_hours as number))
    .slice(0, topN);
}

export default async function downtimeRoutes(app: FastifyInstance) {

  app.get<{
    Querystring: {
      job_types?: string; start?: string; end?: string;
      areas?: string; shift?: string; reason_col?: string; limit?: string;
    }
  }>('/api/v1/downtime/detail', { preHandler: authPreHandler }, async (req, reply) => {
    const { job_types, start, end, areas, shift, reason_col } = req.query;
    const limit   = Math.min(Math.max(parseInt(req.query.limit ?? '20') || 20, 5), 50);
    const { where, params } = buildWhere({ start, end, areas, shift });
    const reasonC = reason_col === 'des_job' ? C.SYM : C.CAUSE;
    const jtList  = job_types ? job_types.split(',').map(j => j.trim()).filter(Boolean) : [...DOWN_TYPES];
    const jtIn    = jtList.map(j => `'${j}'`).join(', ');

    const [reasonRs, mrRs, shiftRs] = await Promise.all([
      makeReq(params).query(`
        SELECT [${reasonC}] AS reason, COUNT(*) AS cnt,
               SUM(DATEDIFF(MINUTE,[${C.TECH}],[${C.END}]))/60.0 AS hours,
               AVG(DATEDIFF(MINUTE,[${C.TECH}],[${C.END}])) AS avg_repair_min
        FROM ${v()} ${where} AND [${C.JT}] IN (${jtIn})
        AND [${reasonC}] IS NOT NULL AND [${reasonC}] != ''
        GROUP BY [${reasonC}] ORDER BY hours DESC
      `),
      makeReq(params).query(`
        SELECT [${C.MID}] AS code_machine, [${C.AREA}] AS area,
               [${reasonC}] AS reason,
               SUM(DATEDIFF(MINUTE,[${C.TECH}],[${C.END}]))/60.0 AS hours
        FROM ${v()} ${where} AND [${C.JT}] IN (${jtIn})
        AND [${reasonC}] IS NOT NULL AND [${reasonC}] != ''
        GROUP BY [${C.MID}],[${C.AREA}],[${reasonC}]
      `),
      makeReq(params).query(`
        SELECT
          CASE WHEN DATEPART(HOUR,[${C.OPR}]) >= 19
               THEN CAST(DATEADD(DAY,1,CAST([${C.OPR}] AS DATE)) AS NVARCHAR(10))
               ELSE CAST(CAST([${C.OPR}] AS DATE) AS NVARCHAR(10)) END AS day,
          CASE WHEN DATEPART(HOUR,[${C.OPR}]) BETWEEN 7 AND 18 THEN 'Day' ELSE 'Night' END AS shift_name,
          COUNT(*) AS events,
          SUM(DATEDIFF(MINUTE,[${C.TECH}],[${C.END}]))/60.0 AS repair_hrs,
          SUM(ISNULL(Waiting_time,0))/60.0 AS wait_hrs
        FROM ${v()} ${where} AND [${C.JT}] IN (${jtIn})
        GROUP BY
          CASE WHEN DATEPART(HOUR,[${C.OPR}]) >= 19
               THEN CAST(DATEADD(DAY,1,CAST([${C.OPR}] AS DATE)) AS NVARCHAR(10))
               ELSE CAST(CAST([${C.OPR}] AS DATE) AS NVARCHAR(10)) END,
          CASE WHEN DATEPART(HOUR,[${C.OPR}]) BETWEEN 7 AND 18 THEN 'Day' ELSE 'Night' END
        ORDER BY day, shift_name
      `),
    ]);

    const reasonRows  = reasonRs.recordset as any[];
    const totalHours  = reasonRows.reduce((s, r) => s + (Number(r.hours) || 0), 0);
    const totalEvents = reasonRows.reduce((s, r) => s + (Number(r.cnt) || 0), 0);
    const avgRepairH  = totalEvents > 0 ? r2(totalHours / totalEvents) : 0;
    const grandTotal  = totalHours || 1;
    let cum = 0;
    const reasons = reasonRows.slice(0, limit).map(r => {
      cum += Number(r.hours) || 0;
      return {
        reason:         String(r.reason),
        count:          Number(r.cnt ?? 0),
        hours:          r2(Number(r.hours)),
        avg_repair_min: Number(r.avg_repair_min ?? 0),
        cumulative_pct: r2(cum / grandTotal * 100),
      };
    });

    const mrRows = (mrRs.recordset as any[]).map(r => ({
      code_machine: String(r.code_machine ?? ''),
      area:         String(r.area ?? ''),
      reason:       String(r.reason ?? ''),
      hours:        Number(r.hours ?? 0),
    }));
    const machinesByReason = pivotMachinesByReason(mrRows);
    const topMachine  = (machinesByReason[0] as any)?.code_machine ?? '—';
    const topMachineH = r2(Number((machinesByReason[0] as any)?.total_hours ?? 0));

    return reply.send({ status: 'ok', data: {
      reason:             reasons,
      machines_by_reason: machinesByReason,
      daily_shift:        shiftRs.recordset,
      kpi: { total_hours: r2(totalHours), total_events: totalEvents, avg_repair_h: avgRepairH, top_machine: topMachine, top_machine_h: topMachineH },
    }});
  });

  app.get<{ Querystring: { areas?: string } }>(
    '/api/v1/downtime/machines', { preHandler: authPreHandler }, async (req, reply) => {
      const areaList = parseAreas(req.query.areas);
      const clauses  = [`[${C.JT}] = 'M/C DOWN'`];
      const req2     = pool.request();
      if (areaList?.length) {
        const phs = areaList.map((_, i) => `@a_${i}`).join(', ');
        clauses.push(`[${C.AREA}] IN (${phs})`);
        areaList.forEach((a, i) => req2.input(`a_${i}`, sql.VarChar, a));
      }
      const rs = await req2.query(`
        SELECT DISTINCT [${C.MID}] AS machine_id
        FROM ${v()} WHERE ${clauses.join(' AND ')} ORDER BY [${C.MID}]
      `);
      return reply.send({ status: 'ok', data: { machines: (rs.recordset as any[]).map(r => r.machine_id) } });
    }
  );

  app.get<{
    Querystring: {
      job_types?: string; start?: string; end?: string; areas?: string; shift?: string;
      machine?: string; symptom?: string; cause?: string; tech?: string; limit?: string;
    }
  }>('/api/v1/downtime/events', { preHandler: authPreHandler }, async (req, reply) => {
    const { job_types, start, end, areas, shift, machine, symptom, cause, tech } = req.query;
    const limit = Math.min(Math.max(parseInt(req.query.limit ?? '500') || 500, 50), 2000);
    const { where, params } = buildWhere({ start, end, areas, shift });
    const jtList = job_types
      ? job_types.split(',').map(j => j.trim()).filter(Boolean)
      : ['M/C DOWN', 'ENGINEERING DOWN', 'FACILITY DOWN', 'SETUP', 'SETUP BY OPERATOR', 'CONVERT', 'CLEAN MOLD', 'CHANGE CAP', 'PM'];
    const jtIn = jtList.map(j => `'${j}'`).join(', ');

    const evReq = makeReq(params);
    let extra = `AND [${C.JT}] IN (${jtIn})`;
    if (machine) { extra += ` AND RTRIM(LTRIM([${C.MID}])) = @evt_machine`; evReq.input('evt_machine', sql.VarChar, machine); }
    if (symptom) { extra += ` AND [${C.SYM}] = @evt_symptom`;               evReq.input('evt_symptom', sql.VarChar, symptom); }
    if (cause)   { extra += ` AND [${C.CAUSE}] = @evt_cause`;                evReq.input('evt_cause',   sql.VarChar, cause); }
    if (tech)    { extra += ` AND ISNULL(by_perform,by_ack) = @evt_tech`;    evReq.input('evt_tech',    sql.VarChar, tech); }

    const rs = await evReq.query(`
      SELECT TOP ${limit}
        [${C.OPR}]   AS event_time,
        [${C.MID}]   AS machine_id,
        [${C.AREA}]  AS area,
        [${C.JT}]    AS job_type,
        [${C.SYM}]   AS symptom,
        [${C.CAUSE}] AS cause,
        ISNULL(by_perform,by_ack) AS tech,
        ISNULL(Waiting_time,0) AS wait_min,
        DATEDIFF(MINUTE,[${C.TECH}],[${C.END}]) AS repair_min,
        [mpc] AS die_mask, [lot_no] AS lot_no, [Package Type] AS package_type
      FROM ${v()} ${where} ${extra}
      ORDER BY [${C.OPR}] DESC
    `);

    const events = (rs.recordset as any[]).map(r => ({
      event_time:   r.event_time instanceof Date ? r.event_time.toISOString() : '',
      machine_id:   String(r.machine_id ?? ''),
      area:         String(r.area ?? ''),
      job_type:     String(r.job_type ?? ''),
      symptom:      r.symptom    != null ? String(r.symptom)    : '',
      cause:        r.cause      != null ? String(r.cause)      : '',
      tech:         r.tech       != null ? String(r.tech)       : '',
      wait_min:     Number(r.wait_min ?? 0),
      repair_min:   Number(r.repair_min ?? 0),
      die_mask:     r.die_mask     != null ? String(r.die_mask)     : '',
      lot_no:       r.lot_no       != null ? String(r.lot_no)       : '',
      package_type: r.package_type != null ? String(r.package_type) : '',
    }));

    return reply.send({ status: 'ok', data: { events, total: events.length } });
  });
}
