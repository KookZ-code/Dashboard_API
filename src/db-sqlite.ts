// SQLite helper for WB-UPH central.db
// better-sqlite3 can't open UNC network share paths directly.
// Strategy (mirrors Rust wb_uph_repo.rs): copy the share file to a local temp
// directory on first access, then serve the cached copy. Re-copy only when the
// source file's mtime changes (stale-while-revalidate).

import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import os from 'os';

interface CacheState {
  localPath: string;
  sourceMtime: number;
  db: Database.Database | null;
}

let cache: CacheState | null = null;
let syncing = false;

function getSourcePath(): string | null {
  return process.env.CENTRAL_DB_PATH?.trim() || null;
}

function isNetworkPath(p: string): boolean {
  return p.startsWith('\\\\') || p.startsWith('//');
}

function localCachePath(): string {
  return path.join(os.tmpdir(), 'dashboard_api_central.db');
}

function copyToLocal(src: string): string {
  const dest = localCachePath();
  fs.copyFileSync(src, dest);
  return dest;
}

function openDb(filePath: string): Database.Database {
  return new Database(filePath, { readonly: true, fileMustExist: true });
}

export function getSqliteDb(): Database.Database | null {
  const src = getSourcePath();
  if (!src) return null;

  try {
    // Local path — open directly, no cache needed
    if (!isNetworkPath(src)) {
      if (!cache || cache.localPath !== src) {
        if (cache?.db) try { cache.db.close(); } catch {}
        const db = openDb(src);
        cache = { localPath: src, sourceMtime: 0, db };
      }
      return cache.db;
    }

    // Network path — need a local copy
    const srcMtime = (() => {
      try { return fs.statSync(src).mtimeMs; } catch { return -1; }
    })();

    if (srcMtime < 0) return null; // share unreachable

    // Cache hit — same mtime
    if (cache && cache.sourceMtime === srcMtime && cache.db) {
      try { cache.db.prepare('SELECT 1').get(); return cache.db; } catch { cache.db = null; }
    }

    // Cache miss or mtime changed — copy file
    if (!syncing) {
      syncing = true;
      if (cache === null) {
        // First access — copy synchronously so this request has data
        try {
          const localPath = copyToLocal(src);
          const db = openDb(localPath);
          if (cache?.db) try { cache.db.close(); } catch {}
          cache = { localPath, sourceMtime: srcMtime, db };
        } finally {
          syncing = false;
        }
      } else {
        // Refresh in background — serve stale while copying
        setImmediate(() => {
          try {
            const localPath = copyToLocal(src);
            const newDb = openDb(localPath);
            const old = cache?.db;
            cache = { localPath, sourceMtime: srcMtime, db: newDb };
            if (old) try { old.close(); } catch {}
          } finally { syncing = false; }
        });
      }
    }

    return cache?.db ?? null;
  } catch {
    return null;
  }
}
