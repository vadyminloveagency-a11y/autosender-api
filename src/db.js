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
}
