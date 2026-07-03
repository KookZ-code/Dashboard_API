// WB-UPH endpoints — SQLite central.db (hourly bond-unit scan records).
// Port of Dashboad_API_rush wb_uph_repo.rs.
// central.db path set via CENTRAL_DB_PATH env var (local or network share path).

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { config } from '../config.js';
import { getSqliteDb } from '../db-sqlite.js';

// ── Shift window ────────────────────────────────────────────────────────────

interface ShiftWin { start: string; end: string; hours: number[] }

function prevDay(date: string): string {
  const [y, m, d] = date.split('-').map(Number);
  const p = new Date(y, m - 1, d - 1);
  return `${p.getFullYear()}-${String(p.getMonth()+1).padStart(2,'0')}-${String(p.getDate()).padStart(2,'0')}`;
}

function shiftWindow(date: string, shift: string): ShiftWin {
  if (shift === 'D') return { start: `${date} 07:00:00`, end: `${date} 18:59:59`, hours: Array.from({length:12},(_,i)=>7+i) };
  return { start: `${prevDay(date)} 19:00:00`, end: `${date} 06:59:59`, hours: [19,20,21,22,23,0,1,2,3,4,5,6] };
}

function resolveShift(date?: string, shift?: string): [string, string] {
  const now = new Date(); const h = now.getHours();
  let cd: string, cs: string;
  if (h >= 7 && h < 19) { cd = now.toISOString().slice(0,10); cs = 'D'; }
  else if (h >= 19) { const n = new Date(now.getTime()+86_400_000); cd = n.toISOString().slice(0,10); cs = 'N'; }
  else { cd = now.toISOString().slice(0,10); cs = 'N'; }
  return [/^\d{4}-\d{2}-\d{2}$/.test(date??'') ? date! : cd, shift==='D'||shift==='N' ? shift : cs];
}

function slotEndForHour(w: ShiftWin, hour: number): string {
  const d = hour <= 6 ? w.end.slice(0,10) : w.start.slice(0,10);
  const s = `${d} ${String(hour).padStart(2,'0')}:59:59`;
  return s < w.end ? s : w.end;
}

function parseTsSecs(ts: string): number {
  return Math.floor(new Date(ts.replace(' ','T')+'+07:00').getTime()/1000);
}

// ── pkg_key SQL expression ─────────────────────────────────────────────────
const PKG = "COALESCE(package_mpc, CASE WHEN mpc IS NOT NULL AND LENGTH(mpc)>=9 THEN package||'('||SUBSTR(mpc,7,3)||')' ELSE package END)";

function buildPkgClause(f: string[]): string {
  if (!f.length) return '';
  const l = f.map(p=>`'${p.replace(/'/g,"''")}'`).join(',');
  return `AND (package IN (${l}) OR ${PKG} IN (${l}))`;
}

// ── Reset-aware delta (mirrors delta.ts) ───────────────────────────────────

function resetAwareTotal(baseline: number, values: number[]): number {
  let t=0, prev=baseline;
  for (const v of values) { t += v>=prev ? v-prev : v; prev=v; }
  return t;
}

function carryoverBaseline(startSecs: number, firstTs: string, firstBonded: number, firstUph: number): number {
  const elapsed = (parseTsSecs(firstTs) - startSecs) / 3600;
  return (elapsed > 0 && firstUph > 0 && firstBonded / elapsed > firstUph * 2) ? firstBonded : 0;
}

function loadPreBaselines(db: NonNullable<ReturnType<typeof getSqliteDb>>, start: string): Map<string, number> {
  const rows = db.prepare(
    `SELECT machine_id, lot_id, bonded_unit FROM uph_records
     WHERE voided=0 AND created_at < ? ORDER BY machine_id, lot_id, created_at DESC`
  ).all(start) as Array<{machine_id:string; lot_id:string; bonded_unit:number}>;
  const m = new Map<string,number>();
  for (const r of rows) { const k=`${r.machine_id}\0${r.lot_id}`; if(!m.has(k)) m.set(k,r.bonded_unit); }
  return m;
}

// ── Helpers ────────────────────────────────────────────────────────────────

async function authCheck(req: FastifyRequest, reply: FastifyReply) {
  if (config.api.key && req.headers['x-api-key'] !== config.api.key)
    await reply.code(401).send({ status:'error', error:{code:401, message:'Invalid API key'} });
}
const unavail = (reply: FastifyReply, msg?: string) =>
  reply.code(503).send({ status:'unavailable', message: msg ?? 'CENTRAL_DB_PATH not configured or central.db not accessible' });

