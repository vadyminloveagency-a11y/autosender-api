/**
 * Merge AutoSender V2 LetterBot director data into the classic admin cabinet.
 * Prefers live V2 HTTP API (in-memory WS totals); falls back to shared DB v2_* tables.
 */
import { getPool } from "./db.js";

function dreamDailyTotalFromState(state) {
  const fromDaily = Number(state?.dailyTotal);
  if (Number.isFinite(fromDaily) && fromDaily > 0) return Math.trunc(fromDaily);
  const fromProgress = Number(state?.progress?.total);
  if (Number.isFinite(fromProgress) && fromProgress > 0) return Math.trunc(fromProgress);
  return null;
}

function parseState(raw) {
  if (raw && typeof raw === "object") return raw;
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw) || {};
    } catch (_) {
      return {};
    }
  }
  return {};
}

function v2ApiBase() {
  return String(
    process.env.V2_LETTERBOT_API_URL || "https://autosender-v2-api.onrender.com",
  )
    .trim()
    .replace(/\/+$/, "");
}

function directorSyncSecret() {
  return String(
    process.env.DIRECTOR_SYNC_SECRET || "autosender-v2-director-sync-2026",
  ).trim();
}

async function fetchV2Json(pathAndQuery) {
  const base = v2ApiBase();
  const secret = directorSyncSecret();
  if (!base || !secret) return null;
  try {
    const response = await fetch(`${base}${pathAndQuery}`, {
      method: "GET",
      headers: {
        accept: "application/json",
        "x-director-sync": secret,
      },
      signal: AbortSignal.timeout(20000),
    });
    if (!response.ok) return null;
    return await response.json().catch(() => null);
  } catch (_) {
    return null;
  }
}

function normalizeV2Job(job) {
  const dailyTotal =
    Number(job?.dailyTotal) > 0
      ? Math.trunc(Number(job.dailyTotal))
      : Number(job?.daySent) > 0
        ? Math.trunc(Number(job.daySent))
        : dreamDailyTotalFromState(job?.state || job) || null;
  return {
    userId: Number(job.userId),
    profileId: String(job.profileId || "default"),
    operatorEmail: String(job.operatorEmail || ""),
    operatorName: String(job.operatorName || ""),
    sessionActive: Boolean(job.sessionActive),
    isPaused: Boolean(job.isPaused),
    filter: String(job.filter || ""),
    percent: job.percent ?? null,
    sent: job.sent ?? null,
    total: dailyTotal,
    daySent: dailyTotal,
    dailyTotal,
    statusMessage: String(job.statusMessage || ""),
    updatedAt: job.updatedAt || null,
    displayName: job.displayName || "",
    photoUrl: job.photoUrl || "",
    source: "v2",
  };
}

/** Active V2 cloud LetterBot jobs for director Active mailings. */
export async function listV2ActiveDirectorJobs() {
  const fromApi = await fetchV2Json("/letterbot/admin/running");
  if (Array.isArray(fromApi?.jobs) && fromApi.jobs.length) {
    return fromApi.jobs.map(normalizeV2Job);
  }

  const db = getPool();
  try {
    const result = await db.query(
      `SELECT j.user_id, j.profile_id, j.state, j.updated_at, u.email, u.name
       FROM v2_letterbot_jobs j
       LEFT JOIN users u ON u.id = j.user_id
       WHERE j.is_running = TRUE
       ORDER BY j.updated_at DESC`,
    );
    return result.rows.map((row) => {
      const state = parseState(row.state);
      const progress =
        state.progress && typeof state.progress === "object" ? state.progress : {};
      const dailyTotal = dreamDailyTotalFromState(state);
      const sent = Number.isFinite(Number(progress.sent)) ? Number(progress.sent) : null;
      const pct = Number(progress.percent);
      return {
        userId: Number(row.user_id),
        profileId: String(row.profile_id || "default"),
        operatorEmail: String(row.email || ""),
        operatorName: String(row.name || ""),
        sessionActive: Boolean(state.sessionActive),
        isPaused: Boolean(state.isPaused),
        filter: String(progress.filter || state.filter || ""),
        percent: Number.isFinite(pct) ? pct : null,
        sent,
        total: dailyTotal,
        daySent: dailyTotal,
        dailyTotal,
        statusMessage: String(state.statusMessage || ""),
        updatedAt: state.updatedAt || row.updated_at || null,
        source: "v2",
      };
    });
  } catch (error) {
    if (/v2_letterbot_jobs|does not exist/i.test(String(error?.message || error))) {
      return [];
    }
    throw error;
  }
}

/** V2 Dream Daily Total rows for Mailings calendar (letterbot product). */
export async function listV2LetterbotDailyByProfile(dayKey) {
  const day = String(dayKey || "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return [];

  const fromApi = await fetchV2Json(
    `/letterbot/admin/letters-by-profile?date=${encodeURIComponent(day)}`,
  );
  if (Array.isArray(fromApi?.profiles) && fromApi.profiles.length) {
    return fromApi.profiles
      .map((row) => ({
        profileId: String(row.profileId || ""),
        userId: null,
        letters: Math.trunc(Number(row.letterbot) || 0),
      }))
      .filter((row) => row.profileId && row.letters > 0);
  }

  const db = getPool();
  try {
    const result = await db.query(
      `SELECT profile_id, user_id, letters
       FROM v2_mailing_daily_letters
       WHERE day_key = $1::date AND product = 'letterbot'`,
      [day],
    );
    return result.rows.map((row) => ({
      profileId: String(row.profile_id || ""),
      userId: row.user_id != null ? Number(row.user_id) : null,
      letters: Math.trunc(Number(row.letters) || 0),
    }));
  } catch (error) {
    if (/v2_mailing_daily_letters|does not exist/i.test(String(error?.message || error))) {
      return [];
    }
    throw error;
  }
}

export async function markV2LetterBotStopped(userId, profileId) {
  const db = getPool();
  try {
    await db.query(
      `UPDATE v2_letterbot_jobs
       SET is_running = FALSE, updated_at = NOW()
       WHERE user_id = $1 AND profile_id = $2`,
      [Number(userId), String(profileId || "default")],
    );
  } catch (_) {}
}

export async function requestV2OperatorShiftDisconnect(userId, profileId) {
  const db = getPool();
  try {
    await db.query(
      `INSERT INTO v2_operator_shift_commands (user_id, profile_id, disconnect_requested_at, updated_at)
       VALUES ($1, $2, NOW(), NOW())
       ON CONFLICT (user_id, profile_id) DO UPDATE SET
         disconnect_requested_at = NOW(),
         updated_at = NOW()`,
      [Number(userId), String(profileId || "default")],
    );
  } catch (_) {}
}

/** Best-effort stop of the live V2 in-memory worker (needs DIRECTOR_SYNC_SECRET). */
export async function stopV2LetterBotRemote(userId, profileId, { disconnect = false } = {}) {
  const base = v2ApiBase();
  const secret = directorSyncSecret();
  if (!base || !secret) return { ok: false, skipped: true };
  const path = disconnect ? "/letterbot/admin/disconnect-shift" : "/letterbot/admin/stop";
  try {
    const response = await fetch(`${base}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-director-sync": secret,
      },
      body: JSON.stringify({ userId: Number(userId), profileId: String(profileId || "default") }),
      signal: AbortSignal.timeout(15000),
    });
    const data = await response.json().catch(() => ({}));
    return { ok: response.ok && data?.ok !== false, status: response.status, data };
  } catch (error) {
    return { ok: false, error: error?.message || String(error) };
  }
}

export { dreamDailyTotalFromState };
