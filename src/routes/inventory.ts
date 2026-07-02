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

  // Combined endpoint — matches what the frontend inventoryApi.all() calls
  app.get<{ Querystring: { areas?: string; key_only?: string } }>(
    '/api/v1/inventory', { preHandler: authPreHandler }, async (req, reply) => {
      const { key_only } = req.query;
      const ko = key_only === 'true' || key_only === '1' || key_only === 'yes';

      const [mcRs, dtRs, pkgRs] = await Promise.all([
        pool.request().query(`
          SELECT [code_machine],[des_machine],[mfg],[model],[sn],
                 [id_operation],[short_name],[date_install],
                 [flag_key],[flag_automotive],[flag_gold]
          FROM ${mt()}
          WHERE [id_operation] IS NOT NULL AND [id_operation] != ''
            AND ISNULL([flag_delete],0) != 1
          ORDER BY [id_operation],[code_machine]
        `),
        pool.request().query(`
          SELECT [${C.MID}] AS code_machine,
                 COUNT(*) AS down_events,
                 ROUND(SUM(DATEDIFF(MINUTE,[${C.TECH}],[${C.END}]))/60.0,1) AS down_hrs,
                 ROUND(AVG(DATEDIFF(MINUTE,[${C.TECH}],[${C.END}])),0) AS avg_mttr_min
          FROM ${v()}
          WHERE [${C.JT}] = 'M/C DOWN'
            AND [${C.TECH}] IS NOT NULL AND [${C.END}] > [${C.TECH}]
            AND [${C.OPR}] >= DATEADD(DAY,-7,GETDATE())
          GROUP BY [${C.MID}]
        `),
        pool.request().query(`
          SELECT code_machine, [Package Type] AS package_type,
                 CONVERT(VARCHAR(10), datex, 120) AS last_run
          FROM (
            SELECT code_machine, [Package Type], datex,
                   ROW_NUMBER() OVER (PARTITION BY code_machine ORDER BY datex DESC) AS rn
            FROM ${config.jobTable}
            WHERE code_machine IS NOT NULL AND code_machine != ''
              AND datex >= DATEADD(DAY,-90,GETDATE())
          ) r WHERE r.rn = 1
        `),
      ]);

      const dtMap  = new Map((dtRs.recordset  as any[]).map(r => [String(r.code_machine), r]));
      const pkgMap = new Map((pkgRs.recordset as any[]).map(r => [String(r.code_machine), r]));

      let rows = mcRs.recordset as any[];
      if (ko) rows = rows.filter(r => r.flag_key == 1);

      const machines = rows.map(r => {
        const mid = String(r.code_machine ?? '');
        let yr: number | null = null;
        if (r.date_install) try { yr = parseInt(String(r.date_install).slice(0, 4)); } catch { /**/ }

        const dt  = dtMap.get(mid);
        const pkg = pkgMap.get(mid);
        const downEvents  = Number(dt?.down_events  ?? 0);
        const downHrs     = Number(dt?.down_hrs     ?? 0);
        const avgMttrMin  = Number(dt?.avg_mttr_min ?? 0);

        // Health: critical ≥3 events or ≥8h, warning ≥2 or ≥4h, monitor ≥1, healthy
        let health: string;
        if (downEvents >= 3 || downHrs >= 8)       health = 'critical';
        else if (downEvents >= 2 || downHrs >= 4)  health = 'warning';
        else if (downEvents >= 1)                  health = 'monitor';
        else                                       health = 'healthy';

        return {
          id:           mid,
          code_machine: mid,
          area:         String(r.id_operation ?? ''),
          area_name:    String(r.short_name   ?? ''),
          model:        String(r.model        ?? ''),
          manufacturer: String(r.mfg          ?? ''),
          des_machine:  String(r.des_machine  ?? ''),
          serial_no:    r.sn ? String(r.sn) : null,
          year_install: yr,
          is_key:       r.flag_key    == 1,
          is_auto:      r.flag_automotive == 1,
          is_gold:      r.flag_gold   == 1,
          notes:        null,
          status:       'Running',
          down_events:  downEvents,
          down_hrs:     downHrs,
          avg_mttr_min: avgMttrMin,
          health,
          last_package: pkg?.package_type ?? null,
          last_run_date: pkg?.last_run ?? null,
        };
      });

      const areas  = new Set(machines.map(m => m.area)).size;
      const models = new Set(machines.map(m => m.model).filter(Boolean)).size;
      const kpi = {
        total_machines: machines.length,
        key_machines:   machines.filter(m => m.is_key).length,
        areas,
        models,
      };

      return reply.send({ status: 'ok', data: { machines, kpi } });
    }
  );

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