// ── Routes ─────────────────────────────────────────────────────────────────

export default async function wbUphRoutes(app: FastifyInstance): Promise<void> {

  // 1. Summary
  app.get<{Querystring:{date?:string; shift?:string; packages?:string}}>(
    '/api/v1/wb-uph/summary', {preHandler:authCheck}, async (req, reply) => {
      const db = getSqliteDb(); if (!db) return unavail(reply);
      try {
        const [date, shift] = resolveShift(req.query.date, req.query.shift);
        const pkgFilter = (req.query.packages??'').split(',').map(s=>s.trim()).filter(Boolean);
        const w = shiftWindow(date, shift);
        const pre = loadPreBaselines(db, w.start);
        const rows = db.prepare(
          `SELECT machine_id, lot_id, bonded_unit, created_at, uph, COALESCE(badge_no,'') AS badge_no
           FROM uph_records WHERE voided=0 AND created_at >= ? AND created_at <= ? ${buildPkgClause(pkgFilter)}
           ORDER BY created_at`
        ).all(w.start, w.end) as Array<{machine_id:string; lot_id:string; bonded_unit:number; created_at:string; uph:number; badge_no:string}>;

        const startSecs = parseTsSecs(w.start);
        type G = {machine:string; bonded:number[]; firstTs:string; firstBonded:number; firstUph:number};
        const groups = new Map<string,G>(); const ops = new Set<string>();
        for (const r of rows) {
          if (r.badge_no) ops.add(r.badge_no);
          const k=`${r.machine_id}\0${r.lot_id}`; const g=groups.get(k);
          if (g) g.bonded.push(r.bonded_unit);
          else groups.set(k,{machine:r.machine_id, bonded:[r.bonded_unit], firstTs:r.created_at, firstBonded:r.bonded_unit, firstUph:r.uph});
        }
        let total=0; const machines=new Set<string>();
        for (const [k,g] of groups) {
          const [mc,lot]=k.split('\0');
          const base = pre.has(`${mc}\0${lot}`) ? pre.get(`${mc}\0${lot}`)! : carryoverBaseline(startSecs,g.firstTs,g.firstBonded,g.firstUph);
          total += resetAwareTotal(base, g.bonded); machines.add(g.machine);
        }
        return reply.send({status:'ok', data:{total_bonded:total, active_machines:machines.size, active_operators:ops.size}});
      } catch (err) { return unavail(reply, err instanceof Error ? err.message : String(err)); }
    }
  );

  // 2. Hourly
  app.get<{Querystring:{date?:string; shift?:string; packages?:string}}>(
    '/api/v1/wb-uph/hourly', {preHandler:authCheck}, async (req, reply) => {
      const db = getSqliteDb(); if (!db) return unavail(reply);
      try {
        const [date, shift] = resolveShift(req.query.date, req.query.shift);
        const pkgFilter = (req.query.packages??'').split(',').map(s=>s.trim()).filter(Boolean);
        const w = shiftWindow(date, shift);
        const pre = loadPreBaselines(db, w.start);
        const rows = db.prepare(
          `SELECT ${PKG} AS pkg_key, machine_id, lot_id, bonded_unit, created_at, uph
           FROM uph_records WHERE voided=0 AND created_at >= ? AND created_at <= ? ${buildPkgClause(pkgFilter)}
           ORDER BY created_at`
        ).all(w.start, w.end) as Array<{pkg_key:string; machine_id:string; lot_id:string; bonded_unit:number; created_at:string; uph:number}>;

        const n=w.hours.length; const startSecs=parseTsSecs(w.start);
        type S={pkg:string; machine:string; lot:string; ts:string[]; bonded:number[]; firstTs:string; firstBonded:number; firstUph:number};
        const series=new Map<string,S>(); const first=new Map<string,{b:number;ts:string;u:number}>();
        for (const r of rows) {
          const k=`${r.pkg_key.trim()}\0${r.machine_id}\0${r.lot_id}`;
          if(!first.has(k)) first.set(k,{b:r.bonded_unit,ts:r.created_at,u:r.uph});
          const s=series.get(k);
          if(s){s.ts.push(r.created_at);s.bonded.push(r.bonded_unit);}
          else series.set(k,{pkg:r.pkg_key.trim(),machine:r.machine_id,lot:r.lot_id,ts:[r.created_at],bonded:[r.bonded_unit],firstTs:r.created_at,firstBonded:r.bonded_unit,firstUph:r.uph});
        }
        const pkgMap=new Map<string,number[]>();
        for (let i=0;i<w.hours.length;i++) {
          const slotEnd=slotEndForHour(w,w.hours[i]); const slotTotals=new Map<string,number>();
          for (const [k,s] of series) {
            const vals:number[]=[];
            for (let j=0;j<s.ts.length;j++){if(s.ts[j]<=slotEnd)vals.push(s.bonded[j]);else break;}
            if(!vals.length) continue;
            const [,mc,lot]=k.split('\0'); const pk=`${mc}\0${lot}`;
            const base=pre.has(pk)?pre.get(pk)!:(()=>{const f=first.get(k)!;return carryoverBaseline(startSecs,f.ts,f.b,f.u);})();
            slotTotals.set(s.pkg,(slotTotals.get(s.pkg)??0)+resetAwareTotal(base,vals));
          }
          for (const [pkg,t] of slotTotals){if(!pkgMap.has(pkg))pkgMap.set(pkg,new Array(n).fill(0));pkgMap.get(pkg)![i]=t;}
        }
        return reply.send({status:'ok', data:{packages:Object.fromEntries(pkgMap)}});
      } catch (err) { return unavail(reply, err instanceof Error ? err.message : String(err)); }
    }
  );

  // 3. Packages
  app.get<{Querystring:{date?:string; shift?:string; hour?:string; packages?:string}}>(
    '/api/v1/wb-uph/packages', {preHandler:authCheck}, async (req, reply) => {
      const db = getSqliteDb(); if (!db) return unavail(reply);
      try {
        const [date, shift] = resolveShift(req.query.date, req.query.shift);
        const w = shiftWindow(date, shift);
        const hour = req.query.hour !== undefined ? Number(req.query.hour) : w.hours[w.hours.length-1];
        const slotEnd = slotEndForHour(w, hour);
        const pkgFilter = (req.query.packages??'').split(',').map(s=>s.trim()).filter(Boolean);
        const pkgClause = buildPkgClause(pkgFilter);
        const rows = db.prepare(
          `SELECT pkg_key, COALESCE(SUM(delta),0) AS bonded FROM (
             SELECT ${PKG} AS pkg_key, machine_id, lot_id,
                    MAX(0, MAX(bonded_unit) - COALESCE(
                      (SELECT bonded_unit FROM uph_records pre WHERE pre.machine_id=main.machine_id AND pre.lot_id=main.lot_id AND pre.voided=0 AND pre.created_at < ? ORDER BY pre.created_at DESC LIMIT 1),
                      (SELECT CASE WHEN (julianday(f.created_at)-julianday(?))>0 AND f.bonded_unit/((julianday(f.created_at)-julianday(?))*24.0)>f.uph*2 THEN f.bonded_unit ELSE 0 END
                       FROM uph_records f WHERE f.machine_id=main.machine_id AND f.lot_id=main.lot_id AND f.voided=0 AND f.created_at >= ? AND f.created_at <= ? ORDER BY f.created_at ASC LIMIT 1)
                    )) AS delta
             FROM uph_records main WHERE voided=0 AND created_at >= ? AND created_at <= ? ${pkgClause}
             GROUP BY ${PKG}, machine_id, lot_id
           ) GROUP BY pkg_key ORDER BY bonded DESC`
        ).all(w.start, w.start, w.start, w.start, slotEnd, w.start, slotEnd) as Array<{pkg_key:string; bonded:number}>;
        return reply.send({status:'ok', data: rows.map(r=>({package:r.pkg_key, bonded:r.bonded}))});
      } catch (err) { return unavail(reply, err instanceof Error ? err.message : String(err)); }
    }
  );

  // 4. Machines
  app.get<{Querystring:{date?:string; shift?:string; hour?:string; package?:string}}>(
    '/api/v1/wb-uph/machines', {preHandler:authCheck}, async (req, reply) => {
      const db = getSqliteDb(); if (!db) return unavail(reply);
      const pkg = req.query.package;
      if (!pkg) return reply.code(400).send({status:'error', error:{code:400, message:'package required'}});
      try {
        const [date, shift] = resolveShift(req.query.date, req.query.shift);
        const w = shiftWindow(date, shift);
        const hour = req.query.hour !== undefined ? Number(req.query.hour) : w.hours[w.hours.length-1];
        const slotEnd = slotEndForHour(w, hour);
        const pre = loadPreBaselines(db, w.start);
        const pkgClause = pkg.includes('(')
          ? `AND (${PKG} = ?)`
          : `AND (${PKG} = ? OR (package = ? AND (package_mpc IS NULL OR package_mpc LIKE ? || '(%')))`;
        const pkgArgs = pkg.includes('(') ? [pkg] : [pkg, pkg, pkg];
        const rows = db.prepare(
          `SELECT machine_id, lot_id, bonded_unit, created_at, uph, COALESCE(badge_no,'') AS badge_no, ${PKG} AS pkg_mpc
           FROM uph_records WHERE voided=0 AND created_at >= ? AND created_at <= ? ${pkgClause}
           ORDER BY created_at`
        ).all(w.start, slotEnd, ...pkgArgs) as Array<{machine_id:string; lot_id:string; bonded_unit:number; created_at:string; uph:number; badge_no:string; pkg_mpc:string}>;

        const startSecs = parseTsSecs(w.start);
        const serMap = new Map<string,{machine:string;lot:string;bonded:number[];firstTs:string;firstBonded:number;firstUph:number}>();
        for (const r of rows) {
          const k=`${r.machine_id}\0${r.lot_id}`; const s=serMap.get(k);
          if(s) s.bonded.push(r.bonded_unit);
          else serMap.set(k,{machine:r.machine_id,lot:r.lot_id,bonded:[r.bonded_unit],firstTs:r.created_at,firstBonded:r.bonded_unit,firstUph:r.uph});
        }
        type Agg={bonded:number; uph:number; lastScan:string; badge:string; pkgMpc:string};
        const agg=new Map<string,Agg>();
        for (const s of serMap.values()) {
          const base=pre.has(`${s.machine}\0${s.lot}`)?pre.get(`${s.machine}\0${s.lot}`)!:carryoverBaseline(startSecs,s.firstTs,s.firstBonded,s.firstUph);
          const a=agg.get(s.machine);
          if(a) a.bonded+=resetAwareTotal(base,s.bonded);
          else agg.set(s.machine,{bonded:resetAwareTotal(base,s.bonded),uph:0,lastScan:'',badge:'',pkgMpc:''});
        }
        for (const r of rows) {
          const a=agg.get(r.machine_id); if(!a) continue;
          if(r.badge_no) a.badge=r.badge_no; if(r.pkg_mpc) a.pkgMpc=r.pkg_mpc;
          if(r.created_at>a.lastScan) a.lastScan=r.created_at; if(r.uph>0) a.uph=r.uph;
        }
        const maxUphRows = db.prepare(
          `SELECT machine_id, MAX(uph) AS max_uph
           FROM uph_records WHERE voided=0 AND created_at >= datetime(?, '-3 days') AND created_at <= ? ${pkgClause}
           GROUP BY machine_id`
        ).all(w.start, w.end, ...pkgArgs) as Array<{machine_id:string; max_uph:number}>;
        const maxUphMap = new Map(maxUphRows.map(r => [r.machine_id, r.max_uph]));
        const out=[...agg.entries()].map(([mid,a])=>({machine_id:mid,badge_no:a.badge,uph:a.uph,bonded_unit:a.bonded,last_scan_ts:a.lastScan||null,pkg_mpc:a.pkgMpc,max_uph:maxUphMap.get(mid)??null})).sort((a,b)=>b.bonded_unit-a.bonded_unit);
        return reply.send({status:'ok', data:out});
      } catch (err) { return unavail(reply, err instanceof Error ? err.message : String(err)); }
    }
  );

  // 5. Records
  app.get<{Querystring:{date?:string; shift?:string; machine_id?:string; package?:string}}>(
    '/api/v1/wb-uph/records', {preHandler:authCheck}, async (req, reply) => {
      const db = getSqliteDb(); if (!db) return unavail(reply);
      const {machine_id, package:pkg} = req.query;
      if (!machine_id||!pkg) return reply.code(400).send({status:'error', error:{code:400, message:'machine_id and package required'}});
      try {
        const [date, shift] = resolveShift(req.query.date, req.query.shift);
        const w = shiftWindow(date, shift);
        const pf = pkg.includes('(')?`AND (${PKG} = :pkg)`:`AND (${PKG} = :pkg OR (package = :pkg AND (package_mpc IS NULL OR package_mpc LIKE :pkg || '(%')))`;
        const cur = db.prepare(
          `SELECT created_at, lot_id, pkg, uph, bonded_unit,
                  CASE WHEN bonded_unit >= prevval THEN bonded_unit-prevval ELSE bonded_unit END AS delta_bonded, badge_no
           FROM (
             SELECT created_at, lot_id, ${PKG} AS pkg, uph, bonded_unit,
                    COALESCE(LAG(bonded_unit) OVER (PARTITION BY lot_id ORDER BY created_at),
                             (SELECT bonded_unit FROM uph_records p2 WHERE p2.machine_id=:machine AND p2.lot_id=uph_records.lot_id AND p2.voided=0 AND p2.created_at<:start ORDER BY p2.created_at DESC LIMIT 1),
                             CASE WHEN (julianday(created_at)-julianday(:start))>0 AND bonded_unit/((julianday(created_at)-julianday(:start))*24.0)>uph*2 THEN bonded_unit ELSE 0 END
                    ) AS prevval,
                    COALESCE(badge_no,'') AS badge_no
             FROM uph_records WHERE voided=0 AND machine_id=:machine ${pf} AND created_at >= :start AND created_at <= :end
           ) ORDER BY created_at ASC`
        ).all({machine:machine_id, pkg, start:w.start, end:w.end}) as any[];
        let prev = db.prepare(
          `SELECT created_at, lot_id, ${PKG} AS pkg, uph, bonded_unit, 0 AS delta_bonded, COALESCE(badge_no,'') AS badge_no
           FROM uph_records WHERE voided=0 AND machine_id=:machine ${pf} AND created_at < :start
           ORDER BY created_at DESC LIMIT 5`
        ).all({machine:machine_id, pkg, start:w.start}) as any[];
        prev.reverse();
        const map = (r:any) => ({created_at:r.created_at, lot_id:r.lot_id, package_mpc:(r.pkg??'').trim(), uph:r.uph, bonded_unit:r.bonded_unit, delta_bonded:r.delta_bonded, badge_no:r.badge_no});
        return reply.send({status:'ok', data:{current:cur.map(map), prev_tail:prev.map(map)}});
      } catch (err) { return unavail(reply, err instanceof Error ? err.message : String(err)); }
    }
  );

  // 6. Monitor
  app.get<{Querystring:{date?:string; shift?:string}}>(
    '/api/v1/wb-uph/monitor', {preHandler:authCheck}, async (req, reply) => {
      const db = getSqliteDb(); if (!db) return unavail(reply);
      try {
        const [date, shift] = resolveShift(req.query.date, req.query.shift);
        const w = shiftWindow(date, shift);
        const now = new Date();
        const asOf = `${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}`;
        const nowSecs = Math.floor(now.getTime()/1000);
        const THRESHOLD_MIN = 120;

        const active = db.prepare(
          `SELECT machine_id, MAX(created_at) AS last_scan_ts,
                  COALESCE((SELECT ${PKG} FROM uph_records r2 WHERE r2.machine_id=r1.machine_id AND r2.voided=0 AND r2.created_at >= ? AND r2.created_at <= ? ORDER BY r2.created_at DESC LIMIT 1),'') AS package
           FROM uph_records r1 WHERE voided=0 AND created_at >= ? AND created_at <= ? GROUP BY machine_id`
        ).all(w.start, w.end, w.start, w.end) as Array<{machine_id:string; last_scan_ts:string; package:string}>;
        const activeIds = new Set(active.map(r=>r.machine_id));

        const lookback = `${w.start.slice(0,10)} 00:00:00`;
        const nodata = db.prepare(
          `SELECT machine_id, COALESCE((SELECT ${PKG} FROM uph_records r2 WHERE r2.machine_id=r1.machine_id AND r2.voided=0 ORDER BY r2.created_at DESC LIMIT 1),'') AS package
           FROM uph_records r1 WHERE voided=0 AND created_at >= ? AND created_at < ? GROUP BY machine_id`
        ).all(lookback, w.start) as Array<{machine_id:string; package:string}>;

        const rows: any[] = active.map(r=>{const sm=Math.round((nowSecs-parseTsSecs(r.last_scan_ts))/60);return{machine_id:r.machine_id,package:r.package,last_scan_ts:r.last_scan_ts,since_min:sm,status:sm<=THRESHOLD_MIN?'active':'stale'};});
        for (const r of nodata) {
          if(activeIds.has(r.machine_id)) continue;
          rows.push({machine_id:r.machine_id,package:r.package,last_scan_ts:null,since_min:null,status:'no_data'});
        }
        const ord=(s:string)=>s==='no_data'?0:s==='stale'?1:2;
        rows.sort((a,b)=>{const d=ord(a.status)-ord(b.status);return d!==0?d:(b.since_min??9999)-(a.since_min??9999);});
        return reply.send({status:'ok', data:{rows, as_of:asOf, threshold_min:THRESHOLD_MIN}});
      } catch (err) { return unavail(reply, err instanceof Error ? err.message : String(err)); }
    }
  );
}
