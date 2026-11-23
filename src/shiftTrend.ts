// 7-day, 14-shift trend for the WB and DA areas — port of the Rust report_7day_for and
// compute_shift_metrics_with_details (Dashboad_API_rush/src/repositories/wb_repo.rs).
//
// Differences from the shift report (wb.ts / da.ts), kept on purpose to match the Rust trend:
//   - Technician stats only count technicians whose name starts with "B".
//   - Open jobs are limited to the shift window and read from the job view (config.jobTable).
//   - Closed events exclude causes CANCEL / N/A.
//
// Route handlers call shiftTrend7day(); both WB and DA reuse it so the two stay identical.

import sql from 'mssql';
import { pool } from './db.js';
import { config } from './config.js';

export type Op = 'WB' | 'DA';

const LOST_TYPES = new Set([
  'SETUP', 'SETUP BY OPERATOR', 'CONVERT', 'CLEAN MOLD',
  'CHANGE CAP', 'FACILITY DOWN', 'ENGINEERING DOWN',
]);
const SETUP_CONV = new Set(['SETUP', 'CONVERT', 'CLEAN MOLD', 'CHANGE CAP']);
const SHIFT_MIN = 720;

export interface ShiftEventRow {
  code_machine: string;
  job_type: string | null;      // null = key machine with no closed event in the window
  datex: Date | null;
  date_ack: Date | null;
  date_close: Date | null;
  des_job: string | null;
  wait_min: number | null;
  tech_name: string | null;
  package_type: string | null;  // falls back to the machine's last-known package
}

export interface OpenJobRow {
  code_machine: string;
  job_type: string;
  des_job: string | null;
  t_start: string;
  dur_min: number;
  tech_name: string | null;
}

const r1 = (v: number): number => Math.round(v * 10) / 10;
const mean = (xs: number[]): number => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0);
const pad = (n: number): string => String(n).padStart(2, '0');
const fmtDate = (d: Date): string => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/** True for a real calendar date in YYYY-MM-DD form (rejects e.g. 2026-02-30). */
export function isValidIsoDate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  return dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d;
}

/** Shift window as local "YYYY-MM-DD HH:mm:ss" strings (VarChar, so Tedious does not shift timezones). */
function shiftWindow(date: string, shift: 'Day' | 'Night'): [string, string] {
  if (shift === 'Day') return [`${date} 07:00:00`, `${date} 19:00:00`];
  const [y, m, d] = date.split('-').map(Number);
  const prev = fmtDate(new Date(y, m - 1, d - 1));
  return [`${prev} 19:00:00`, `${date} 07:00:00`];
}

/** Repair minutes for a closed job, same branches as the Rust code (cause of the two-branch fallback included). */
function repairMinutes(r: ShiftEventRow, wt: number): number {
  if (r.date_ack && r.date_close) {
    return r.date_close > r.date_ack
      ? Math.round(Math.trunc((r.date_close.getTime() - r.date_ack.getTime()) / 1000) / 60)
      : 0;
  }
  if (r.datex && r.date_close) {
    return Math.round(Math.max(0, Math.trunc((r.date_close.getTime() - r.datex.getTime()) / 1000) / 60 - wt));
  }
  return 0;
}

