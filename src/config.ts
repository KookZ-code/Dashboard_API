import 'dotenv/config';

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

export const config = {
  db: {
    server:   required('DB_SERVER'),
    port:     Number(process.env.DB_PORT ?? 1433),
    database: required('DB_NAME'),
    user:     required('DB_USER'),
    password: required('DB_PASSWORD'),
  },
  api: {
    port:   Number(process.env.API_PORT ?? 8002),
    host:   process.env.API_HOST ?? '0.0.0.0',
    key:    process.env.API_KEY ?? '',
  },
  // Table/view names — keep configurable to match Python server
  view:         process.env.VIEW_NAME    ?? 'vw_job_nokey',
  machineTable: process.env.MACHINE_TABLE ?? 'dbo.machine',
  jobTable:     process.env.JOB_TABLE    ?? 'dbo.job_listx',
} as const;
