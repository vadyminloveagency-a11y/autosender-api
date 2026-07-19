/**
 * Director LetterBot routes that run on APP_ROLE=admin (auto-deploy).
 * Merges classic workers proxy data with V2 tables on the shared DB.
 */
import express from "express";
import { adminMiddleware } from "./auth.js";
import { mapAgencyProfilesByFemaleId } from "./agencyProfileStore.js";
import {
  ensureMailingDailyTables,
  kyivDayKey,
  listMailingDailyByProfile,
  listMailingDailyMonthTotals,
} from "./mailingDailyStore.js";
import {
  listV2ActiveDirectorJobs,
  listV2LetterbotDailyByProfile,
  markV2LetterBotStopped,
  requestV2OperatorShiftDisconnect,
  stopV2LetterBotRemote,
} from "./v2DirectorMerge.js";

const router = express.Router();

function workersBase() {
  return String(process.env.WORKERS_API_URL || "").trim().replace(/\/+$/, "");
}

async function fetchWorkersJson(req, pathAndQuery) {
  const base = workersBase();
  if (!base) return null;
  const auth = req.headers.authorization || "";
  try {
    const response = await fetch(`${base}${pathAndQuery}`, {
      method: "GET",
      headers: {
        accept: "application/json",
        ...(auth ? { authorization: auth } : {}),
      },
      signal: AbortSignal.timeout(25000),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) return null;
    return data;
  } catch (_) {
    return null;
  }
}

async function postWorkersJson(req, path, body) {
  const base = workersBase();
  if (!base) return null;
  const auth = req.headers.authorization || "";
  try {
    const response = await fetch(`${base}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        ...(auth ? { authorization: auth } : {}),
      },
      body: JSON.stringify(body || {}),
      signal: AbortSignal.timeout(25000),
    });
    return await response.json().catch(() => ({}));
  } catch (error) {
    return { ok: false, error: error?.message || String(error) };
  }
}

function attachProfileMeta(job, profileMap) {
  const id = Number(job?.profileId) || 0;
  const meta = id ? profileMap.get(id) : null;
  return {
    ...job,
    displayName: meta?.displayName || job.displayName || "",
    dreamUsername: meta?.dreamUsername || job.dreamUsername || "",
    photoUrl:
      meta?.photoUrl ||
      job.photoUrl ||
      (id ? `https://profile-photos-cdn.dream-singles.com/im${id}_small.jpg` : ""),
  };
}

function mergeRunningJobs(classicJobs, v2Jobs, profileMap) {
  const byKey = new Map();
  for (const job of classicJobs || []) {
    const key = `${Number(job.userId)}:${String(job.profileId || "default")}`;
    byKey.set(key, attachProfileMeta({ ...job, source: job.source || "classic" }, profileMap));
  }
  for (const job of v2Jobs || []) {
    const key = `${Number(job.userId)}:${String(job.profileId || "default")}`;
    const merged = attachProfileMeta({ ...job, source: "v2" }, profileMap);
    const existing = byKey.get(key);
    const v2Total = Number(merged.dailyTotal) || Number(merged.daySent) || 0;
    if (!existing) {
      byKey.set(key, {
        ...merged,
        daySent: v2Total > 0 ? v2Total : merged.daySent,
        dailyTotal: v2Total > 0 ? v2Total : merged.dailyTotal,
      });
      continue;
    }
    const classicTotal = Number(existing.dailyTotal) || Number(existing.daySent) || 0;
    const best = Math.max(v2Total, classicTotal);
    byKey.set(key, {
      ...existing,
      ...merged,
      dailyTotal: best > 0 ? best : existing.dailyTotal,
      daySent: best > 0 ? best : existing.daySent,
      percent: merged.percent ?? existing.percent,
      sent: merged.sent ?? existing.sent,
      filter: merged.filter || existing.filter,
      statusMessage: merged.statusMessage || existing.statusMessage,
      source: "v2",
    });
  }
  return [...byKey.values()].sort(
    (a, b) => (Number(b.updatedAt) || 0) - (Number(a.updatedAt) || 0),
  );
}

router.get("/admin/running", adminMiddleware, async (req, res) => {
  try {
    const [classic, v2Jobs, profileMap] = await Promise.all([
      fetchWorkersJson(req, "/letterbot/admin/running"),
      listV2ActiveDirectorJobs().catch(() => []),
      mapAgencyProfilesByFemaleId().catch(() => new Map()),
    ]);
    const jobs = mergeRunningJobs(classic?.jobs || [], v2Jobs, profileMap);
    return res.json({ ok: true, jobs, mergedV2: true, v2Count: v2Jobs.length });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: error?.message || String(error),
      jobs: [],
    });
  }
});

