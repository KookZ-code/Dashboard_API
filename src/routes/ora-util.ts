// Utilities for merging Oracle (ISO/FS) data with MSSQL results
// Call these when areas include ISO/FS

import { oracleCache, OracleRow, OracleLiveRow } from '../db-oracle.js';

export function hasOracleAreas(areas: string[] | null): boolean {
  if (!areas) return false;
  return areas.some(a => a === 'ISO' || a === 'FS');
}

export function splitAreas(areas: string[] | null): {
  mssql: string[] | null;
  oracle: string[] | null;
} {
  if (!areas) return { mssql: null, oracle: null };

  const mssqlAreas = areas.filter(a => a !== 'ISO' && a !== 'FS');
  const oracleAreas = areas.filter(a => a === 'ISO' || a === 'FS');

  return {
    mssql: mssqlAreas.length > 0 ? mssqlAreas : null,
    oracle: oracleAreas.length > 0 ? oracleAreas : null,
  };
}

// Convert Oracle row to MSSQL-like format for aggregation
export function oracleRowToMssqlFormat(r: OracleRow, viewName: string = 'Oracle') {
  return {
    code_machine: r.machine_id,
    id_operation: r.area,
    job_type: r.job_type,
    datex: r.datex,
    date_ack: r.date_ack,
    date_close: r.date_close,
    cause: r.cause,
    des_job: r.symptom,
    Waiting_time: r.wait_min,
    // Calculated fields
    repair_min: Math.round((r.date_close && r.date_ack)
      ? (r.date_close.getTime() - r.date_ack.getTime()) / 60000
      : r.repair_min),
  };
}

// Convert Oracle live row to open-jobs format
export function oracleLiveRowToOpenJob(r: OracleLiveRow) {
  const now = new Date();
  const dateAck = r.status === 'Waiting' ? null : r.date_close ? new Date(0) : null; // rough approx
  const waitMin = now.getTime() - (r.date_close?.getTime() ?? now.getTime());

  return {
    code_machine: r.machine_id,
    area: r.area,
    job_type: r.job_type,
    des_job: r.des_job,
    datex: new Date(), // placeholder — Oracle doesn't give us exact start
    date_ack: dateAck,
    tech: r.badge,
    wait_min: Math.max(0, r.wait_min),
    repair_min: r.repair_min,
    status: r.status,
    die_mask: r.die_mask,
    package_type: r.package_type,
    wire_type: null,
  };
}

// Get Oracle rows filtered by date/shift
export function getOracleHistorical(
  areas: string[] | null,
  start: string | null,
  end: string | null,
  shift: string | null,
): OracleRow[] {
  if (!oracleCache.enabled) return [];

  const oracleAreas = areas ? areas.filter(a => a === 'ISO' || a === 'FS') : null;
  if (!oracleAreas || oracleAreas.length === 0) return [];

  return oracleCache.filterHistorical(oracleAreas, start, end, shift);
}

// Get Oracle live rows
export function getOracleLive(areas: string[] | null): OracleLiveRow[] {
  if (!oracleCache.enabled) return [];

  const oracleAreas = areas ? areas.filter(a => a === 'ISO' || a === 'FS') : null;
  if (!oracleAreas || oracleAreas.length === 0) return [];

  return oracleCache.liveFiltered(oracleAreas);
}
