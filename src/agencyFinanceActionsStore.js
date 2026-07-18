import { getPool } from "./db.js";

function validDay(value) {
  const day = String(value || "").slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : "";
}

export async function ensureAgencyFinanceActionTables() {
  const db = getPool();
  await db.query(`
    CREATE TABLE IF NOT EXISTS agency_finance_actions (
      action_key TEXT PRIMARY KEY,
      day_key DATE NOT NULL,
      action_type TEXT NOT NULL DEFAULT '',
      male_profile_id TEXT NOT NULL DEFAULT '',
      male_name TEXT NOT NULL DEFAULT '',
      female_profile_id TEXT NOT NULL DEFAULT '',
      female_name TEXT NOT NULL DEFAULT '',
      occurred_at TEXT NOT NULL DEFAULT '',
      amount_usd NUMERIC(12, 2) NOT NULL DEFAULT 0,
      first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await db.query(`
    CREATE INDEX IF NOT EXISTS agency_finance_actions_day_idx
    ON agency_finance_actions (day_key)
  `);
  await db.query(`
    CREATE INDEX IF NOT EXISTS agency_finance_actions_profile_day_idx
    ON agency_finance_actions (female_profile_id, day_key)
  `);
  await db.query(`
    CREATE TABLE IF NOT EXISTS agency_finance_sync_days (
      day_key DATE PRIMARY KEY,
      official_total_usd NUMERIC(12, 2) NOT NULL DEFAULT 0,
      actions_total_usd NUMERIC(12, 2) NOT NULL DEFAULT 0,
      action_count INTEGER NOT NULL DEFAULT 0,
      is_complete BOOLEAN NOT NULL DEFAULT FALSE,
      synced_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_error TEXT NOT NULL DEFAULT ''
    )
  `);
}

export async function getAgencyFinanceDaySync(dayKey) {
  const day = validDay(dayKey);
  if (!day) return null;
  const db = getPool();
  const result = await db.query(
    `SELECT
       day_key::text AS day_key,
       official_total_usd,
       actions_total_usd,
       action_count,
       is_complete,
       synced_at,
       last_error
     FROM agency_finance_sync_days
     WHERE day_key = $1::date
     LIMIT 1`,
    [day],
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    day: String(row.day_key).slice(0, 10),
    officialTotalUsd: Number(row.official_total_usd) || 0,
    actionsTotalUsd: Number(row.actions_total_usd) || 0,
    actionCount: Number(row.action_count) || 0,
    complete: Boolean(row.is_complete),
    syncedAt: row.synced_at || null,
    error: String(row.last_error || ""),
  };
}

export async function saveAgencyFinanceDay({
  dayKey,
  actions,
  officialTotalUsd,
  complete,
  error = "",
} = {}) {
  const day = validDay(dayKey);
  if (!day) throw new Error("Invalid finance day");
  const list = Array.isArray(actions) ? actions : [];
  const db = getPool();
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    // Only replace a day when it is verified complete. Partial retries may add
    // rows but must never erase previously cached actions.
    if (complete) {
      await client.query(
        `DELETE FROM agency_finance_actions WHERE day_key = $1::date`,
        [day],
      );
    }
    if (list.length) {
      const payload = list.map((action) => ({
        action_key: String(action.actionKey || ""),
        action_type: String(action.type || ""),
        male_profile_id: String(action.maleProfileId || ""),
        male_name: String(action.maleName || ""),
        female_profile_id: String(action.femaleProfileId || ""),
        female_name: String(action.femaleName || ""),
        occurred_at: String(action.occurredAt || ""),
        amount_usd: Number(action.amountUsd) || 0,
      }));
      await client.query(
        `INSERT INTO agency_finance_actions (
           action_key,
           day_key,
           action_type,
           male_profile_id,
           male_name,
           female_profile_id,
           female_name,
           occurred_at,
           amount_usd,
           first_seen_at,
           updated_at
         )
         SELECT
           item.action_key,
           $1::date,
           item.action_type,
           item.male_profile_id,
           item.male_name,
           item.female_profile_id,
           item.female_name,
           item.occurred_at,
           item.amount_usd,
           NOW(),
           NOW()
         FROM jsonb_to_recordset($2::jsonb) AS item(
           action_key TEXT,
           action_type TEXT,
           male_profile_id TEXT,
           male_name TEXT,
           female_profile_id TEXT,
           female_name TEXT,
           occurred_at TEXT,
           amount_usd NUMERIC
         )
         ON CONFLICT (action_key) DO UPDATE SET
           action_type = EXCLUDED.action_type,
           male_profile_id = EXCLUDED.male_profile_id,
           male_name = EXCLUDED.male_name,
           female_profile_id = EXCLUDED.female_profile_id,
           female_name = EXCLUDED.female_name,
           occurred_at = EXCLUDED.occurred_at,
           amount_usd = EXCLUDED.amount_usd,
           updated_at = NOW()`,
        [day, JSON.stringify(payload)],
      );
    }
    const totals = await client.query(
      `SELECT
         COALESCE(SUM(amount_usd), 0) AS total_usd,
         COUNT(*)::int AS action_count
       FROM agency_finance_actions
       WHERE day_key = $1::date`,
      [day],
    );
    const actionsTotalUsd = Number(totals.rows[0]?.total_usd) || 0;
    const actionCount = Number(totals.rows[0]?.action_count) || 0;
    const verified =
      Math.abs(actionsTotalUsd - (Number(officialTotalUsd) || 0)) < 0.05;
    await client.query(
      `INSERT INTO agency_finance_sync_days (
         day_key,
         official_total_usd,
         actions_total_usd,
         action_count,
         is_complete,
         synced_at,
         last_error
       )
       VALUES ($1::date, $2, $3, $4, $5, NOW(), $6)
       ON CONFLICT (day_key) DO UPDATE SET
         official_total_usd = EXCLUDED.official_total_usd,
         actions_total_usd = EXCLUDED.actions_total_usd,
         action_count = EXCLUDED.action_count,
         is_complete = EXCLUDED.is_complete,
         synced_at = NOW(),
         last_error = EXCLUDED.last_error`,
      [
        day,
        Number(officialTotalUsd) || 0,
        actionsTotalUsd,
        actionCount,
        verified,
        String(error || ""),
      ],
    );
    await client.query("COMMIT");
    return {
      day,
      officialTotalUsd: Number(officialTotalUsd) || 0,
      actionsTotalUsd,
      actionCount,
      complete: verified,
      error: String(error || ""),
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function markAgencyFinanceDaySyncError(dayKey, error) {
  const day = validDay(dayKey);
  if (!day) return;
  const db = getPool();
  await db.query(
    `INSERT INTO agency_finance_sync_days (
       day_key,
       is_complete,
       synced_at,
       last_error
     )
     VALUES ($1::date, FALSE, NOW(), $2)
     ON CONFLICT (day_key) DO UPDATE SET
       is_complete = FALSE,
       synced_at = NOW(),
       last_error = EXCLUDED.last_error`,
    [day, String(error?.message || error || "")],
  );
}

export async function listAgencyFinanceActions(fromDay, toDay, profileId = "") {
  const from = validDay(fromDay);
  const to = validDay(toDay || from);
  if (!from || !to) return [];
  const pid = String(profileId || "").trim();
  const db = getPool();
  const params = [from, to];
  let profileClause = "";
  if (pid) {
    params.push(pid);
    profileClause = `AND female_profile_id = $3`;
  }
  const result = await db.query(
    `SELECT
       action_key,
       day_key::text AS day_key,
       action_type,
       male_profile_id,
       male_name,
       female_profile_id,
       female_name,
       occurred_at,
       amount_usd
     FROM agency_finance_actions
     WHERE day_key >= $1::date
       AND day_key <= $2::date
       ${profileClause}
     ORDER BY day_key DESC, occurred_at DESC, action_key`,
    params,
  );
  return result.rows.map((row) => ({
    actionKey: String(row.action_key || ""),
    day: String(row.day_key).slice(0, 10),
    type: String(row.action_type || ""),
    maleProfileId: String(row.male_profile_id || ""),
    maleName: String(row.male_name || ""),
    femaleProfileId: String(row.female_profile_id || ""),
    femaleName: String(row.female_name || ""),
    occurredAt: String(row.occurred_at || ""),
    amountUsd: Number(row.amount_usd) || 0,
  }));
}

export async function listAgencyFinanceDaySyncs(fromDay, toDay) {
  const from = validDay(fromDay);
  const to = validDay(toDay || from);
  if (!from || !to) return [];
  const db = getPool();
  const result = await db.query(
    `SELECT
       day_key::text AS day_key,
       official_total_usd,
       actions_total_usd,
       action_count,
       is_complete,
       synced_at,
       last_error
     FROM agency_finance_sync_days
     WHERE day_key >= $1::date AND day_key <= $2::date
     ORDER BY day_key`,
    [from, to],
  );
  return result.rows.map((row) => ({
    day: String(row.day_key).slice(0, 10),
    officialTotalUsd: Number(row.official_total_usd) || 0,
    actionsTotalUsd: Number(row.actions_total_usd) || 0,
    actionCount: Number(row.action_count) || 0,
    complete: Boolean(row.is_complete),
    syncedAt: row.synced_at || null,
    error: String(row.last_error || ""),
  }));
}
