import sql from 'mssql';
import { config } from './config.js';

export const pool = new sql.ConnectionPool({
  server:   config.db.server,
  port:     config.db.port,
  database: config.db.database,
  user:     config.db.user,
  password: config.db.password,
  options: {
    trustServerCertificate: true,
    encrypt: false,
  },
  pool: { max: 10, min: 0, idleTimeoutMillis: 3_600_000 },
});
