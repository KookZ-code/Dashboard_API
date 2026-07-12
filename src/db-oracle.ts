// Oracle cache for ISO/FS data (in-memory with background refresh)
// Port of Rust oracle::OracleCache — loads historical + live views, filters in-memory

import oracledb from 'oracledb';
import { config } from './config.js';

export interface OracleRow {
  machine_id: string;
  datex: Date | null;
  date_ack: Date | null;
  date_close: Date | null;
  job_type: string;
  cause: string;
  symptom: string;
  repair_min: number;
  wait_min: number;
  badge: string;
  package_type: string;
  lot_no: string;
  die_mask: string;
  action: string;
  area: string;
  shift_code: string;
}

export interface OracleLiveRow {
  machine_id: string;
  area: string;
  job_type: string;
  des_job: string;
  status: string;
  date_close: Date | null;
  wait_min: number;
  repair_min: number;
  badge: string;
  package_type: string;
  lot_no: string;
  die_mask: string;
}

function areaFromEquipmentType(et: string): string | null {
  if (et === 'ISOLATE') return 'ISO';
  if (et === 'FORM_SING') return 'FS';
  return null;
}

function sget(val: any): string {
  return val ? String(val).trim() : '';
}

export class OracleCache {
  enabled: boolean;
  private user: string;
  private password: string;
  private dsn: string;
  private view: string;
  private liveView: string;
  private hist: OracleRow[] = [];
  private live: OracleLiveRow[] = [];
  private pool: oracledb.Pool | null = null;

  constructor() {
    this.enabled = config.ora_enabled;
    this.user = config.ora_user;
    this.password = config.ora_password;
    this.dsn = config.ora_dsn;
    this.view = config.ora_view;
    this.liveView = config.ora_live_view;
  }

  async initialize(): Promise<void> {
    if (!this.enabled) return;

    try {
      if (config.ora_client_lib) {
        oracledb.initOracleClient({ libDir: config.ora_client_lib });
      }

      this.pool = await oracledb.createPool({
        user: this.user,
        password: this.password,
        connectString: this.dsn,
        poolMin: 1,
        poolMax: 3,
        poolIncrement: 1,
      });

      console.log('[Oracle] Pool created successfully');

      // Initial load + spawn refresh tasks
      await this.refreshHistorical();
      await this.refreshLive();

      setInterval(() => this.refreshHistorical().catch(e => console.error('[Oracle] Historical refresh failed:', e)), 600_000);
      setInterval(() => this.refreshLive().catch(e => console.error('[Oracle] Live refresh failed:', e)), 300_000);
    } catch (err) {
      console.error('[Oracle] Initialization failed:', err);
      this.enabled = false;
    }
  }

  private async connect(): Promise<oracledb.Connection> {
    if (!this.pool) throw new Error('Oracle pool not initialized');
    return this.pool.getConnection();
  }

  async refreshHistorical(): Promise<void> {
    if (!this.enabled) return;

    try {
      const conn = await this.connect();
      try {
        const sql = `
          SELECT EQUIPMENT_TYPE, EQUIPMENT_ID, S_DATE, P_START, P_STOP, JOB_TYPE, CAUSE,
                 CRITERIA, DOWNTIME, WAIT_TECH, BADGE_NO, SHIFT, PKG, LOT_ID, PRODUCT_ID,
                 TECHNICIAN_COMMENT
          FROM ${this.view}
          WHERE P_START IS NOT NULL AND P_STOP IS NOT NULL AND P_STOP > P_START
        `;

        const result = await conn.execute<any[]>(sql, [], { outFormat: oracledb.OUT_FORMAT_OBJECT });
        const rows = result.rows || [];

        const out: OracleRow[] = [];
        for (const r of rows) {
          const et = sget(r.EQUIPMENT_TYPE);
          const area = areaFromEquipmentType(et);
          if (!area) continue;

          out.push({
            machine_id: sget(r.EQUIPMENT_ID),
            datex: r.S_DATE instanceof Date ? r.S_DATE : null,
            date_ack: r.P_START instanceof Date ? r.P_START : null,
            date_close: r.P_STOP instanceof Date ? r.P_STOP : null,
            job_type: sget(r.JOB_TYPE),
            cause: sget(r.CAUSE),
            symptom: sget(r.CRITERIA),
            repair_min: Number(r.DOWNTIME ?? 0),
            wait_min: Number(r.WAIT_TECH ?? 0),
            badge: sget(r.BADGE_NO),
            package_type: sget(r.PKG),
            lot_no: sget(r.LOT_ID),
            die_mask: sget(r.PRODUCT_ID),
            action: sget(r.TECHNICIAN_COMMENT),
            area,
            shift_code: sget(r.SHIFT),
          });
        }

        this.hist = out;
        console.log(`[Oracle] Historical loaded: ${out.length} rows`);
      } finally {
        await conn.close();
      }
    } catch (err) {
      console.error('[Oracle] Historical refresh failed:', err);
    }
  }

