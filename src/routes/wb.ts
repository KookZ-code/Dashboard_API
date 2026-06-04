// WB Report endpoint — Node.js/TypeScript port of Python api_server.py
// /api/v1/wb/report (lines 1138-1318) and utils/queries.py wb_shift_report()
// (lines 692-750).

import type { FastifyInstance } from 'fastify';
import sql from 'mssql';
import { pool } from '../db.js';
import { config } from '../config.js';

// ── Job type sets — api_server.py lines 1190-1191 ────────────────────────
const LOST_TYPES = new Set([
  'SETUP', 'SETUP BY OPERATOR', 'CONVERT', 'CLEAN MOLD',
  'CHANGE CAP', 'FACILITY DOWN', 'ENGINEERING DOWN',
]);
const SETUP_CONV = new Set(['SETUP', 'CONVERT', 'CLEAN MOLD', 'CHANGE CAP']);
const SHIFT_MIN = 720; // 12-hour shift in minutes

// ── Types ─────────────────────────────────────────────────────────────────
interface ShiftEvent {
  code_machine: string;
  job_type: string | null;
  datex: Date | null;
  date_ack: Date | null;
  date_close: Date | null;
  des_job: string | null;
  wait_min: number;
  tech_name: string | null;
  package_type: string | null;
}

interface OpenJob {
  code_machine: string;
  job_type: string;
  des_job: string | null;
  t_start: string;
  dur_min: number;
}

interface WbEvent {
  job_type: string;
  t_start: string;
  t_end: string;
  des_job: string;
  dur_min: number;
  is_open: boolean;
}

interface MachineRow {
  machine_id: string;
  package: string;
  util_pct: number;
  wait_down_min: number;
  down_min: number;
  wait_setup_min: number;
  setup_min: number;
  setup_conv_min: number;
  sbo_min: number;
  total_loss_min: number;
  events: WbEvent[];
}

// ── Helpers ───────────────────────────────────────────────────────────────

// Shift window — api_server.py lines 1149-1155
function shiftWindow(date: string, shift: string): { start: Date; end: Date } {
  const [y, m, d] = date.split('-').map(Number);
  if (shift === 'Day') {
    return {
      start: new Date(y, m - 1, d, 7, 0, 0),
      end:   new Date(y, m - 1, d, 19, 0, 0),
    };
  }
  // Night: previous-evening 19:00 → this-morning 07:00
  const end   = new Date(y, m - 1, d, 7, 0, 0);
  const start = new Date(end.getTime() - 12 * 3_600_000);
  return { start, end };
}

