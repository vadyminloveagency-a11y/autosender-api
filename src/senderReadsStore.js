import { getPool } from "./db.js";

export async function ensureSenderReadsTables() {
  const db = getPool();
  await db.query(`
    CREATE TABLE IF NOT EXISTS sender_reads_jobs (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL,
      profile_id TEXT NOT NULL DEFAULT 'default',
      cookie_header TEXT NOT NULL DEFAULT '',
      selection JSONB NOT NULL DEFAULT '{}'::jsonb,
      state JSONB NOT NULL DEFAULT '{}'::jsonb,
      dupes JSONB NOT NULL DEFAULT '[]'::jsonb,
      is_running BOOLEAN NOT NULL DEFAULT FALSE,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (user_id, profile_id)
    )
  `);
}

export async function upsertSenderReadsJob({
  userId,
  profileId,
  cookieHeader,
  selection,
  state,
  dupes,
  isRunning,
}) {
  const db = getPool();
  await db.query(
    `INSERT INTO sender_reads_jobs
       (user_id, profile_id, cookie_header, selection, state, dupes, is_running, updated_at)
     VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6::jsonb, $7, NOW())
     ON CONFLICT (user_id, profile_id) DO UPDATE SET
       cookie_header = COALESCE(NULLIF(EXCLUDED.cookie_header, ''), sender_reads_jobs.cookie_header),
       selection = CASE
         WHEN EXCLUDED.selection = '{}'::jsonb THEN sender_reads_jobs.selection
         ELSE EXCLUDED.selection
       END,
       state = EXCLUDED.state,
       dupes = CASE
         WHEN EXCLUDED.dupes = '[]'::jsonb THEN sender_reads_jobs.dupes
         ELSE EXCLUDED.dupes
       END,
       is_running = EXCLUDED.is_running,
       updated_at = NOW()`,
    [
      Number(userId),
      String(profileId || "default"),
      String(cookieHeader || ""),
      JSON.stringify(selection || {}),
      JSON.stringify(state || {}),
      JSON.stringify(Array.isArray(dupes) ? dupes : []),
      Boolean(isRunning),
    ],
  );
}

export async function listRunningSenderReadsJobs() {
  const db = getPool();
  const result = await db.query(
    `SELECT user_id, profile_id, cookie_header, selection, state, dupes
     FROM sender_reads_jobs
     WHERE is_running = TRUE
     ORDER BY updated_at DESC`,
  );
  return result.rows;
}

/** Director cabinet — running Sender Read/Online jobs with operator email/name. */
export async function listRunningSenderReadsJobsWithUsers() {
  const db = getPool();
  const result = await db.query(
    `SELECT j.user_id, j.profile_id, j.selection, j.state, j.updated_at, u.email, u.name
     FROM sender_reads_jobs j
     JOIN users u ON u.id = j.user_id
     WHERE j.is_running = TRUE
     ORDER BY j.updated_at DESC`,
  );
  return result.rows;
}

export async function getSenderReadsJob(userId, profileId) {
  const db = getPool();
  const result = await db.query(
    `SELECT cookie_header, selection, state, dupes, is_running, updated_at
     FROM sender_reads_jobs
     WHERE user_id = $1 AND profile_id = $2
     LIMIT 1`,
    [Number(userId), String(profileId || "default")],
  );
  return result.rows[0] || null;
}

export async function markSenderReadsJobStopped(userId, profileId) {
  const db = getPool();
  await db.query(
    `UPDATE sender_reads_jobs
     SET is_running = FALSE, updated_at = NOW()
     WHERE user_id = $1 AND profile_id = $2`,
    [Number(userId), String(profileId || "default")],
  );
}
