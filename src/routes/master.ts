import type { FastifyInstance } from 'fastify';
import sql from 'mssql';
import { pool } from '../db.js';
import { config } from '../config.js';
import { authPreHandler } from '../helpers.js';

const mt = () => config.machineTable;
const v  = () => config.view;

export default async function masterRoutes(app: FastifyInstance) {

  app.get('/api/v1/areas', { preHandler: authPreHandler }, async (_req, reply) => {
    const rs = await pool.request().query<{ area: string; short_name: string | null }>(`
      SELECT DISTINCT [id_operation] AS area, [short_name]
      FROM ${mt()}
      WHERE [id_operation] IS NOT NULL AND [id_operation] != ''
      ORDER BY [id_operation]
    `);
    return reply.send({ status: 'ok', data: {
      areas: rs.recordset.map(r => ({ area: r.area, short_name: r.short_name ?? '' })),
    }});
  });

  app.get<{ Querystring: { area?: string; key_only?: string } }>(
    '/api/v1/machines', { preHandler: authPreHandler }, async (req, reply) => {
      const { area, key_only } = req.query;
      const ko = key_only === 'true' || key_only === '1' || key_only === 'yes';
      const clauses: string[] = ["ISNULL([flag_delete],0) != 1"];
      const mcReq = pool.request();
      if (area) { clauses.push('[id_operation] = @area'); mcReq.input('area', sql.VarChar, area); }
      if (ko)   { clauses.push('[flag_key] = 1'); }
      const where = 'WHERE ' + clauses.join(' AND ');

      const [mcRs, flagRs] = await Promise.all([
        mcReq.query(`
          SELECT [code_machine] AS machine_id, [des_machine],
                 [id_operation] AS area, [short_name] AS area_name
          FROM ${mt()} ${where}
          ORDER BY [id_operation], [code_machine]
        `),
        pool.request().query(`
          SELECT [code_machine],[flag_key],[flag_automotive],[flag_gold],[mfg],[model],[sn]
          FROM ${mt()}
          WHERE [id_operation] IS NOT NULL AND ISNULL([flag_delete],0) != 1
        `),
      ]);

      const flags = new Map((flagRs.recordset as any[]).map(r => [String(r.code_machine), r]));
      const machines = (mcRs.recordset as any[]).map(r => {
        const f = flags.get(r.machine_id);
        return {
          machine_id:      String(r.machine_id ?? ''),
          des_machine:     String(r.des_machine ?? ''),
          area:            String(r.area ?? ''),
          area_name:       String(r.area_name ?? ''),
          mfg:             String(f?.mfg ?? ''),
          model:           String(f?.model ?? ''),
          sn:              String(f?.sn ?? ''),
          flag_key:        Number(f?.flag_key ?? 0),
          flag_automotive: Number(f?.flag_automotive ?? 0),
          flag_gold:       Number(f?.flag_gold ?? 0),
        };
      });
      return reply.send({ status: 'ok', data: { machines } });
    }
  );

  app.get<{ Querystring: { id: string; recent_limit?: string } }>(
    '/api/v1/machines/detail', { preHandler: authPreHandler }, async (req, reply) => {
      const { id, recent_limit } = req.query;
      if (!id) return reply.code(400).send({ status: 'error', error: { code: 400, message: 'id required' } });
      const lim = Math.min(parseInt(recent_limit ?? '25') || 25, 200);

      const [infoRs, kpiRs, evRs] = await Promise.all([
        pool.request().input('mid', sql.VarChar, id).query(`
          SELECT [code_machine],[des_machine],[mfg],[model],[sn],
                 [id_operation] AS area,[flag_key],[remark],[date_install]
          FROM ${mt()} WHERE RTRIM(LTRIM([code_machine])) = @mid
        `),
        pool.request().input('mid', sql.VarChar, id).query(`
          SELECT
            COUNT(CASE WHEN [job_type]='M/C DOWN' THEN 1 END) AS down_events,
            ROUND(AVG(CASE WHEN [job_type]='M/C DOWN'
              THEN DATEDIFF(MINUTE,[date_ack],[date_close])*1.0 END),0) AS avg_mttr_min,
            COUNT(CASE WHEN [job_type]='PM' THEN 1 END) AS pm_events
          FROM ${v()}
          WHERE RTRIM(LTRIM([code_machine]))=@mid
            AND [datex] >= DATEADD(DAY,-30,GETDATE())
            AND [date_ack] IS NOT NULL AND [date_close] > [date_ack]
        `),
        pool.request().input('mid', sql.VarChar, id).query(`
          SELECT TOP ${lim}
            [datex] AS ts, [job_type],
            CASE WHEN [date_ack] IS NULL  THEN 'Waiting'
                 WHEN [date_close] IS NULL THEN 'On Process'
                 ELSE 'Closed' END AS status,
            DATEDIFF(MINUTE,
              COALESCE([date_ack],[datex]),
              COALESCE([date_close],GETDATE())) AS duration_min
          FROM ${v()}
          WHERE RTRIM(LTRIM([code_machine]))=@mid
          ORDER BY [datex] DESC
        `),
      ]);

      let info: Record<string, unknown> = { machine_id: id, area: '', flag_key: 0, mfg: '', model: '', sn: '', notes: null };
      if (infoRs.recordset.length) {
        const r = infoRs.recordset[0] as any;
        info = {
          machine_id:  String(r.code_machine ?? id),
          des_machine: String(r.des_machine ?? ''),
          area:        String(r.area ?? ''),
          flag_key:    Number(r.flag_key ?? 0),
          mfg:         String(r.mfg ?? ''),
          model:       String(r.model ?? ''),
          sn:          String(r.sn ?? ''),
          notes:       r.remark ?? null,
        };
      }

      const kpis = { down_events: 0, avg_mttr_min: 0, pm_events: 0, utilization_pct: 0 };
      if (kpiRs.recordset.length) {
        const r = kpiRs.recordset[0] as any;
        kpis.down_events  = Number(r.down_events ?? 0);
        kpis.avg_mttr_min = Number(r.avg_mttr_min ?? 0);
        kpis.pm_events    = Number(r.pm_events ?? 0);
      }

      const events = (evRs.recordset as any[]).map(r => ({
        ts:           r.ts instanceof Date ? r.ts.toISOString() : '',
        job_type:     String(r.job_type ?? ''),
        status:       String(r.status ?? ''),
        duration_min: Number(r.duration_min ?? 0),
      }));

      return reply.send({ status: 'ok', data: { info, kpis, recent_events: events } });
    }
  );

  app.get<{ Querystring: { id: string; limit?: string } }>(
    '/api/v1/machines/records', { preHandler: authPreHandler }, async (req, reply) => {
      const { id, limit } = req.query;
      if (!id) return reply.code(400).send({ status: 'error', error: { code: 400, message: 'id required' } });
      const lim = Math.min(parseInt(limit ?? '200') || 200, 1000);
      const rs = await pool.request().input('mid', sql.VarChar, id).query(`
        SELECT TOP ${lim} * FROM ${v()}
        WHERE RTRIM(LTRIM([code_machine]))=@mid ORDER BY [datex] DESC
      `);
      const records = (rs.recordset as any[]).map(r => {
        const out: Record<string, unknown> = {};
        for (const [k, val] of Object.entries(r)) out[k] = val instanceof Date ? val.toISOString() : val;
        return out;
      });
      return reply.send({ status: 'ok', data: { records } });
    }
  );
}
