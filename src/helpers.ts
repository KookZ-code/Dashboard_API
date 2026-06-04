import sql from 'mssql';
import { pool } from './db.js';
import { config } from './config.js';
import type { FastifyRequest, FastifyReply } from 'fastify';

export const C = {
  MID:   'code_machine',
  AREA:  'id_operation',
  JT:    'job_type',
  CAUSE: 'cause',
  SYM:   'des_job',
  OPR:   'datex',
  TECH:  'date_ack',
  END:   'date_close',
} as const;

export const DOWN_TYPES  = new Set(['M/C DOWN']);
export const PM_TYPES    = new Set(['PM']);
export const LOST_TYPES  = new Set([
  'SETUP', 'SETUP BY OPERATOR', 'CONVERT', 'CLEAN MOLD',
  'CHANGE CAP', 'FACILITY DOWN', 'ENGINEERING DOWN',
]);

export type SqlParam = { name: string; type: sql.ISqlType | (() => sql.ISqlType); value: unknown };

export const r2 = (v: number) => Math.round(v * 100) / 100;
export const r1 = (v: number) => Math.round(v * 10) / 10;

export function parseAreas(areas?: string | null): string[] | null {
  if (!areas) return null;
  const a = areas.split(',').map(s => s.trim()).filter(Boolean);
  return a.length ? a : null;
}

export function buildWhere(opts: {
  start?: string; end?: string; areas?: string | null;
  shift?: string; machineId?: string;
}): { where: string; params: SqlParam[] } {
  const { start, end, areas, shift, machineId } = opts;
  const areaList = parseAreas(areas);
  const clauses: string[] = [
    `[${C.TECH}] IS NOT NULL`,
    `[${C.END}] > [${C.TECH}]`,
    `[${C.AREA}] IS NOT NULL AND [${C.AREA}] != ''`,
  ];
  const params: SqlParam[] = [];

  if (start) {
    clauses.push(`[${C.OPR}] >= @start_date`);
    params.push({ name: 'start_date', type: sql.VarChar, value: start });
  }
  if (end) {
    clauses.push(`[${C.OPR}] < DATEADD(DAY, 1, CAST(@end_date AS DATE))`);
    params.push({ name: 'end_date', type: sql.VarChar, value: end });
  }
  if (areaList?.length) {
    const phs = areaList.map((_, i) => `@area_${i}`).join(', ');
    clauses.push(`[${C.AREA}] IN (${phs})`);
    areaList.forEach((a, i) => params.push({ name: `area_${i}`, type: sql.VarChar, value: a }));
  }
  const su = shift?.toUpperCase();
  if (su === 'DAY')   clauses.push(`DATEPART(HOUR, [${C.OPR}]) BETWEEN 7 AND 18`);
  if (su === 'NIGHT') clauses.push(`DATEPART(HOUR, [${C.OPR}]) NOT BETWEEN 7 AND 18`);
  if (machineId) {
    clauses.push(`RTRIM(LTRIM([${C.MID}])) = @machine_id`);
    params.push({ name: 'machine_id', type: sql.VarChar, value: machineId });
  }
  return { where: 'WHERE ' + clauses.join(' AND '), params };
}

export function buildTechWhere(opts: {
  start?: string; end?: string; areaList?: string[] | null;
  shift?: string; jobType?: string;
}): { where: string; params: SqlParam[] } {
  const { start, end, areaList, shift, jobType } = opts;
  const clauses = [
    '[date_close] IS NOT NULL', '[date_ack] IS NOT NULL', '[date_close] > [date_ack]',
    "ISNULL(by_perform, by_ack) IS NOT NULL", "ISNULL(by_perform, by_ack) != ''",
  ];
  const params: SqlParam[] = [];
  if (start) { clauses.push('[datex] >= @start_date'); params.push({ name: 'start_date', type: sql.VarChar, value: start }); }
  if (end)   { clauses.push('[datex] < DATEADD(DAY, 1, CAST(@end_date AS DATE))'); params.push({ name: 'end_date', type: sql.VarChar, value: end }); }
  if (areaList?.length) {
    const phs = areaList.map((_, i) => `@area_${i}`).join(', ');
    clauses.push(`[id_operation] IN (${phs})`);
    areaList.forEach((a, i) => params.push({ name: `area_${i}`, type: sql.VarChar, value: a }));
  }
  const su = shift?.toUpperCase();
  if (su === 'DAY')   clauses.push('DATEPART(HOUR, [datex]) BETWEEN 7 AND 18');
  if (su === 'NIGHT') clauses.push('DATEPART(HOUR, [datex]) NOT BETWEEN 7 AND 18');
  if (jobType) { clauses.push('[job_type] = @job_type'); params.push({ name: 'job_type', type: sql.VarChar, value: jobType }); }
  return { where: 'WHERE ' + clauses.join(' AND '), params };
}