router.get("/admin/letters-by-profile", adminMiddleware, async (req, res) => {
  try {
    await ensureMailingDailyTables();
    const today = kyivDayKey();
    let date = String(req.query?.date || today).slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) date = today;
    const [yStr, mStr] = date.split("-");
    const year = Number(req.query?.year) || Number(yStr);
    const month = Number(req.query?.month) || Number(mStr);
    const syncDream = String(req.query?.syncDream || "");
    const qs = new URLSearchParams({
      date,
      year: String(year),
      month: String(month),
    });
    if (syncDream) qs.set("syncDream", syncDream);

    const [classic, classicRows, v2Daily, v2Jobs, monthDays, profileMap] = await Promise.all([
      fetchWorkersJson(req, `/letterbot/admin/letters-by-profile?${qs}`),
      listMailingDailyByProfile(date).catch(() => []),
      listV2LetterbotDailyByProfile(date).catch(() => []),
      date === today ? listV2ActiveDirectorJobs().catch(() => []) : Promise.resolve([]),
      listMailingDailyMonthTotals(year, month).catch(() => classic?.monthDays || []),
      mapAgencyProfilesByFemaleId().catch(() => new Map()),
    ]);

    const byProfile = new Map();
    const seedProfiles = Array.isArray(classic?.profiles) ? classic.profiles : [];
    for (const row of seedProfiles) {
      const key = String(row.profileId || "");
      if (!key) continue;
      byProfile.set(key, {
        profileId: key,
        displayName: row.displayName || "",
        dreamUsername: row.dreamUsername || "",
        photoUrl: row.photoUrl || "",
        operatorName: row.operatorName || "",
        operatorEmail: row.operatorEmail || "",
        letterbot: Number(row.letterbot) || 0,
        read: Number(row.read) || 0,
        online: Number(row.online) || 0,
        total: Number(row.total) || 0,
      });
    }

    for (const row of classicRows) {
      const key = String(row.profileId || "");
      if (!key) continue;
      let entry = byProfile.get(key);
      if (!entry) {
        const idNum = Number(key) || 0;
        const meta = idNum ? profileMap.get(idNum) : null;
        entry = {
          profileId: key,
          displayName: meta?.displayName || "",
          dreamUsername: meta?.dreamUsername || "",
          photoUrl:
            meta?.photoUrl ||
            (idNum ? `https://profile-photos-cdn.dream-singles.com/im${idNum}_small.jpg` : ""),
          operatorName: meta?.operatorName || "",
          operatorEmail: meta?.operatorEmail || "",
          letterbot: 0,
          read: 0,
          online: 0,
          total: 0,
        };
        byProfile.set(key, entry);
      }
      if (row.product === "online") entry.online = Math.max(entry.online, row.letters || 0);
      else if (row.product === "read") entry.read = Math.max(entry.read, row.letters || 0);
      else entry.letterbot = Math.max(entry.letterbot, row.letters || 0);
      entry.total = entry.letterbot + entry.read + entry.online;
    }

    for (const row of v2Daily) {
      const key = String(row.profileId || "");
      if (!key || !(row.letters > 0)) continue;
      let entry = byProfile.get(key);
      if (!entry) {
        const idNum = Number(key) || 0;
        const meta = idNum ? profileMap.get(idNum) : null;
        entry = {
          profileId: key,
          displayName: meta?.displayName || "",
          dreamUsername: meta?.dreamUsername || "",
          photoUrl:
            meta?.photoUrl ||
            (idNum ? `https://profile-photos-cdn.dream-singles.com/im${idNum}_small.jpg` : ""),
          operatorName: meta?.operatorName || "",
          operatorEmail: meta?.operatorEmail || "",
          letterbot: 0,
          read: 0,
          online: 0,
          total: 0,
        };
        byProfile.set(key, entry);
      }
      if (row.letters > (Number(entry.letterbot) || 0)) {
        entry.letterbot = row.letters;
        entry.total = entry.letterbot + entry.read + entry.online;
      }
    }

    for (const job of v2Jobs) {
      const liveTotal = Number(job.dailyTotal) || 0;
      if (!(liveTotal > 0)) continue;
      const key = String(job.profileId || "");
      if (!key) continue;
      let entry = byProfile.get(key);
      if (!entry) {
        const idNum = Number(key) || 0;
        const meta = idNum ? profileMap.get(idNum) : null;
        entry = {
          profileId: key,
          displayName: meta?.displayName || "",
          dreamUsername: meta?.dreamUsername || "",
          photoUrl:
            meta?.photoUrl ||
            (idNum ? `https://profile-photos-cdn.dream-singles.com/im${idNum}_small.jpg` : ""),
          operatorName: job.operatorName || meta?.operatorName || "",
          operatorEmail: job.operatorEmail || meta?.operatorEmail || "",
          letterbot: 0,
          read: 0,
          online: 0,
          total: 0,
        };
        byProfile.set(key, entry);
      }
      if (liveTotal > (Number(entry.letterbot) || 0)) {
        entry.letterbot = liveTotal;
        entry.total = entry.letterbot + entry.read + entry.online;
      }
      if (job.operatorName) entry.operatorName = job.operatorName;
      if (job.operatorEmail) entry.operatorEmail = job.operatorEmail;
    }

    const profiles = [...byProfile.values()]
      .map((entry) => attachProfileMeta(entry, profileMap))
      .sort((a, b) => {
        if (b.total !== a.total) return b.total - a.total;
        return String(a.displayName || a.profileId).localeCompare(
          String(b.displayName || b.profileId),
          "en",
        );
      });

    return res.json({
      ok: true,
      date,
      year,
      month,
      today,
      monthDays: Array.isArray(classic?.monthDays) ? classic.monthDays : monthDays,
      profiles,
      syncedDream: Boolean(classic?.syncedDream),
      mergedV2: true,
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: error?.message || String(error),
      profiles: [],
      monthDays: [],
    });
  }
});

