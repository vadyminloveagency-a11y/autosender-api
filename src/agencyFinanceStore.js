import { getPool } from "./db.js";
import { decryptSecret, encryptSecret, maskUsername } from "./cryptoUtil.js";

export async function ensureAgencyFinanceTables() {
  const db = getPool();
  await db.query(`
    CREATE TABLE IF NOT EXISTS agency_finance_credentials (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      username TEXT NOT NULL DEFAULT '',
      password_enc TEXT NOT NULL DEFAULT '',
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

export async function getAgencyFinanceCredentials() {
  const envUser = String(process.env.DREAM_AGENCY_USERNAME || "").trim();
  const envPass = String(process.env.DREAM_AGENCY_PASSWORD || "");
  if (envUser && envPass) {
    return {
      username: envUser,
      password: envPass,
      source: "env",
      usernameMasked: maskUsername(envUser),
      configured: true,
    };
  }

  await ensureAgencyFinanceTables();
  const db = getPool();
  const result = await db.query(
    `SELECT username, password_enc, updated_at FROM agency_finance_credentials WHERE id = 1 LIMIT 1`,
  );
  const row = result.rows[0];
  if (!row?.username || !row?.password_enc) {
    return {
      username: "",
      password: "",
      source: "db",
      usernameMasked: "",
      configured: false,
      updatedAt: null,
    };
  }
  return {
    username: String(row.username || ""),
    password: decryptSecret(row.password_enc),
    source: "db",
    usernameMasked: maskUsername(row.username),
    configured: true,
    updatedAt: row.updated_at || null,
  };
}

export async function upsertAgencyFinanceCredentials({ username, password }) {
  const user = String(username || "").trim();
  const pass = String(password || "");
  if (!user || !pass) throw new Error("Agency username and password are required");
  await ensureAgencyFinanceTables();
  const db = getPool();
  await db.query(
    `INSERT INTO agency_finance_credentials (id, username, password_enc, updated_at)
     VALUES (1, $1, $2, NOW())
     ON CONFLICT (id) DO UPDATE SET
       username = EXCLUDED.username,
       password_enc = EXCLUDED.password_enc,
       updated_at = NOW()`,
    [user, encryptSecret(pass)],
  );
  return {
    ok: true,
    configured: true,
    usernameMasked: maskUsername(user),
    source: "db",
  };
}
