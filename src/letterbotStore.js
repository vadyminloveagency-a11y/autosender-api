import { getPool } from "./db.js";

export async function ensureLetterBotTables() {
  const db = getPool();
  await db.query(`
    CREATE TABLE IF NOT EXISTS letterbot_jobs (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL,
      profile_id TEXT NOT NULL DEFAULT 'default',
      cookie_header TEXT NOT NULL DEFAULT '',
      selection JSONB NOT NULL DEFAULT '{}'::jsonb,
      state JSONB NOT NULL DEFAULT '{}'::jsonb,
      is_running BOOLEAN NOT NULL DEFAULT FALSE,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (user_id, profile_id)
    )
  `);
  await db.query(`
    CREATE TABLE IF NOT EXISTS dream_credentials (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL,
      profile_id TEXT NOT NULL DEFAULT 'default',
      username TEXT NOT NULL,
      password_enc TEXT NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (user_id, profile_id)
    )
  `);
}

export async function upsertLetterBotJob({
  userId,
  profileId,
  cookieHeader,
  selection,
  state,
  isRunning,
}) {
  const db = getPool();
  await db.query(
    `INSERT INTO letterbot_jobs (user_id, profile_id, cookie_header, selection, state, is_running, updated_at)
     VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6, NOW())
     ON CONFLICT (user_id, profile_id) DO UPDATE SET
       cookie_header = COALESCE(NULLIF(EXCLUDED.cookie_header, ''), letterbot_jobs.cookie_header),
       selection = CASE
         WHEN EXCLUDED.selection = '{}'::jsonb THEN letterbot_jobs.selection
         ELSE EXCLUDED.selection
       END,
       state = EXCLUDED.state,
       is_running = EXCLUDED.is_running,
       updated_at = NOW()`,
    [
      Number(userId),
      String(profileId || "default"),
      String(cookieHeader || ""),
      JSON.stringify(selection || {}),
      JSON.stringify(state || {}),
      Boolean(isRunning),
    ],
  );
}

export async function listRunningLetterBotJobs() {
  const db = getPool();
  const result = await db.query(
    `SELECT user_id, profile_id, cookie_header, selection, state
     FROM letterbot_jobs
     WHERE is_running = TRUE
     ORDER BY updated_at DESC`,
  );
  return result.rows;
}

export async function listRunningLetterBotJobsForUser(userId) {
  const db = getPool();
  const result = await db.query(
    `SELECT user_id, profile_id, cookie_header, selection, state, is_running, updated_at
     FROM letterbot_jobs
     WHERE user_id = $1 AND is_running = TRUE
     ORDER BY updated_at DESC`,
    [Number(userId)],
  );
  return result.rows;
}

export async function getLetterBotJob(userId, profileId) {
  const db = getPool();
  const result = await db.query(
    `SELECT cookie_header, selection, state, is_running, updated_at
     FROM letterbot_jobs
     WHERE user_id = $1 AND profile_id = $2
     LIMIT 1`,
    [Number(userId), String(profileId || "default")],
  );
  return result.rows[0] || null;
}

export async function markLetterBotJobStopped(userId, profileId) {
  const db = getPool();
  await db.query(
    `UPDATE letterbot_jobs
     SET is_running = FALSE, updated_at = NOW()
     WHERE user_id = $1 AND profile_id = $2`,
    [Number(userId), String(profileId || "default")],
  );
}

export async function upsertDreamCredentials({ userId, profileId, username, passwordEnc }) {
  const db = getPool();
  await db.query(
    `INSERT INTO dream_credentials (user_id, profile_id, username, password_enc, updated_at)
     VALUES ($1, $2, $3, $4, NOW())
     ON CONFLICT (user_id, profile_id) DO UPDATE SET
       username = EXCLUDED.username,
       password_enc = EXCLUDED.password_enc,
       updated_at = NOW()`,
    [
      Number(userId),
      String(profileId || "default"),
      String(username || "").trim(),
      String(passwordEnc || ""),
    ],
  );
}

export async function getDreamCredentials(userId, profileId) {
  const db = getPool();
  const result = await db.query(
    `SELECT username, password_enc, updated_at
     FROM dream_credentials
     WHERE user_id = $1 AND profile_id = $2
     LIMIT 1`,
    [Number(userId), String(profileId || "default")],
  );
  return result.rows[0] || null;
}

export async function deleteDreamCredentials(userId, profileId) {
  const db = getPool();
  await db.query(
    `DELETE FROM dream_credentials WHERE user_id = $1 AND profile_id = $2`,
    [Number(userId), String(profileId || "default")],
  );
}