/** Fetches closed events (with key machines and last package) and open jobs for one shift window. */
export async function fetchShiftRows(
  op: Op, start: string, end: string, refDate: string,
): Promise<{ events: ShiftEventRow[]; openJobs: OpenJobRow[] }> {
  const evReq = pool.request();
  evReq.input('p1', sql.VarChar, start);
  evReq.input('p2', sql.VarChar, end);
  evReq.input('p3', sql.VarChar, refDate);
  const evSql = `
    WITH key_mc AS (
      SELECT RTRIM(LTRIM([code_machine])) AS code_machine FROM ${config.machineTable}
      WHERE [id_operation] = '${op}' AND [flag_key] = 1 AND ISNULL([flag_delete],0) != 1
    ), shift_ev AS (
      SELECT RTRIM(LTRIM([code_machine])) AS code_machine, [job_type], [datex], [date_ack], [date_close], [des_job],
             ISNULL([Waiting_time],0) AS wait_min, [Package Type] AS package_type,
             NULLIF(RTRIM(LTRIM(ISNULL([by_perform],[by_ack]))),'') AS tech_name
      FROM ${config.view} WHERE [id_operation] = '${op}' AND [datex] >= @p1 AND [datex] < @p2
        AND [date_close] IS NOT NULL AND [date_close] > [datex]
        AND UPPER(ISNULL([cause],'')) NOT IN ('CANCEL', 'N/A')
    ), pkg_scan AS (
      SELECT RTRIM(LTRIM([code_machine])) AS code_machine, [Package Type] AS package_type,
             ROW_NUMBER() OVER (PARTITION BY RTRIM(LTRIM([code_machine])) ORDER BY [datex] DESC) AS rn
      FROM ${config.view} WHERE [id_operation] = '${op}' AND [Package Type] IS NOT NULL AND [Package Type] != ''
        AND [datex] >= DATEADD(DAY,-7,CAST(@p3 AS DATE)) AND [datex] < DATEADD(DAY,1,CAST(@p3 AS DATE))
    ), last_pkg AS (SELECT code_machine, package_type FROM pkg_scan WHERE rn = 1)
    SELECT k.code_machine, se.job_type, se.datex, se.date_ack, se.date_close, se.des_job, se.wait_min, se.tech_name,
           COALESCE(se.package_type, lp.package_type) AS package_type
    FROM key_mc k
    LEFT JOIN shift_ev se ON k.code_machine = se.code_machine
    LEFT JOIN last_pkg lp ON k.code_machine = lp.code_machine
    ORDER BY k.code_machine, se.datex`;

  const opReq = pool.request();
  opReq.input('p1', sql.VarChar, start);
  opReq.input('p2', sql.VarChar, end);
  const opSql = `
    SELECT RTRIM(LTRIM(code_machine)) AS code_machine, job_type, des_job,
           FORMAT(datex, 'HH:mm') AS t_start,
           CASE WHEN date_close IS NOT NULL THEN DATEDIFF(MINUTE, datex, date_close)
                ELSE DATEDIFF(MINUTE, datex, GETDATE()) END AS dur_min,
           ISNULL(by_perform, by_ack) AS tech_name
    FROM ${config.jobTable}
    WHERE id_operation = '${op}' AND code_machine != '' AND LEN(code_machine) > 3
      AND datex >= @p1 AND datex < @p2
      AND (date_close IS NULL OR UPPER(ISNULL([cause],'')) IN ('CANCEL', 'N/A'))`;

  const [ev, open] = await Promise.all([evReq.query<ShiftEventRow>(evSql), opReq.query<OpenJobRow>(opSql)]);
  return { events: ev.recordset, openJobs: open.recordset };
}

interface TechStat {
  closed: Set<string>;
  open: Set<string>;
  down: Set<string>;
  setup: Set<string>;
  openDown: Set<string>;
  openSetup: Set<string>;
  downTimes: number[];
  setupTimes: number[];
}

export interface ShiftMetrics {
  avg_util: number;
  down_pct: number;
  wait_pct: number;
  setup_conv_pct: number;
  idle_pct: number;
  total_request_jobs: number;
  request_down_jobs: number;
  request_setup_jobs: number;
  total_closed_jobs: number;
  tech_count: number;
  avg_job_per_tech: number;
  down_jobs: number;
  avg_down_time: number;
  setup_jobs: number;
  avg_setup_time: number;
  avg_waiting_time: number;
  max_waiting_time: number;
}

