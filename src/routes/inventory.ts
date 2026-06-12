import type { FastifyInstance } from 'fastify';
import { pool } from '../db.js';
import { config } from '../config.js';
import { authPreHandler, C } from '../helpers.js';

const mt = () => config.machineTable;
const v  = () => config.view;

export default async function inventoryRoutes(app: FastifyInstance) {

  app.get<{ Querystring: { area?: string; key_only?: string } }>(
    '/api/v1/inventory/machines', { preHandler: authPreHandler }, async (req, reply) => {
      const { area, key_only } = req.query;
      const ko = key_only === 'true' || key_only === '1' || key_only === 'yes';

      const rs = await pool.request().query(`
        SELECT [code_machine],[des_machine],[mfg],[model],[sn],
               [id_operation],[short_name],[date_install],
               [flag_key],[flag_automotive],[flag_gold]
        FROM ${mt()}
        WHERE [id_operation] IS NOT NULL AND [id_operation] != ''
          AND ISNULL([flag_delete],0) != 1
        ORDER BY [id_operation],[code_machine]
      `);

      let rows = rs.recordset as any[];
      if (area) rows = rows.filter(r => r.id_operation === area);
      if (ko)   rows = rows.filter(r => r.flag_key == 1);

      const machines = rows.map(r => {
        let yr: number | null = null;
        if (r.date_install) try { yr = parseInt(String(r.date_install).slice(0, 4)); } catch { /**/ }
        return {
          machine_id:      String(r.code_machine ?? ''),
          des_machine:     String(r.des_machine ?? ''),
          area:            String(r.id_operation ?? ''),
          area_name:       String(r.short_name ?? ''),
          mfg:             String(r.mfg ?? ''),
          model:           String(r.model ?? ''),
          sn:              String(r.sn ?? ''),
          flag_key:        Number(r.flag_key ?? 0),
          flag_automotive: Number(r.flag_automotive ?? 0),
          flag_gold:       Number(r.flag_gold ?? 0),
          year_install:    yr,
        };
      });

      return reply.send({ status: 'ok', data: { machines } });
    }
  );

  app.get('/api/v1/inventory/downtime', { preHandler: authPreHandler }, async (_req, reply) => {
    const rs = await pool.request().query(`
      SELECT [${C.MID}] AS code_machine,
             COUNT(*) AS down_events,
             ROUND(SUM(DATEDIFF(MINUTE,[${C.TECH}],[${C.END}]))/60.0,1) AS down_hrs,
             ROUND(AVG(DATEDIFF(MINUTE,[${C.TECH}],[${C.END}])),0) AS avg_mttr_min
      FROM ${v()}
      WHERE [${C.JT}] = 'M/C DOWN'
        AND [${C.TECH}] IS NOT NULL AND [${C.END}] > [${C.TECH}]
        AND [${C.OPR}] >= DATEADD(DAY,-7,GETDATE())
      GROUP BY [${C.MID}]
    `);
    return reply.send({ status: 'ok', data: { rows: rs.recordset } });
  });

  app.get('/api/v1/inventory/last-package', { preHandler: authPreHandler }, async (_req, reply) => {
    const jt = config.jobTable;
    const rs = await pool.request().query(`
      SELECT code_machine, [Package Type] AS package_type,
             CONVERT(VARCHAR(10), datex, 120) AS last_run
      FROM (
        SELECT code_machine, [Package Type], datex,
               ROW_NUMBER() OVER (PARTITION BY code_machine ORDER BY datex DESC) AS rn
        FROM ${jt}
        WHERE code_machine IS NOT NULL AND code_machine != ''
      ) r
      WHERE r.rn = 1
    `);
    return reply.send({ status: 'ok', data: { packages: rs.recordset } });
  });

  app.get('/api/v1/inventory/probe-columns', { preHandler: authPreHandler }, async (_req, reply) => {
    const rs = await pool.request().query(`
      SELECT COLUMN_NAME AS col
      FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_CATALOG = '${config.db.database}'
        AND TABLE_SCHEMA   = 'dbo'
        AND TABLE_NAME     = 'job_listx'
      ORDER BY ORDINAL_POSITION
    `);
    return reply.send({ status: 'ok', data: { columns: rs.recordset.map((r: any) => r.col) } });
  });
}
