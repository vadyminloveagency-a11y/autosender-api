import express from "express";
import { authMiddleware } from "../auth.js";
import { getPool } from "../db.js";
import { dreamDayKey } from "../dreamDay.js";
import { listProfileAssignmentHistoryForUser } from "../agencyProfileStore.js";
import { listRunningLetterBotJobsForUser } from "../letterbotStore.js";
import { listRunningSenderReadsJobs } from "../senderReadsStore.js";

const router = express.Router();

function validDay(value) {
  const day = String(value || "").slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : dreamDayKey();
}

function mapJob(row, product) {
  const state = row?.state && typeof row.state === "object" ? row.state : {};
  const selection = row?.selection && typeof row.selection === "object" ? row.selection : {};
  return {
    product,
    profileId: String(row?.profile_id || ""),
    filter: String(state.filter || selection.channel || selection.filter || ""),
    status: String(state.statusMessage || state.status || "Running"),
    sent: Number(state.sent ?? state.sentCount ?? 0) || 0,
    page: Number(state.page ?? 0) || 0,
    updatedAt: row?.updated_at || null,
  };
}

router.get("/overview", authMiddleware, async (req, res) => {
  try {
    const userId = Number(req.user.id);
    const date = validDay(req.query?.date);
    const db = getPool();
    const [history, dailyResult, letterBotJobs, senderJobs] = await Promise.all([
      listProfileAssignmentHistoryForUser(userId),
      db.query(
        `SELECT
           d.profile_id,
           d.product,
           COALESCE(SUM(d.letters), 0)::int AS letters
         FROM mailing_daily_letters d
         WHERE d.day_key = $2::date
           AND EXISTS (
             SELECT 1
             FROM agency_profile_assignments h
             WHERE h.user_id = $1
               AND h.female_profile_id::text = d.profile_id
               AND h.assigned_at < (($2::date + INTERVAL '1 day') + INTERVAL '10 hours')
               AND (
                 h.unassigned_at IS NULL
                 OR h.unassigned_at >= ($2::date + INTERVAL '10 hours')
               )
           )
         GROUP BY d.profile_id, d.product
         ORDER BY d.profile_id, d.product`,
        [userId, date],
      ),
      listRunningLetterBotJobsForUser(userId),
      listRunningSenderReadsJobs(),
    ]);

    const profilesById = new Map();
    for (const item of history) {
      const key = String(item.femaleProfileId || "");
      if (!key) continue;
      if (!profilesById.has(key)) {
        profilesById.set(key, {
          profileId: key,
          agencyProfileId: item.agencyProfileId,
          displayName: item.displayName || `Profile ${key}`,
          dreamUsername: item.dreamUsername || "",
          photoUrl: item.photoUrl || "",
          active: false,
          assignedAt: item.assignedAt,
          unassignedAt: item.unassignedAt,
          assignments: [],
        });
      }
      const profile = profilesById.get(key);
      profile.assignments.push({
        assignedAt: item.assignedAt,
        unassignedAt: item.unassignedAt,
      });
      if (!item.unassignedAt) {
        profile.active = true;
        profile.agencyProfileId = item.agencyProfileId;
        profile.displayName = item.displayName || profile.displayName;
        profile.dreamUsername = item.dreamUsername || profile.dreamUsername;
        profile.assignedAt = item.assignedAt;
        profile.unassignedAt = null;
      }
    }

    const daily = dailyResult.rows.map((row) => ({
      profileId: String(row.profile_id || ""),
      product: String(row.product || ""),
      letters: Number(row.letters) || 0,
    }));
    const activeJobs = [
      ...letterBotJobs.map((row) => mapJob(row, "LetterBot")),
      ...senderJobs
        .filter((row) => Number(row.user_id) === userId)
        .map((row) => mapJob(row, "Sender")),
    ];

    return res.json({
      ok: true,
      date,
      user: {
        id: userId,
        email: req.user.email || "",
        role: req.user.role || "operator",
      },
      profiles: [...profilesById.values()].sort(
        (a, b) => Number(b.active) - Number(a.active) ||
          String(a.displayName).localeCompare(String(b.displayName)),
      ),
      daily,
      activeJobs,
    });
  } catch (error) {
    console.error("Operator dashboard overview failed:", error);
    return res.status(500).json({ ok: false, error: "Failed to load operator dashboard" });
  }
});