function fmtHhmm(d: Date | null): string {
  if (!d) return '';
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function round1(v: number): number {
  return Math.round(v * 10) / 10;
}

// ── DB queries ────────────────────────────────────────────────────────────

// Closed shift events for all WB key machines + last-known package
// utils/queries.py wb_shift_report() lines 692-750
async function queryShiftEvents(shiftStart: Date, shiftEnd: Date, refDate: string): Promise<ShiftEvent[]> {
  const v  = config.view;
  const mt = config.machineTable;
  const req = pool.request();
  req.input('shift_start', sql.DateTime, shiftStart);
  req.input('shift_end',   sql.DateTime, shiftEnd);
  req.input('ref_date',    sql.VarChar,  refDate);
  const result = await req.query<ShiftEvent>(`
    WITH
    key_mc AS (
        SELECT RTRIM(LTRIM([code_machine])) AS code_machine
        FROM ${mt}
        WHERE [id_operation] = 'WB'
          AND [flag_key] = 1
          AND ISNULL([flag_delete], 0) != 1
    ),
    shift_ev AS (
        SELECT RTRIM(LTRIM([code_machine]))                            AS code_machine,
               [job_type], [datex], [date_ack], [date_close], [des_job],
               ISNULL([Waiting_time], 0)                               AS wait_min,
               [Package Type]                                          AS package_type,
               NULLIF(RTRIM(LTRIM(ISNULL([by_perform], [by_ack]))), '') AS tech_name
        FROM ${v}
        WHERE [id_operation] = 'WB'
          AND [datex]      >= @shift_start
          AND [datex]      <  @shift_end
          AND [date_close] IS NOT NULL
          AND [date_close] >  [datex]
    ),
    pkg_scan AS (
        SELECT RTRIM(LTRIM([code_machine])) AS code_machine,
               [Package Type] AS package_type,
               ROW_NUMBER() OVER (
                   PARTITION BY RTRIM(LTRIM([code_machine]))
                   ORDER BY [datex] DESC
               ) AS rn
        FROM ${v}
        WHERE [id_operation] = 'WB'
          AND [Package Type] IS NOT NULL AND [Package Type] != ''
          AND [datex] >= DATEADD(DAY, -7, CAST(@ref_date AS DATE))
          AND [datex] <  DATEADD(DAY,  1, CAST(@ref_date AS DATE))
    ),
    last_pkg AS (
        SELECT code_machine, package_type FROM pkg_scan WHERE rn = 1
    )
    SELECT k.code_machine,
           se.job_type, se.datex, se.date_ack, se.date_close,
           se.des_job,  se.wait_min, se.tech_name,
           COALESCE(se.package_type, lp.package_type) AS package_type
    FROM key_mc k
    LEFT JOIN shift_ev se ON k.code_machine = se.code_machine
    LEFT JOIN last_pkg lp  ON k.code_machine = lp.code_machine
    ORDER BY k.code_machine, se.datex`);
  return result.recordset;
}

// Currently-open WB jobs — api_server.py lines 1257-1266
async function queryOpenJobs(): Promise<OpenJob[]> {
  const result = await pool.request().query<OpenJob>(`
    SELECT RTRIM(LTRIM(code_machine))       AS code_machine,
           job_type,
           des_job,
           FORMAT(datex, 'HH:mm')           AS t_start,
           DATEDIFF(MINUTE, datex, GETDATE()) AS dur_min
    FROM dbo.job_list
    WHERE id_operation = 'WB'
      AND date_close IS NULL
      AND code_machine != ''
      AND LEN(code_machine) > 3`);
  return result.recordset;
}

// ── Route ─────────────────────────────────────────────────────────────────

export default async function wbRoutes(app: FastifyInstance): Promise<void> {

  // ── wb/packages ────────────────────────────────────────────────────────────
  app.get<{ Querystring: { date: string } }>('/api/v1/wb/packages', {
    preHandler: async (req, reply) => {
      if (config.api.key && req.headers['x-api-key'] !== config.api.key) {
        await reply.code(401).send({ status: 'error', error: { code: 401, message: 'Invalid API key' } });
      }
    },
  }, async (req, reply) => {
    const { date } = req.query;
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return reply.code(400).send({ status: 'error', error: { code: 400, message: 'date (YYYY-MM-DD) required' } });
    }
    const rs = await pool.request()
      .input('date_val', sql.VarChar, date)
      .query<{ package_type: string }>(`
        SELECT DISTINCT [Package Type] AS package_type
        FROM ${config.view}
        WHERE [id_operation] = 'WB'
          AND [Package Type] IS NOT NULL AND [Package Type] != ''
          AND [datex] >= DATEADD(DAY, -7, @date_val)
          AND [datex] <  DATEADD(DAY,  1, @date_val)
        ORDER BY [Package Type]
      `);
    const pkgs = rs.recordset.map(r => r.package_type).filter(Boolean).sort();
    const opts: Array<{ value: string; label: string }> = [{ value: '__ALL__', label: '— All Packages —' }];
    if (pkgs.some(p => p.toUpperCase().includes('QFN'))) opts.push({ value: '__QFN__', label: '— All QFN —' });
    opts.push(...pkgs.map(p => ({ value: p, label: p })));
    return reply.send({ status: 'ok', data: { options: opts, packages: pkgs } });
  });

  // ── wb/report ──────────────────────────────────────────────────────────────
  app.get<{
    Querystring: { date?: string; shift?: string; packages?: string };
  }>('/api/v1/wb/report', {
    preHandler: async (req, reply) => {
      if (config.api.key && req.headers['x-api-key'] !== config.api.key) {
        await reply.code(401).send({ status: 'error', error: { code: 401, message: 'Invalid API key' } });
      }
    },
  }, async (req, reply) => {
    const { date, shift = 'Night', packages = '__ALL__' } = req.query;

    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return reply.code(400).send({ status: 'error', error: { code: 400, message: 'date (YYYY-MM-DD) required' } });
    }

    const { start: shiftStart, end: shiftEnd } = shiftWindow(date, shift);
    const timeRange = `${fmtHhmm(shiftStart)} → ${fmtHhmm(shiftEnd)}`;

    // Package filter — api_server.py lines 1163-1187
    const pkgList = packages.split(',').map(p => p.trim()).filter(Boolean);
    const hasAll  = pkgList.length === 0 || pkgList.includes('__ALL__');
    const hasQfn  = pkgList.includes('__QFN__');
    const pkgSet  = new Set(pkgList.filter(p => !p.startsWith('__')));

    // Fetch closed events + open jobs in parallel
    const [events, openJobs] = await Promise.all([
      queryShiftEvents(shiftStart, shiftEnd, date),
      queryOpenJobs(),
    ]);

    // Build machine → last-known package (last row wins, events ordered by datex)
    const machinePkg = new Map<string, string>();
    for (const ev of events) {
      if (ev.package_type?.trim()) machinePkg.set(ev.code_machine, ev.package_type.trim());
    }

    // All key machines (including those with no events — appear with null job_type)
    const allMachines = [...new Set(events.map(e => e.code_machine))].sort();

    // Filter target machines by package
    let target: string[];
    let pkgLabel: string;
    if (hasAll) {
      target   = allMachines;
      pkgLabel = 'All Packages';
    } else if (hasQfn) {
      target   = allMachines.filter(m => (machinePkg.get(m) ?? '').toUpperCase().includes('QFN'));
      pkgLabel = 'All QFN';
    } else {
      target   = allMachines.filter(m => pkgSet.has(machinePkg.get(m) ?? ''));
      pkgLabel = pkgSet.size <= 2 ? [...pkgSet].sort().join(', ') : `${pkgSet.size} packages`;
    }

    // Group closed events by machine
    const closedByMachine = new Map<string, ShiftEvent[]>();
    for (const ev of events) {
      if (!ev.job_type) continue; // null row = machine with no events
      const arr = closedByMachine.get(ev.code_machine);
      if (arr) arr.push(ev);
      else closedByMachine.set(ev.code_machine, [ev]);
    }

    // Group open jobs by machine
    const openByMachine = new Map<string, OpenJob[]>();
    for (const oj of openJobs) {
      const arr = openByMachine.get(oj.code_machine);
      if (arr) arr.push(oj);
      else openByMachine.set(oj.code_machine, [oj]);
    }

    // ── Per-machine accumulation — api_server.py lines 1196-1251 ─────
    const machineRows: MachineRow[] = [];

    for (const mid of target) {
      let waitDown = 0, downMin = 0, waitSetup = 0, setupMin = 0;
      let setupConvMin = 0, sboMin = 0;
      const eventList: WbEvent[] = [];

      for (const ev of closedByMachine.get(mid) ?? []) {
        const jt = (ev.job_type ?? '').toUpperCase().trim();
        const wt = ev.wait_min ?? 0;

        let repair = 0;
        if (ev.date_ack && ev.date_close && ev.date_close > ev.date_ack) {
          repair = Math.round((ev.date_close.getTime() - ev.date_ack.getTime()) / 60_000);
        } else if (ev.datex && ev.date_close) {
          repair = Math.max(0, Math.round((ev.date_close.getTime() - ev.datex.getTime()) / 60_000) - wt);
        }

        if (jt === 'M/C DOWN') {
          waitDown += wt;  downMin  += repair;
        } else if (LOST_TYPES.has(jt)) {
          waitSetup += wt; setupMin  += repair;
          if (jt === 'SETUP BY OPERATOR') sboMin       += repair;
          if (SETUP_CONV.has(jt))          setupConvMin += repair;
        }

        eventList.push({
          job_type: ev.job_type ?? '',
          t_start:  fmtHhmm(ev.datex),
          t_end:    fmtHhmm(ev.date_close),
          des_job:  ev.des_job ?? '',
          dur_min:  repair + wt,
          is_open:  false,
        });
      }

      // Open jobs injected with is_open: true
      for (const oj of openByMachine.get(mid) ?? []) {
        const jt = (oj.job_type ?? '').toUpperCase();
        if (jt === 'M/C DOWN')          waitDown  += oj.dur_min;
        else if (LOST_TYPES.has(jt))    waitSetup += oj.dur_min;
        eventList.push({
          job_type: oj.job_type,
          t_start:  oj.t_start,
          t_end:    '',
          des_job:  oj.des_job ?? '',
          dur_min:  oj.dur_min,
          is_open:  true,
        });
      }

      const totalLoss = waitDown + downMin + waitSetup + setupMin;
      const utilPct   = Math.max(0, Math.min(100, (SHIFT_MIN - totalLoss) / SHIFT_MIN * 100));

      machineRows.push({
        machine_id:     mid,
        package:        machinePkg.get(mid) ?? '',
        util_pct:       round1(utilPct),
        wait_down_min:  waitDown,
        down_min:       downMin,
        wait_setup_min: waitSetup,
        setup_min:      setupMin,
        setup_conv_min: setupConvMin,
        sbo_min:        sboMin,
        total_loss_min: totalLoss,
        events:         eventList,
      });
    }

    machineRows.sort((a, b) => a.util_pct - b.util_pct);

    // ── Fleet KPIs ────────────────────────────────────────────────────
    const n        = machineRows.length;
    const fleetMin = n * SHIFT_MIN;
    const avgUtil  = n > 0 ? machineRows.reduce((s, r) => s + r.util_pct, 0) / n : 0;
    const techSet  = new Set(events.map(e => e.tech_name).filter(Boolean));

    const sum = (fn: (r: MachineRow) => number) => machineRows.reduce((s, r) => s + fn(r), 0);
    const pct = (mins: number) => fleetMin > 0 ? round1(mins / fleetMin * 100) : 0;

    const kpi = {
      total:          n,
      n_down:         machineRows.filter(r => r.down_min > 0).length,
      n_setup:        machineRows.filter(r => r.down_min === 0 && r.setup_min + r.wait_setup_min > 0).length,
      n_full:         machineRows.filter(r => r.total_loss_min === 0).length,
      n_low:          machineRows.filter(r => r.util_pct < 85).length,
      avg_util:       round1(avgUtil),
      down_pct:       pct(sum(r => r.down_min)),
      wait_pct:       pct(sum(r => r.wait_down_min + r.wait_setup_min)),
      setup_conv_pct: pct(sum(r => r.setup_conv_min)),
      sbo_pct:        pct(sum(r => r.sbo_min)),
      n_tech:         techSet.size,
    };

    return reply.send({
      status: 'ok',
      data: { machines: machineRows, kpi, pkg_label: pkgLabel, shift, time_range: timeRange },
    });
  });
}
