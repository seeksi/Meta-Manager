// Neon-backed Drizzle client. Lazy: import is side-effect free so `next build` doesn't
// need DATABASE_URL; the connection is created (and validated) on first query.
import { drizzle, type NeonHttpDatabase } from "drizzle-orm/neon-http";
import { neon } from "@neondatabase/serverless";
import { schema } from "./schema";

let _db: NeonHttpDatabase<typeof schema> | null = null;

export function getDb(): NeonHttpDatabase<typeof schema> {
  if (_db) return _db;
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set — see .env.example");
  _db = drizzle(neon(url), { schema });
  return _db;
}

export { schema };
