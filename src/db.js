import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const { Pool } = pg;

let pool = null;

export function getPool() {
  if (!pool) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error("DATABASE_URL is not set");
    }
    pool = new Pool({
      connectionString,
      ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: false } : false,
    });
  }
  return pool;
}

export async function initDb() {
  const db = getPool();
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const schema = fs.readFileSync(path.join(__dirname, "schema.sql"), "utf8");
  await db.query(schema);
  await db.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'operator'`);
  await db.query(`ALTER TABLE favorites ADD COLUMN IF NOT EXISTS inbox_order INTEGER`);
  await db.query(`ALTER TABLE favorites ADD COLUMN IF NOT EXISTS letter_count INTEGER NOT NULL DEFAULT 0`);
  await db.query(`ALTER TABLE favorites ADD COLUMN IF NOT EXISTS is_site_favorite BOOLEAN NOT NULL DEFAULT FALSE`);
  await db.query(`ALTER TABLE favorites ADD COLUMN IF NOT EXISTS is_site_ignored BOOLEAN NOT NULL DEFAULT FALSE`);
  await db.query(`ALTER TABLE favorites ADD COLUMN IF NOT EXISTS man_type TEXT NOT NULL DEFAULT ''`);
  await db.query(`ALTER TABLE favorites ADD COLUMN IF NOT EXISTS first_contact_at TIMESTAMPTZ`);
  await db.query(`ALTER TABLE favorites ADD COLUMN IF NOT EXISTS last_letter_at TIMESTAMPTZ`);
  await db.query(`ALTER TABLE favorites ADD COLUMN IF NOT EXISTS is_pinned BOOLEAN NOT NULL DEFAULT FALSE`);
  await db.query(`ALTER TABLE favorites ADD COLUMN IF NOT EXISTS pin_order BIGINT`);
}
