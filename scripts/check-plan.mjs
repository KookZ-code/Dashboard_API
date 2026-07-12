import Database from 'better-sqlite3';

const target = process.argv[2];
const db = new Database(target, { readonly: true });

console.log('=== Existing indexes on uph_records ===');
console.log(db.prepare(`SELECT name, sql FROM sqlite_master WHERE type='index' AND tbl_name='uph_records'`).all());

console.log('\n=== loadPreBaselines-style query (bounded -2 days, current code) ===');
console.log(db.prepare(
  `EXPLAIN QUERY PLAN SELECT machine_id, lot_id, bonded_unit FROM uph_records
   WHERE voided=0 AND created_at < ? AND created_at >= datetime(?, '-2 days')
   ORDER BY machine_id, lot_id, created_at DESC`
).all('2026-07-06 07:00:00', '2026-07-06 07:00:00'));

db.close();