router.post("/admin/stop", adminMiddleware, async (req, res) => {
  const userId = Number(req.body?.userId);
  const profileId = String(req.body?.profileId || "default");
  if (!userId) {
    return res.status(400).json({ ok: false, error: "userId is required" });
  }
  const classic = await postWorkersJson(req, "/letterbot/admin/stop", req.body);
  await markV2LetterBotStopped(userId, profileId).catch(() => {});
  await stopV2LetterBotRemote(userId, profileId, { disconnect: false }).catch(() => {});
  return res.json({
    ok: true,
    stopped: true,
    classic: classic || null,
  });
});

router.post("/admin/disconnect-shift", adminMiddleware, async (req, res) => {
  const userId = Number(req.body?.userId);
  const profileId = String(req.body?.profileId || "default");
  if (!userId) {
    return res.status(400).json({ ok: false, error: "userId is required" });
  }
  const classic = await postWorkersJson(req, "/letterbot/admin/disconnect-shift", req.body);
  await markV2LetterBotStopped(userId, profileId).catch(() => {});
  await requestV2OperatorShiftDisconnect(userId, profileId).catch(() => {});
  await stopV2LetterBotRemote(userId, profileId, { disconnect: true }).catch(() => {});
  return res.json({
    ok: true,
    stopped: true,
    disconnectRequested: true,
    classic: classic || null,
  });
});

export default router;