/** Shift metrics for one window — port of compute_shift_metrics_with_details. */
export function computeShiftMetrics(events: ShiftEventRow[], openJobs: OpenJobRow[], packages: string): ShiftMetrics {
  const pkgList = packages.split(',').map(p => p.trim()).filter(Boolean);
  const hasAll  = pkgList.length === 0 || pkgList.includes('__ALL__');
  const hasLead = pkgList.includes('__LEAD__');
  const hasQfn  = pkgList.includes('__QFN__');
  const pkgSet  = new Set(pkgList.filter(p => !p.startsWith('__')));

  // Last-known package per machine (rows with a package, later rows win).
  const machinePkg = new Map<string, string>();
  for (const r of events) {
    const pkg = r.package_type?.trim();
    if (pkg) machinePkg.set(r.code_machine, pkg);
  }
  const allMachines = [...new Set(events.map(r => r.code_machine))].sort();
  const isFn = (m: string) => machinePkg.get(m)!.toUpperCase().includes('FN');
  const target: string[] = hasAll
    ? [...machinePkg.keys()].sort()
    : hasLead ? allMachines.filter(m => machinePkg.has(m) && !isFn(m))
    : hasQfn  ? allMachines.filter(m => machinePkg.has(m) && isFn(m))
    : allMachines.filter(m => pkgSet.has(machinePkg.get(m) ?? ''));

  const closedBy = new Map<string, ShiftEventRow[]>();
  for (const r of events) {
    if (r.job_type == null) continue; // key machine with no closed event
    const arr = closedBy.get(r.code_machine);
    if (arr) arr.push(r); else closedBy.set(r.code_machine, [r]);
  }
  const openBy = new Map<string, OpenJobRow[]>();
  for (const r of openJobs) {
    const arr = openBy.get(r.code_machine);
    if (arr) arr.push(r); else openBy.set(r.code_machine, [r]);
  }

  // Only technicians whose name starts with "B" are counted (Rust: tech.starts_with('B')).
  const techs = new Map<string, TechStat>();
  const techOf = (name: string): TechStat => {
    let t = techs.get(name);
    if (!t) {
      t = { closed: new Set(), open: new Set(), down: new Set(), setup: new Set(),
            openDown: new Set(), openSetup: new Set(), downTimes: [], setupTimes: [] };
      techs.set(name, t);
    }
    return t;
  };
  const countable = (name: string | null): name is string => !!name && name.startsWith('B');

  const waitAll: number[] = [];
  let totUtil = 0, totDown = 0, totWait = 0, totSetupConv = 0, totIdle = 0;

  for (const mid of target) {
    let waitDown = 0, downMin = 0, waitSetup = 0, setupMin = 0, setupConvMin = 0, sboMin = 0;

    for (const r of closedBy.get(mid) ?? []) {
      const jt = (r.job_type ?? '').toUpperCase();
      const wt = Number(r.wait_min ?? 0);
      const repair = repairMinutes(r, wt);
      waitAll.push(wt);

      if (jt === 'M/C DOWN') {
        waitDown += wt;
        downMin  += repair;
        if (countable(r.tech_name)) {
          const t = techOf(r.tech_name);
          const id = `DOWN:${r.datex?.getTime() ?? 'null'}`;
          t.downTimes.push(repair);
          t.down.add(id);
          t.closed.add(id);
        }
      } else if (LOST_TYPES.has(jt)) {
        waitSetup += wt;
        setupMin  += repair;
        if (jt === 'SETUP BY OPERATOR') sboMin += repair;
        if (SETUP_CONV.has(jt)) setupConvMin += repair;
        if (countable(r.tech_name) && SETUP_CONV.has(jt)) {
          const t = techOf(r.tech_name);
          const id = `SETUP:${r.datex?.getTime() ?? 'null'}`;
          t.setupTimes.push(repair);
          t.setup.add(id);
          t.closed.add(id);
        }
      }
    }

    for (const r of openBy.get(mid) ?? []) {
      const jt  = (r.job_type ?? '').toUpperCase();
      const dur = Number(r.dur_min ?? 0);
      if (jt === 'M/C DOWN') {
        waitDown += dur;
        if (countable(r.tech_name)) {
          const t = techOf(r.tech_name);
          const id = `${mid}:${r.t_start}:${r.des_job ?? ''}`;
          t.open.add(id);
          t.openDown.add(id);
        }
      } else if (LOST_TYPES.has(jt)) {
        waitSetup += dur;
        if (countable(r.tech_name) && SETUP_CONV.has(jt)) {
          const t = techOf(r.tech_name);
          const id = `${mid}:${r.t_start}:${r.des_job ?? ''}`;
          t.open.add(id);
          t.openSetup.add(id);
        }
      }
    }

    const totalLoss = waitDown + downMin + waitSetup + setupMin;
    totUtil      += r1(Math.min(100, Math.max(0, (SHIFT_MIN - totalLoss) / SHIFT_MIN * 100)));
    totDown      += downMin / SHIFT_MIN * 100;          // repair time only
    totWait      += (waitDown + waitSetup) / SHIFT_MIN * 100;
    totSetupConv += setupConvMin / SHIFT_MIN * 100;
    totIdle      += sboMin / SHIFT_MIN * 100;
  }

  const all = [...techs.values()];
  const sumOf = (f: (t: TechStat) => number) => all.reduce((s, t) => s + f(t), 0);
  const totalClosed = sumOf(t => t.closed.size);
  const totalOpen   = sumOf(t => t.open.size);
  const techCount   = all.length;
  const allDown     = all.flatMap(t => t.downTimes);
  const allSetup    = all.flatMap(t => t.setupTimes);
  const withWait    = waitAll.filter(w => w > 0);
  const n = target.length;

  return {
    avg_util:           n > 0 ? r1(totUtil / n) : 0,
    down_pct:           n > 0 ? r1(totDown / n) : 0,
    wait_pct:           n > 0 ? r1(totWait / n) : 0,
    setup_conv_pct:     n > 0 ? r1(totSetupConv / n) : 0,
    idle_pct:           n > 0 ? r1(totIdle / n) : 0,
    total_request_jobs: totalClosed + totalOpen,
    request_down_jobs:  sumOf(t => t.down.size + t.openDown.size),
    request_setup_jobs: sumOf(t => t.setup.size + t.openSetup.size),
    total_closed_jobs:  totalClosed,
    tech_count:         techCount,
    avg_job_per_tech:   techCount > 0 ? r1(totalClosed / techCount) : 0,
    down_jobs:          sumOf(t => t.down.size),
    avg_down_time:      r1(mean(allDown)),
    setup_jobs:         sumOf(t => t.setup.size),
    avg_setup_time:     r1(mean(allSetup)),
    avg_waiting_time:   r1(mean(withWait)),
    max_waiting_time:   waitAll.length ? Math.max(...waitAll) : 0,
  };
}