  async refreshLive(): Promise<void> {
    if (!this.enabled) return;

    try {
      const conn = await this.connect();
      try {
        const sql = `
          SELECT EQUIPMENT_TYPE, EQUIPMENT_ID, CAUSE, CRITERIA, P_START, P_STOP, STATUS,
                 BADGE_NO, NAME, NVL(WAIT_TECH,0), NVL(DOWNTIME,0), S_DATE, PKG, LOT_ID,
                 PRODUCT_ID, TECHNICIAN_COMMENT
          FROM ${this.liveView}
          WHERE EQUIPMENT_TYPE IN ('ISOLATE','FORM_SING') AND S_DATE >= TRUNC(SYSDATE) - 1
          ORDER BY P_START DESC
        `;

        const result = await conn.execute<any[]>(sql, [], { outFormat: oracledb.OUT_FORMAT_OBJECT });
        const rows = result.rows || [];

        const SETUP_KW = ['SETUP', 'SET UP', 'SET D/V', 'CHANGE'];
        const PM_KW = ['PM', 'PREVENTIVE'];

        const out: OracleLiveRow[] = [];
        for (const r of rows) {
          const et = sget(r.EQUIPMENT_TYPE);
          const area = areaFromEquipmentType(et);
          if (!area) continue;

          const cause = sget(r.CAUSE);
          const criteria = sget(r.CRITERIA);
          const pStart = r.P_START instanceof Date ? r.P_START : null;
          const pStop = r.P_STOP instanceof Date ? r.P_STOP : null;
          const statusRaw = sget(r.STATUS);

          const cu = criteria.toUpperCase();
          const ca = cause.toUpperCase();
          const jobType = SETUP_KW.some(k => cu.includes(k))
            ? 'SETUP'
            : PM_KW.some(k => ca.includes(k))
            ? 'PM'
            : 'M/C DOWN';

          let status = statusRaw === 'Working' || statusRaw === 'Waiting Approval'
            ? 'On Process'
            : statusRaw === 'Completed'
            ? 'Closed'
            : 'Waiting';
          if (!pStop && pStart) {
            status = 'On Process';
          }

          out.push({
            machine_id: sget(r.EQUIPMENT_ID),
            area,
            job_type: jobType,
            des_job: criteria,
            status,
            date_close: pStop,
            wait_min: Number(r[10] ?? 0),
            repair_min: Number(r[11] ?? 0),
            badge: sget(r.BADGE_NO),
            package_type: sget(r.PKG),
            lot_no: sget(r.LOT_ID),
            die_mask: sget(r.PRODUCT_ID),
          });
        }

        this.live = out;
        console.log(`[Oracle] Live loaded: ${out.length} rows`);
      } finally {
        await conn.close();
      }
    } catch (err) {
      console.error('[Oracle] Live refresh failed:', err);
    }
  }

  filterHistorical(
    areas: string[] | null,
    start: string | null,
    end: string | null,
    shift: string | null,
  ): OracleRow[] {
    const want = areas
      ? areas.filter(a => a === 'ISO' || a === 'FS')
      : null;

    if (want && want.length === 0) return [];

    const startD = start ? new Date(start) : null;
    const endD = end ? new Date(end) : null;
    if (endD) endD.setDate(endD.getDate() + 1); // exclusive +1 day

    const shiftCode = shift ? (shift.toUpperCase() === 'D' || shift.toUpperCase() === 'DAY' ? 'D' : shift.toUpperCase() === 'N' || shift.toUpperCase() === 'NIGHT' ? 'N' : null) : null;

    return this.hist.filter(r => {
      if (want && !want.includes(r.area)) return false;
      if (startD && r.datex && r.datex.getTime() < startD.getTime()) return false;
      if (endD && r.datex && r.datex.getTime() >= endD.getTime()) return false;
      if (shiftCode && r.shift_code !== shiftCode) return false;
      return true;
    });
  }

  liveFiltered(areas: string[] | null): OracleLiveRow[] {
    const want = areas
      ? areas.filter(a => a === 'ISO' || a === 'FS')
      : null;

    if (want && want.length === 0) return [];

    return this.live.filter(r => {
      if (want && !want.includes(r.area)) return false;
      return true;
    });
  }

  async closePool(): Promise<void> {
    if (this.pool) {
      await this.pool.close();
    }
  }
}

// Singleton instance
export let oracleCache = new OracleCache();