router.get("/mailings-month", authMiddleware, async (req, res) => {
  try {
    const year = Math.max(2020, Math.min(2100, Number(req.query?.year) || new Date().getFullYear()));
    const month = Math.max(1, Math.min(12, Number(req.query?.month) || new Date().getMonth() + 1));
    const start = `${year}-${String(month).padStart(2, "0")}-01`;
    const endMonth = month === 12 ? 1 : month + 1;
    const endYear = month === 12 ? year + 1 : year;
    const end = `${endYear}-${String(endMonth).padStart(2, "0")}-01`;
    const db = getPool();
    const result = await db.query(
      `SELECT d.day_key::text AS day_key, COALESCE(SUM(d.letters), 0)::int AS letters
       FROM mailing_daily_letters d
       WHERE d.day_key >= $2::date
         AND d.day_key < $3::date
         AND EXISTS (
           SELECT 1
           FROM agency_profile_assignments h
           WHERE h.user_id = $1
             AND h.female_profile_id::text = d.profile_id
             AND h.assigned_at < ((d.day_key + INTERVAL '1 day') + INTERVAL '10 hours')
             AND (
               h.unassigned_at IS NULL
               OR h.unassigned_at >= (d.day_key + INTERVAL '10 hours')
             )
         )
       GROUP BY d.day_key
       ORDER BY d.day_key`,
      [Number(req.user.id), start, end],
    );
    return res.json({
      ok: true,
      year,
      month,
      days: result.rows.map((row) => ({
        day: String(row.day_key).slice(0, 10),
        letters: Number(row.letters) || 0,
      })),
    });
  } catch (error) {
    console.error("Operator dashboard month failed:", error);
    return res.status(500).json({ ok: false, error: "Failed to load mailing calendar" });
  }
});

router.get("/gold-men", authMiddleware, async (req, res) => {
  try {
    const search = String(req.query?.search || "").trim();
    const page = Math.max(1, Number(req.query?.page) || 1);
    const pageSize = Math.min(100, Math.max(10, Number(req.query?.pageSize) || 50));
    const offset = (page - 1) * pageSize;
    const db = getPool();
    const result = await db.query(
      `WITH scoped AS (
         SELECT a.*
         FROM agency_finance_actions a
         WHERE EXISTS (
           SELECT 1
           FROM agency_profile_assignments h
           WHERE h.user_id = $1
             AND h.female_profile_id::text = a.female_profile_id
             AND h.assigned_at::date <= a.day_key
             AND (h.unassigned_at IS NULL OR h.unassigned_at::date >= a.day_key)
         )
           AND (
             $2 = ''
             OR a.male_profile_id ILIKE '%' || $2 || '%'
             OR a.male_name ILIKE '%' || $2 || '%'
           )
       ),
       grouped AS (
         SELECT
           CASE
             WHEN male_profile_id <> '' THEN 'id:' || male_profile_id
             ELSE 'name:' || LOWER(TRIM(male_name))
           END AS male_key,
           (ARRAY_AGG(male_profile_id ORDER BY day_key DESC, occurred_at DESC)
             FILTER (WHERE male_profile_id <> ''))[1] AS male_profile_id,
           (ARRAY_AGG(male_name ORDER BY day_key DESC, occurred_at DESC)
             FILTER (WHERE TRIM(male_name) <> ''))[1] AS male_name,
           COUNT(*)::int AS action_count,
           COALESCE(SUM(amount_usd), 0) AS total_usd,
           MIN(day_key)::text AS first_day,
           MAX(day_key)::text AS last_day
         FROM scoped
         WHERE male_profile_id <> '' OR TRIM(male_name) <> ''
         GROUP BY male_key
       )
       SELECT grouped.*, COUNT(*) OVER()::int AS total_men
       FROM grouped
       ORDER BY total_usd DESC, action_count DESC, male_name
       LIMIT $3 OFFSET $4`,
      [Number(req.user.id), search, pageSize, offset],
    );
    const totalMen = Number(result.rows[0]?.total_men) || 0;
    return res.json({
      ok: true,
      men: result.rows.map((row) => ({
        maleProfileId: String(row.male_profile_id || ""),
        maleName: String(row.male_name || ""),
        actionCount: Number(row.action_count) || 0,
        totalUsd: Number(row.total_usd) || 0,
        firstDay: String(row.first_day || "").slice(0, 10),
        lastDay: String(row.last_day || "").slice(0, 10),
      })),
      pagination: {
        page,
        pageSize,
        totalMen,
        totalPages: Math.max(1, Math.ceil(totalMen / pageSize)),
      },
    });
  } catch (error) {
    console.error("Operator dashboard gold men failed:", error);
    return res.status(500).json({ ok: false, error: "Failed to load Gold Men" });
  }
});

export default router;
