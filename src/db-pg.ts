// PostgreSQL pool for DA-UPH (database: uph)
// Connection string from DA_DB_URL env var.
// Returns null if env var unset — routes return 503 gracefully.

import pg from 'pg';

const { Pool } = pg;

let _pool: pg.Pool | null = null;

export function getPgPool(): pg.Pool | null {
  const url = process.env.DA_DB_URL?.trim();
  if (!url) return null;
  if (!_pool) {
    _pool = new Pool({ connectionString: url, max: 5 });
  }
  return _pool;
}
