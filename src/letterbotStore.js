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

export async function markLetterBotJobStopped(userId, profileId) {
  const db = getPool();
  await db.query(
    `UPDATE letterbot_jobs
     SET is_running = FALSE, updated_at = NOW()
     WHERE user_id = $1 AND profile_id = $2`,
    [Number(userId), String(profileId || "default")],
  );
}
