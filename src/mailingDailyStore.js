import { getPool } from "./db.js";
import { dreamDayKey } from "./dreamDay.js";

export async function ensureMailingDailyTables() {
  const db = getPool();
  await db.query(`
    CREATE TABLE IF NOT EXISTS mailing_daily_letters (
      day_key DATE NOT NULL,
      profile_id TEXT NOT NULL,
      product TEXT NOT NULL,
      user_id INTEGER,
      letters INTEGER NOT NULL DEFAULT 0,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (day_key, profile_id, product)
    )
  `);
  await db.query(`
    CREATE INDEX IF NOT EXISTS mailing_daily_letters_day_idx
    ON mailing_daily_letters (day_key)
  `);
  await db.query(`
    CREATE INDEX IF NOT EXISTS mailing_daily_letters_profile_day_idx
    ON mailing_daily_letters (profile_id, day_key)
  `);
}

/** Dream business day key (starts 10:00 Europe/Kyiv). */
export function kyivDayKey(date = new Date()) {
  return dreamDayKey(date);
}

function normalizeProduct(product) {
  const value = String(product || "").toLowerCase();
  if (value === "online" || value === "sender-online") return "online";
  if (value === "read" || value === "sender" || value === "sender-read") return "read";
  return "letterbot";
}

/** Increment real letters sent for a questionnaire on a Dream business day. */
export async function bumpMailingDailyLetters({
  dayKey,
  profileId,
  product,
  userId,
  delta,
} = {}) {
  const add = Math.trunc(Number(delta));
  if (!Number.isFinite(add) || add <= 0) return;
  const pid = String(profileId || "").trim();
  if (!pid || pid === "default") return;
  const day = String(dayKey || kyivDayKey()).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return;

  const db = getPool();
  await db.query(
    `INSERT INTO mailing_daily_letters (day_key, profile_id, product, user_id, letters, updated_at)
     VALUES ($1::date, $2, $3, $4, $5, NOW())
     ON CONFLICT (day_key, profile_id, product) DO UPDATE SET
       letters = mailing_daily_letters.letters + EXCLUDED.letters,
       user_id = COALESCE(EXCLUDED.user_id, mailing_daily_letters.user_id),
       updated_at = NOW()`,
    [day, pid, normalizeProduct(product), userId != null ? Number(userId) : null, add],
  );
}

/**
 * Persist an absolute Dream day total (e.g. LetterBot TOTAL DAY).
 * Overwrites the stored LetterBot day value with Dream's official total.
 */
export async function setMailingDailyLettersAbsolute({
  dayKey,
  profileId,
  product,
  userId,
  letters,
} = {}) {
  const value = Math.trunc(Number(letters));
  if (!Number.isFinite(value) || value < 0) return;
  const pid = String(profileId || "").trim();
  if (!pid || pid === "default") return;
  const day = String(dayKey || kyivDayKey()).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return;

  const db = getPool();
  await db.query(
    `INSERT INTO mailing_daily_letters (day_key, profile_id, product, user_id, letters, updated_at)
     VALUES ($1::date, $2, $3, $4, $5, NOW())
     ON CONFLICT (day_key, profile_id, product) DO UPDATE SET
       letters = EXCLUDED.letters,
       user_id = COALESCE(EXCLUDED.user_id, mailing_daily_letters.user_id),
       updated_at = NOW()`,
    [day, pid, normalizeProduct(product), userId != null ? Number(userId) : null, value],
  );
}

/** Per-day totals for a month (for calendar heatmap). */
export async function listMailingDailyMonthTotals(year, month) {
  const y = Number(year);
  const m = Number(month);
  if (!Number.isFinite(y) || !Number.isFinite(m) || m < 1 || m > 12) return [];
  const start = `${y}-${String(m).padStart(2, "0")}-01`;
  const endMonth = m === 12 ? 1 : m + 1;
  const endYear = m === 12 ? y + 1 : y;
  const end = `${endYear}-${String(endMonth).padStart(2, "0")}-01`;

  const db = getPool();
  const result = await db.query(
    `SELECT day_key::text AS day_key, COALESCE(SUM(letters), 0)::int AS letters
     FROM mailing_daily_letters
     WHERE day_key >= $1::date AND day_key < $2::date
     GROUP BY day_key
     ORDER BY day_key`,
    [start, end],
  );
  return result.rows.map((row) => ({
    day: String(row.day_key).slice(0, 10),
    letters: Number(row.letters) || 0,
  }));
}

/** Per-questionnaire breakdown for one Kyiv day. */
export async function listMailingDailyByProfile(dayKey) {
  const day = String(dayKey || kyivDayKey()).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return [];

  const db = getPool();
  const result = await db.query(
    `SELECT
       d.profile_id,
       d.product,
       d.letters,
       d.user_id,
       u.email AS operator_email,
       u.name AS operator_name
     FROM mailing_daily_letters d
     LEFT JOIN users u ON u.id = d.user_id
     WHERE d.day_key = $1::date
     ORDER BY d.profile_id, d.product`,
    [day],
  );
  return result.rows.map((row) => ({
    profileId: String(row.profile_id || ""),
    product: normalizeProduct(row.product),
    letters: Number(row.letters) || 0,
    userId: row.user_id != null ? Number(row.user_id) : null,
    operatorEmail: String(row.operator_email || ""),
    operatorName: String(row.operator_name || ""),
  }));
}
