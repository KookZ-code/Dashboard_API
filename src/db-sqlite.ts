// SQLite helper for WB-UPH central.db.
//
// central.db is kept as a replica at C:\uph_replica\central.db, refreshed by
// a separate infra-owned replication job (not this process) — dashboard-api
// just reads it. We don't control how that job updates the file (in-place
// write vs atomic replace), so rather than assume, we periodically check its
// mtime and reopen on change. This never runs on the request path: only the
// startup sync and a background timer touch the filesystem.
//
// If CENTRAL_DB_PATH ever points to a UNC network share again (no local
// replica available), we transparently fall back to copy-to-temp-then-open,
// since better-sqlite3 can't open UNC paths directly.

import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import os from 'os';

interface CacheState {
  sourceMtime: number;
  db: Database.Database;
}

let cache: CacheState | null = null;
let syncing = false;

function getSourcePath(): string | null {
  return process.env.CENTRAL_DB_PATH?.trim() || null;
}

function getSyncIntervalMs(): number {
  return Number(process.env.REPLICA_SYNC_INTERVAL_MS ?? 5 * 60_000);
}

function isNetworkPath(p: string): boolean {
  return p.startsWith('\\\\') || p.startsWith('//');
}

function localCopyPath(): string {
  return path.join(os.tmpdir(), 'dashboard_api_central.db');
}

function openDb(filePath: string): Database.Database {
  return new Database(filePath, { readonly: true, fileMustExist: true });
}

function swap(newDb: Database.Database, mtime: number): void {
  const old = cache?.db;
  cache = { sourceMtime: mtime, db: newDb };
  if (old) try { old.close(); } catch {}
}

/** Refresh the DB handle if the source file changed. Never called from a
 *  request handler — only from the startup sync and the background timer. */
async function syncReplica(): Promise<void> {
  const src = getSourcePath();
  if (!src) return;

  let srcMtime: number;
  try {
    srcMtime = fs.statSync(src).mtimeMs;
  } catch {
    return; // replica/share unreachable — keep serving the existing handle, if any
  }

  if (cache && cache.sourceMtime === srcMtime) return; // unchanged
  if (syncing) return; // a sync is already in flight
  syncing = true;
  try {
    if (isNetworkPath(src)) {
      const dest = localCopyPath();
      await fs.promises.copyFile(src, dest);
      swap(openDb(dest), srcMtime);
    } else {
      swap(openDb(src), srcMtime);
    }
  } finally {
    syncing = false;
  }
}

/** Do the first sync and await it — call once before the server starts
 *  accepting traffic so the first requests aren't served stale/empty. */
export async function initReplica(): Promise<void> {
  await syncReplica();
}

/** Start the periodic background refresh. Errors are swallowed per-tick —
 *  a transient outage just means the next tick retries. */
export function startReplicaSync(): void {
  setInterval(() => {
    syncReplica().catch(() => {});
  }, getSyncIntervalMs());
}

/** Request-path accessor — returns whatever DB handle is current.
 *  Never touches the filesystem. */
export function getSqliteDb(): Database.Database | null {
  return cache?.db ?? null;
}
