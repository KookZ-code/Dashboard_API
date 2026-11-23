// Technician statistics for WB/DA shift reports — port of the technician section of the
// Rust build_shift_report (Dashboad_API_rush/src/repositories/wb_repo.rs, "Compute technician stats").
//
// The caller decides which events are DOWN or setup-conversion jobs (job-type sets live in the
// route files) and only reports events that carry a technician name. This class accumulates
// per-technician counts and times, then produces `tech_list`, `tech_summary` and the number of
// distinct technicians (`n_tech`) in the same shape the frontend reads.
//
// Job identity: a closed job is keyed by type + start time, so a DOWN and a SETUP starting at the
// same datex count as two jobs. Open jobs are keyed by machine + start time + symptom.

interface TechStat {
  closed:     Set<string>;   // closed job ids (down + setup)
  open:       Set<string>;   // open job ids
  down:       Set<string>;   // closed DOWN job ids
  setup:      Set<string>;   // closed setup-conversion job ids
  downTimes:  number[];      // repair minutes of closed DOWN jobs
  setupTimes: number[];      // repair minutes of closed setup jobs
  downEvents:  number;
  setupEvents: number;
}

/** Round to 1 decimal, half up (matches Rust `(x * 10.0).round() / 10.0` for non-negative values). */
const r1 = (v: number): number => Math.round(v * 10) / 10;
const mean = (xs: number[]): number => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0);

export class TechAccumulator {
  private readonly stats = new Map<string, TechStat>();
  private readonly techs = new Set<string>();

  private get(name: string): TechStat {
    let s = this.stats.get(name);
    if (!s) {
      s = { closed: new Set(), open: new Set(), down: new Set(), setup: new Set(),
            downTimes: [], setupTimes: [], downEvents: 0, setupEvents: 0 };
      this.stats.set(name, s);
    }
    this.techs.add(name);
    return s;
  }

  /** A closed M/C DOWN job with a technician. `repairMin` is the job's repair time in minutes. */
  closedDown(tech: string, datex: Date | null, repairMin: number): void {
    const s  = this.get(tech);
    const id = `DOWN:${datex?.getTime() ?? 'null'}`;
    s.downTimes.push(repairMin);
    s.downEvents += 1;
    s.down.add(id);
    s.closed.add(id);
  }

  /** A closed setup-conversion job (SETUP / CONVERT / CLEAN MOLD / CHANGE CAP) with a technician. */
  closedSetup(tech: string, datex: Date | null, repairMin: number): void {
    const s  = this.get(tech);
    const id = `SETUP:${datex?.getTime() ?? 'null'}`;
    s.setupTimes.push(repairMin);
    s.setupEvents += 1;
    s.setup.add(id);
    s.closed.add(id);
  }

  /** An open job (DOWN or setup-conversion) with a technician. `jobId` = `${machine}:${t_start}:${symptom}`. */
  openJob(tech: string, jobId: string): void {
    this.get(tech).open.add(jobId);
  }

  /** Distinct technicians across closed and open jobs in the reported machines (Rust `tech_set`). */
  get nTech(): number {
    return this.techs.size;
  }

  /** `tech_list` (sorted by name) and `tech_summary`. Summary is all zeros when there are no technicians. */
  result(): { tech_summary: Record<string, number>; tech_list: Record<string, number | string>[] } {
    const rows = [...this.stats.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, s]) => {
        const downAvg  = mean(s.downTimes);
        const setupAvg = mean(s.setupTimes);
        return {
          name,
          closed_jobs:  s.closed.size,
          open_jobs:    s.open.size,
          total_jobs:   s.closed.size + s.open.size,
          down_count:   s.down.size,
          setup_count:  s.setup.size,
          down_avg:     r1(downAvg),
          down_min:     r1(s.downTimes.length ? Math.min(...s.downTimes) : 0),
          down_max:     r1(Math.max(0, ...s.downTimes)),
          down_events:  s.downEvents,
          setup_avg:    r1(setupAvg),
          setup_min:    r1(s.setupTimes.length ? Math.min(...s.setupTimes) : 0),
          setup_max:    r1(Math.max(0, ...s.setupTimes)),
          setup_events: s.setupEvents,
          _downAvg: downAvg,
          _setupAvg: setupAvg,
          _hasDown: s.downTimes.length > 0,
          _hasSetup: s.setupTimes.length > 0,
          _downMin: s.downTimes.length ? Math.min(...s.downTimes) : 0,
          _downMax: Math.max(0, ...s.downTimes),
          _setupMin: s.setupTimes.length ? Math.min(...s.setupTimes) : 0,
          _setupMax: Math.max(0, ...s.setupTimes),
        };
      });

    if (rows.length === 0) {
      return {
        tech_summary: {
          tech_count: 0, down_jobs: 0, setup_jobs: 0, closed_jobs: 0, open_jobs: 0, total_jobs: 0,
          closed_pct: 0, open_pct: 0, avg_jobs: 0,
          down_avg: 0, down_min: 0, down_max: 0, setup_avg: 0, setup_min: 0, setup_max: 0,
        },
        tech_list: [],
      };
    }

    const closed     = rows.reduce((s, r) => s + r.closed_jobs, 0);
    const open       = rows.reduce((s, r) => s + r.open_jobs, 0);
    const totalAll   = closed + open;
    const downMins   = rows.filter(r => r._hasDown).map(r => r._downMin);
    const setupMins  = rows.filter(r => r._hasSetup).map(r => r._setupMin);

    const summary = {
      tech_count:  rows.length,
      down_jobs:   rows.reduce((s, r) => s + r.down_count, 0),
      setup_jobs:  rows.reduce((s, r) => s + r.setup_count, 0),
      closed_jobs: closed,
      open_jobs:   open,
      total_jobs:  totalAll,
      closed_pct:  totalAll > 0 ? r1(closed / totalAll * 100) : 0,
      open_pct:    totalAll > 0 ? r1(open / totalAll * 100) : 0,
      avg_jobs:    r1(totalAll / rows.length),
      // Averages are the mean of per-technician averages (technicians without that job type count as 0), as in Rust.
      down_avg:    r1(mean(rows.map(r => r._downAvg))),
      down_min:    downMins.length ? r1(Math.min(...downMins)) : 0,
      down_max:    r1(Math.max(0, ...rows.map(r => r._downMax))),
      setup_avg:   r1(mean(rows.map(r => r._setupAvg))),
      setup_min:   setupMins.length ? r1(Math.min(...setupMins)) : 0,
      setup_max:   r1(Math.max(0, ...rows.map(r => r._setupMax))),
    };

    const list = rows.map(({ _downAvg, _setupAvg, _hasDown, _hasSetup, _downMin, _downMax, _setupMin, _setupMax, ...pub }) => pub);
    return { tech_summary: summary, tech_list: list };
  }
}
