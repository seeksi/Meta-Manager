// Postgres-backed Drizzle client. Lazy: import is side-effect free so `next build` doesn't
// need DATABASE_URL; the pool is created (and the connection validated) on first query.
// Uses node-postgres (TCP), so DATABASE_URL can point at a LOCAL Postgres or a Neon standard
// connection string — the long-running desktop server doesn't need the serverless HTTP driver.
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { schema } from "./schema";

let _db: NodePgDatabase<typeof schema> | null = null;

export function getDb(): NodePgDatabase<typeof schema> {
  if (_db) return _db;
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set — see .env.example");
  // Enable TLS when the URL asks for it (e.g. Neon's sslmode=require); off for a plain local DB.
  const needsSsl = /sslmode=require|neon\.tech/.test(url);
  const pool = new Pool({ connectionString: url, ...(needsSsl ? { ssl: { rejectUnauthorized: false } } : {}) });
  _db = drizzle(pool, { schema });
  return _db;
}

export { schema };
