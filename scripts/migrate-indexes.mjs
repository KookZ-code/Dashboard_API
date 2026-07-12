// One-off migration: add missing indexes to uph_records in central.db.
// Usage: node scripts/migrate-indexes.mjs [path-to-central.db]
// Defaults to CENTRAL_DB_PATH from .env — pass an explicit path to run against
// a local test copy first.
import 'dotenv/config';
import Database from 'better-sqlite3';

const target = process.argv[2] || process.env.CENTRAL_DB_PATH;
if (!target) {
  console.error('No target path: pass a path argument or set CENTRAL_DB_PATH');
  process.exit(1);
}

console.log(`Opening ${target} (read-write)...`);
const db = new Database(target);

const before = db.prepare(
  `EXPLAIN QUERY PLAN SELECT * FROM uph_records WHERE voided=0 AND created_at >= '2026-01-01' AND created_at <= '2026-01-02'`
).all();
console.log('Query plan BEFORE:', before);

db.exec(`
  CREATE INDEX IF NOT EXISTS idx_uph_records_voided_created
    ON uph_records(voided, created_at);
  CREATE INDEX IF NOT EXISTS idx_uph_records_voided_machine_lot_created
    ON uph_records(voided, machine_id, lot_id, created_at);
`);
console.log('Indexes created (or already existed).');

const after = db.prepare(
  `EXPLAIN QUERY PLAN SELECT * FROM uph_records WHERE voided=0 AND created_at >= '2026-01-01' AND created_at <= '2026-01-02'`
).all();
console.log('Query plan AFTER:', after);

db.close();