/**
 * 14-shift trend ending at `endDate`: 7 days, each with Night then Day, oldest first.
 * Returns the same shape as the Rust report_7day (dates, shifts, shift_details, metrics).
 */
export async function shiftTrend7day(op: Op, endDate: string, packages: string) {
  const [y, m, d] = endDate.split('-').map(Number);
  const end = new Date(y, m - 1, d);

  const dates: string[] = [];
  const shifts: string[] = [];
  const shiftDetails: Record<string, unknown>[] = [];
  const metrics = { avg_util: [] as number[], down_pct: [] as number[], wait_pct: [] as number[],
                    setup_conv_pct: [] as number[], idle_pct: [] as number[] };

  for (let offset = 6; offset >= 0; offset--) {
    const day = fmtDate(new Date(end.getFullYear(), end.getMonth(), end.getDate() - offset));
    for (const shift of ['Night', 'Day'] as const) {
      const [start, stop] = shiftWindow(day, shift);
      const { events, openJobs } = await fetchShiftRows(op, start, stop, day);
      const s = computeShiftMetrics(events, openJobs, packages);

      dates.push(day);
      shifts.push(shift);
      metrics.avg_util.push(s.avg_util);
      metrics.down_pct.push(s.down_pct);
      metrics.wait_pct.push(s.wait_pct);
      metrics.setup_conv_pct.push(s.setup_conv_pct);
      metrics.idle_pct.push(s.idle_pct);
      shiftDetails.push({
        date: day,
        shift,
        total_request_jobs: s.total_request_jobs,
        request_down_jobs:  s.request_down_jobs,
        request_setup_jobs: s.request_setup_jobs,
        total_closed_jobs:  s.total_closed_jobs,
        tech_count:         s.tech_count,
        avg_job_per_tech:   s.avg_job_per_tech,
        down_jobs:          s.down_jobs,
        avg_down_time:      s.avg_down_time,
        setup_jobs:         s.setup_jobs,
        avg_setup_time:     s.avg_setup_time,
        avg_waiting_time:   s.avg_waiting_time,
        max_waiting_time:   s.max_waiting_time,
      });
    }
  }

  return { dates, shifts, shift_details: shiftDetails, metrics };
}