export function makeReq(params: SqlParam[]): sql.Request {
  const req = pool.request();
  for (const p of params) req.input(p.name, p.type as sql.ISqlType, p.value);
  return req;
}

export function nDays(start?: string, end?: string): number {
  if (!start || !end) return 30;
  try { return Math.max(1, Math.round((new Date(end).getTime() - new Date(start).getTime()) / 86_400_000) + 1); }
  catch { return 30; }
}

type KpiRow = { job_type: string; total_min: number; wait_min: number };

export function computeKpis(rows: KpiRow[], mcCount: number, nDaysVal: number, shift?: string) {
  const h = shift && ['DAY', 'NIGHT'].includes(shift.toUpperCase()) ? 12 : 24;
  const avail = (mcCount * nDaysVal * h * 60) || 1;
  let dn = 0, pm = 0, ls = 0, wt = 0;
  for (const r of rows) {
    const tot = Number(r.total_min) || 0, w = Number(r.wait_min) || 0;
    if (DOWN_TYPES.has(r.job_type))      dn += tot;
    else if (PM_TYPES.has(r.job_type))   pm += tot;
    else if (LOST_TYPES.has(r.job_type)) ls += tot;
    wt += w;
  }
  ls += wt;
  const dp = r2(dn / avail * 100), pp = r2(pm / avail * 100), lp = r2(ls / avail * 100);
  return { utilization_pct: r2(Math.max(0, 100 - dp - pp - lp)), downtime_pct: dp, pm_pct: pp, lost_time_pct: lp };
}

type AreaRow = { area: string; job_type: string; total_min: number; wait_min: number };
type McRow   = { area: string; machine_count: number };

export function areaUtil(areaRows: AreaRow[], mcCntRows: McRow[], nDaysVal: number, shift?: string) {
  const h = shift && ['DAY', 'NIGHT'].includes(shift.toUpperCase()) ? 12 : 24;
  const mcMap = new Map(mcCntRows.map(r => [String(r.area), Number(r.machine_count)]));
  const grouped = new Map<string, AreaRow[]>();
  for (const r of areaRows) { const g = grouped.get(String(r.area)) ?? []; g.push(r); grouped.set(String(r.area), g); }
  const result: { area: string; utilization_pct: number; target_pct: number }[] = [];
  for (const [area, rows] of grouped) {
    const avail = Math.max(1, mcMap.get(area) ?? 1) * nDaysVal * h * 60;
    let dn = 0, pm = 0, ls = 0, wt = 0;
    for (const r of rows) {
      const tot = Number(r.total_min) || 0, w = Number(r.wait_min) || 0;
      if (DOWN_TYPES.has(r.job_type))      dn += tot;
      else if (PM_TYPES.has(r.job_type))   pm += tot;
      else if (LOST_TYPES.has(r.job_type)) ls += tot;
      wt += w;
    }
    ls += wt;
    result.push({ area, utilization_pct: r2(Math.max(0, 100 - (dn + pm + ls) / avail * 100)), target_pct: 85 });
  }
  return result.sort((a, b) => a.area.localeCompare(b.area));
}

type MonthlyRow = { ym: string; job_type: string; total_min: number; wait_min: number };

export function monthlyTrend(rows: MonthlyRow[], mcCount: number, shift?: string) {
  const h = shift && ['DAY', 'NIGHT'].includes(shift.toUpperCase()) ? 12 : 24;
  const grouped = new Map<string, MonthlyRow[]>();
  for (const r of rows) { const g = grouped.get(r.ym) ?? []; g.push(r); grouped.set(r.ym, g); }
  const result = [];
  for (const [ym, grp] of grouped) {
    let days = 30;
    try { const yr = parseInt(ym.slice(0, 4)), mo = parseInt(ym.slice(5, 7)); days = new Date(yr, mo, 0).getDate(); } catch { /**/ }
    const avail = mcCount * days * h * 60;
    let dn = 0, pm = 0, ls = 0, wt = 0;
    for (const r of grp) {
      const tot = Number(r.total_min) || 0, w = Number(r.wait_min) || 0;
      if (DOWN_TYPES.has(r.job_type))      dn += tot;
      else if (PM_TYPES.has(r.job_type))   pm += tot;
      else if (LOST_TYPES.has(r.job_type)) ls += tot;
      wt += w;
    }
    ls += wt;
    result.push({ month: ym, running_min: Math.max(0, avail - dn - pm - ls), down_min: dn, pm_min: pm, lost_min: ls });
  }
  return result.sort((a, b) => a.month.localeCompare(b.month));
}

export async function authPreHandler(req: FastifyRequest, reply: FastifyReply) {
  if (config.api.key && req.headers['x-api-key'] !== config.api.key) {
    await reply.code(401).send({ status: 'error', error: { code: 401, message: 'Invalid API key' } });
  }
}
