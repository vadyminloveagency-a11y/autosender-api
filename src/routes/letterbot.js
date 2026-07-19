import express from "express";
import { adminMiddleware, authMiddleware } from "../auth.js";
import { decryptSecret, encryptSecret, maskUsername } from "../cryptoUtil.js";
import { withDreamGate } from "../dreamGate.js";
import { dreamLogin } from "../dreamLogin.js";
import { LetterBotWorker } from "../letterBotWorker.js";
import {
  deleteDreamCredentials,
  ensureLetterBotTables,
  getDreamCredentials,
  getLetterBotJob,
  getOperatorShiftDisconnectRequest,
  getUserById,
  listDreamCredentialsForProfiles,
  listLetterBotJobDailyTotals,
  listRunningLetterBotJobs,
  listRunningLetterBotJobsWithUsers,
  markLetterBotJobStopped,
  clearOperatorShiftDisconnect,
  requestOperatorShiftDisconnect,
  upsertDreamCredentials,
  upsertLetterBotJob,
} from "../letterbotStore.js";

import { mapAgencyProfilesByFemaleId } from "../agencyProfileStore.js";
import {
  ensureMailingDailyTables,
  kyivDayKey,
  listMailingDailyByProfile,
  listMailingDailyMonthTotals,
  setMailingDailyLettersAbsolute,
} from "../mailingDailyStore.js";
import {
  listV2ActiveDirectorJobs,
  listV2LetterbotDailyByProfile,
  markV2LetterBotStopped,
  requestV2OperatorShiftDisconnect,
  stopV2LetterBotRemote,
  dreamDailyTotalFromState,
} from "../v2DirectorMerge.js";
const router = express.Router();

/** @type {Map<string, LetterBotWorker>} */
const workers = new Map();
/** @type {Map<string, object>} */
const lastStates = new Map();

function nicePercent(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  const rounded = Math.round(n * 10) / 10;
  return Number.isInteger(rounded) ? rounded : Number(rounded.toFixed(1));
}

function attachProfileMeta(job, profileMap) {
  const id = Number(job?.profileId) || 0;
  const meta = id ? profileMap.get(id) : null;
  return {
    ...job,
    displayName: meta?.displayName || "",
    dreamUsername: meta?.dreamUsername || "",
    photoUrl: meta?.photoUrl || (id ? `https://profile-photos-cdn.dream-singles.com/im${id}_small.jpg` : ""),
  };
}

function idleState(profileId) {
  return {
    connected: false,
    authenticating: false,
    sending: false,
    buttonLabel: "Start",
    filter: "onlineOnly",
    progress: null,
    previewHtml: "",
    previewText: "",
    previewPhoto: "",
    previewVideo: "",
    previewVideoPoster: "",
    error: "",
    statusMessage: "LetterBot closed",
    sessionActive: false,
    isPaused: false,
    updatedAt: Date.now(),
    profileId: String(profileId || "default"),
  };
}

function cookiesToHeader(cookies, cookieHeader) {
  if (cookieHeader && String(cookieHeader).trim()) return String(cookieHeader).trim();
  if (!Array.isArray(cookies)) return "";
  return cookies
    .map((c) => {
      const name = c?.name;
      const value = c?.value;
      if (!name) return "";
      return `${name}=${value ?? ""}`;
    })
    .filter(Boolean)
    .join("; ");
}

function profileIdFrom(req) {
  return String(
    req.body?.profileId ||
      req.query?.profileId ||
      req.headers["x-profile-id"] ||
      "default",
  );
}

function workerKey(userId, profileId) {
  return `${userId || "anon"}:${profileId}`;
}

async function persistJob(payload) {
  if (!payload?.userId) return;
  await upsertLetterBotJob(payload);
}

function makeCredentialsProvider(userId, profileId) {
  return async () => {
    const row = await getDreamCredentials(userId, profileId);
    if (!row?.username || !row?.password_enc) return null;
    return {
      username: row.username,
      password: decryptSecret(row.password_enc),
    };
  };
}

function getWorkerForUser(userId, profileId) {
  const key = workerKey(userId, profileId);
  let worker = workers.get(key);
  if (!worker) {
    worker = new LetterBotWorker(profileId, {
      ownerUserId: userId,
      onStateChange(state) {
        lastStates.set(key, state);
      },
      onPersist: persistJob,
      credentialsProvider: makeCredentialsProvider(userId, profileId),
    });
    workers.set(key, worker);
  } else {
    if (worker.ownerUserId == null) worker.ownerUserId = userId;
    worker.setCredentialsProvider(makeCredentialsProvider(userId, profileId));
  }
  return worker;
}

function getWorker(req, profileId) {
  return getWorkerForUser(req.user?.id, profileId);
}

async function ensureWorkerSession(worker, { cookieHeader, dreamJwt } = {}) {
  if (cookieHeader) worker.setCookieHeader(cookieHeader);
  if (dreamJwt) worker.setDreamJwt(dreamJwt);

  if (worker.cookieHeader || worker.jwtCache?.token) {
    try {
      await worker.fetchLetterBotJwt(true, { allowRelogin: true });
      return;
    } catch (error) {
      // Fall through to explicit credential login.
      if (!worker.credentialsProvider) throw error;
    }
  }

  await worker.reloginFromCredentials();
  await worker.fetchLetterBotJwt(true, { allowRelogin: false });
}

router.get("/credentials", authMiddleware, async (req, res) => {
  const profileId = profileIdFrom(req);
  try {
    const row = await getDreamCredentials(req.user.id, profileId);
    if (!row) {
      return res.json({
        ok: true,
        configured: false,
        username: "",
        usernameMasked: "",
        profileId,
      });
    }
    return res.json({
      ok: true,
      configured: true,
      username: row.username,
      usernameMasked: maskUsername(row.username),
      profileId,
      updatedAt: row.updated_at,
    });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error?.message || String(error) });
  }
});

router.post("/credentials", authMiddleware, async (req, res) => {
  const profileId = profileIdFrom(req);
  const username = String(req.body?.username || "").trim();
  const password = String(req.body?.password || "");
  if (!username || !password) {
    return res.status(400).json({
      ok: false,
      error: "Dream username and password are required",
    });
  }
  try {
    // Prove credentials work before storing.
    const { cookieHeader } = await dreamLogin(username, password);
    await upsertDreamCredentials({
      userId: req.user.id,
      profileId,
      username,
      passwordEnc: encryptSecret(password),
    });
    const worker = getWorker(req, profileId);
    worker.setCookieHeader(cookieHeader);
    worker.jwtCache = { token: "", expMs: 0 };
    try {
      await worker.fetchLetterBotJwt(true, { allowRelogin: false });
    } catch (_) {
      // Cookies saved; JWT can be fetched on Start.
    }
    await persistJob({
      userId: req.user.id,
      profileId,
      cookieHeader: worker.cookieHeader,
      selection: worker.userSelection,
      state: worker.getState(),
      isRunning: Boolean(worker.senderRunning && worker.state.sessionActive),
    });
    return res.json({
      ok: true,
      configured: true,
      username,
      usernameMasked: maskUsername(username),
      profileId,
      message: "Dream credentials saved — cloud mailing can re-login without Chrome",
    });
  } catch (error) {
    return res.status(400).json({
      ok: false,
      error: error?.message || String(error),
    });
  }
});

router.delete("/credentials", authMiddleware, async (req, res) => {
  const profileId = profileIdFrom(req);
  try {
    await deleteDreamCredentials(req.user.id, profileId);
    return res.json({ ok: true, configured: false, profileId });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error?.message || String(error) });
  }
});

router.post("/session", authMiddleware, async (req, res) => {
  const profileId = profileIdFrom(req);
  const header = cookiesToHeader(req.body?.cookies, req.body?.cookieHeader);
  const dreamJwt = String(req.body?.dreamJwt || "").trim();
  const worker = getWorker(req, profileId);
  const hasCreds = Boolean(await getDreamCredentials(req.user.id, profileId));
  if (!header && !dreamJwt && !hasCreds) {
    return res.status(400).json({
      ok: false,
      error: "Save Dream login in LetterBot, or open dream-singles.com while logged in",
      state: idleState(profileId),
    });
  }
  try {
    await ensureWorkerSession(worker, { cookieHeader: header, dreamJwt });
  } catch (error) {
    return res.status(400).json({
      ok: false,
      error: error?.message || String(error),
      state: worker.getState(),
    });
  }
  lastStates.set(workerKey(req.user.id, profileId), worker.getState());
  await persistJob({
    userId: req.user.id,
    profileId,
    cookieHeader: worker.cookieHeader,
    selection: worker.userSelection,
    state: worker.getState(),
    isRunning: Boolean(worker.senderRunning && worker.state.sessionActive),
  });
  return res.json({ ok: true, state: worker.getState() });
});

function stateFromJobRow(row, profileId) {
  const prev = row?.state && typeof row.state === "object" ? row.state : {};
  return {
    ...idleState(profileId || row?.profile_id || "default"),
    ...prev,
    sessionActive: true,
    isPaused: Boolean(prev.isPaused),
    buttonLabel: prev.isPaused ? "Start" : "Stop",
    statusMessage: prev.statusMessage || (prev.isPaused ? "Paused" : "Sending"),
    profileId: String(profileId || row?.profile_id || "default"),
    updatedAt: Date.now(),
  };
}

async function resolveLiveState(userId, profileId) {
  // Strict per-anketa: never leak another profile's mailing into this status.
  const pid = String(profileId || "default");
  const preferredKey = workerKey(userId, pid);
  const preferred = workers.get(preferredKey);
  if (preferred) return preferred.getState();

  const cached = lastStates.get(preferredKey);
  if (cached) return cached;

  try {
    const row = await getLetterBotJob(userId, pid);
    if (row?.is_running) return stateFromJobRow(row, pid);
    if (row?.state && typeof row.state === "object") {
      return {
        ...idleState(pid),
        ...row.state,
        sessionActive: false,
        sending: false,
        buttonLabel: "Start",
        profileId: pid,
        updatedAt: Date.now(),
      };
    }
  } catch (_) {}

  return idleState(pid);
}

async function stopWorkerForProfile(userId, profileId, { complete = false } = {}) {
  const pid = String(profileId || "default");
  const key = workerKey(userId, pid);
  let worker = workers.get(key);
  let cookieHeader = "";
  if (!worker) {
    try {
      const row = await getLetterBotJob(userId, pid);
      if (row?.is_running) {
        worker = getWorkerForUser(userId, pid);
        cookieHeader = row.cookie_header || "";
        if (cookieHeader) worker.setCookieHeader(cookieHeader);
        worker.senderRunning = true;
        worker.state.sessionActive = true;
      }
    } catch (_) {}
  } else {
    cookieHeader = worker.cookieHeader || "";
  }
  let state = idleState(pid);
  if (worker) {
    try {
      // Director force-stop: tell Dream WS to stop even if socket was down.
      // Use numeric readyState — WebSocket may not be in scope in this module.
      if (worker.socket?.readyState !== 1 && cookieHeader) {
        try {
          await ensureWorkerSession(worker, { cookieHeader });
        } catch (_) {}
      }
      state = await worker.stop({ complete });
    } catch (_) {
      state = idleState(pid);
    }
  }
  await markLetterBotJobStopped(userId, pid);
  lastStates.set(key, state);
  await persistJob({
    userId,
    profileId: pid,
    cookieHeader: worker?.cookieHeader || cookieHeader || "",
    selection: worker?.userSelection || {},
    state,
    isRunning: false,
  });
  return {
    ...state,
    sessionActive: false,
    isPaused: false,
    sending: false,
    buttonLabel: "Start",
    statusMessage: complete ? "First Start complete" : "Stopped",
    progress: null,
    profileId: pid,
  };
}

function summarizeMailingJob(userId, profileId, state, user = {}) {
  const progress = state?.progress && typeof state.progress === "object" ? state.progress : {};
  const sent = Number.isFinite(Number(progress.sent)) ? Number(progress.sent) : null;
  // Dream WS field `total` is Daily Total — do not use it as campaign size for %.
  const pct = Number(progress.percent);
  const daySent = Number.isFinite(Number(state?.daySent)) ? Number(state.daySent) : null;
  const dailyTotal = dreamDailyTotalFromState(state);
  return {
    userId: Number(userId),
    profileId: String(profileId || "default"),
    operatorEmail: String(user.email || ""),
    operatorName: String(user.name || ""),
    sessionActive: Boolean(state?.sessionActive),
    isPaused: Boolean(state?.isPaused),
    filter: String(progress.filter || state?.filter || ""),
    percent: nicePercent(pct),
    sent,
    total: dailyTotal,
    daySent,
    dailyTotal,
    statusMessage: String(state?.statusMessage || ""),
    updatedAt: state?.updatedAt || null,
  };
}

async function listActiveMailingJobs() {
  const byKey = new Map();
  const profileMap = await mapAgencyProfilesByFemaleId().catch(() => new Map());
  const dailyRows = await listMailingDailyByProfile(kyivDayKey()).catch(() => []);
  const dailyLetterBotByProfile = new Map(
    dailyRows
      .filter((row) => row.product === "letterbot")
      .map((row) => [String(row.profileId), Number(row.letters) || 0]),
  );

  const rows = await listRunningLetterBotJobsWithUsers();
  for (const row of rows) {
    const userId = Number(row.user_id);
    const profileId = String(row.profile_id || "default");
    const key = workerKey(userId, profileId);
    const live = workers.get(key);
    const state = live ? live.getState() : row.state || {};
    byKey.set(
      key,
      attachProfileMeta(
        summarizeMailingJob(userId, profileId, state, {
          email: row.email,
          name: row.name,
        }),
        profileMap,
      ),
    );
  }

  for (const [key, worker] of workers) {
    if (byKey.has(key)) continue;
    const state = worker.getState();
    if (!state.sessionActive && !worker.senderRunning) continue;
    const colon = key.indexOf(":");
    if (colon <= 0) continue;
    const userId = Number(key.slice(0, colon));
    const profileId = key.slice(colon + 1);
    const user = await getUserById(userId);
    byKey.set(
      key,
      attachProfileMeta(
        summarizeMailingJob(userId, profileId, state, {
          email: user?.email || "",
          name: user?.name || "",
        }),
        profileMap,
      ),
    );
  }

  // Merge AutoSender V2 cloud LetterBot jobs (same director cabinet).
  const v2Jobs = await listV2ActiveDirectorJobs().catch(() => []);
  for (const job of v2Jobs) {
    const key = `${job.userId}:${job.profileId}`;
    const existing = byKey.get(key);
    const merged = attachProfileMeta(job, profileMap);
    if (!existing) {
      byKey.set(key, merged);
      continue;
    }
    // Prefer V2 Dream Daily Total when it is higher / present.
    const v2Total = Number(merged.dailyTotal) || 0;
    const classicTotal = Number(existing.dailyTotal) || Number(existing.daySent) || 0;
    byKey.set(key, {
      ...existing,
      ...merged,
      dailyTotal: v2Total > 0 ? v2Total : existing.dailyTotal,
      daySent: v2Total > 0 ? v2Total : existing.daySent,
      percent: merged.percent ?? existing.percent,
      sent: merged.sent ?? existing.sent,
      filter: merged.filter || existing.filter,
      statusMessage: merged.statusMessage || existing.statusMessage,
      source: "v2",
    });
    void classicTotal;
  }

  const v2Daily = await listV2LetterbotDailyByProfile(kyivDayKey()).catch(() => []);
  for (const row of v2Daily) {
    if (!(row.letters > 0)) continue;
    const prev = dailyLetterBotByProfile.get(String(row.profileId)) || 0;
    if (row.letters > prev) dailyLetterBotByProfile.set(String(row.profileId), row.letters);
  }

  return [...byKey.values()].map((job) => {
    // Prefer Dream Daily Total; fall back to AutoSender day count / DB.
    const dreamTotal = Number(job.dailyTotal) || 0;
    const lettersToday =
      dreamTotal > 0
        ? dreamTotal
        : Math.max(
            Number(job.daySent) || 0,
            dailyLetterBotByProfile.get(String(job.profileId)) || 0,
          );
    if (dreamTotal > 0) {
      void setMailingDailyLettersAbsolute({
        dayKey: kyivDayKey(),
        profileId: job.profileId,
        product: "letterbot",
        userId: job.userId,
        letters: dreamTotal,
      }).catch(() => {});
    }
    return {
      ...job,
      daySent: lettersToday > 0 ? lettersToday : null,
      dailyTotal: dreamTotal > 0 ? dreamTotal : job.dailyTotal,
    };
  }).sort((a, b) => {
    const au = Number(a.updatedAt) || 0;
    const bu = Number(b.updatedAt) || 0;
    return bu - au;
  });
}

router.get("/status", authMiddleware, async (req, res) => {
  const profileId = profileIdFrom(req);
  const state = await resolveLiveState(req.user.id, profileId);
  return res.json({ ok: true, state });
});

router.post("/start", authMiddleware, async (req, res) => {
  const profileId = profileIdFrom(req);
  const header = cookiesToHeader(req.body?.cookies, req.body?.cookieHeader);
  const dreamJwt = String(req.body?.dreamJwt || "").trim();
  // Each anketa runs independently — do not stop other profiles' mailings.
  const worker = getWorker(req, profileId);
  const hasCreds = Boolean(await getDreamCredentials(req.user.id, profileId));
  if (!header && !dreamJwt && !hasCreds && !worker.cookieHeader && !worker.jwtCache?.token) {
    return res.status(400).json({
      ok: false,
      error:
        "Save Dream login/password in LetterBot (Cloud login), or open dream-singles.com while logged in",
      state: worker.getState(),
    });
  }
  try {
    await ensureWorkerSession(worker, { cookieHeader: header, dreamJwt });
    const state = await worker.start(req.body?.selection || {});
    worker.startKeepAlive();
    await persistJob({
      userId: req.user.id,
      profileId,
      cookieHeader: worker.cookieHeader,
      selection: worker.userSelection,
      state,
      isRunning: true,
    });
    return res.json({ ok: true, state });
  } catch (error) {
    return res.status(400).json({
      ok: false,
      error: error?.message || String(error),
      state: worker.getState(),
    });
  }
});

router.post("/pause", authMiddleware, async (req, res) => {
  const profileId = profileIdFrom(req);
  const worker = getWorker(req, profileId);
  try {
    return res.json({ ok: true, state: await worker.pause() });
  } catch (error) {
    return res.status(400).json({
      ok: false,
      error: error?.message || String(error),
      state: worker.getState(),
    });
  }
});

router.post("/resume", authMiddleware, async (req, res) => {
  const profileId = profileIdFrom(req);
  const worker = getWorker(req, profileId);
  try {
    return res.json({ ok: true, state: await worker.resume() });
  } catch (error) {
    return res.status(400).json({
      ok: false,
      error: error?.message || String(error),
      state: worker.getState(),
    });
  }
});

router.post("/stop", authMiddleware, async (req, res) => {
  const profileId = profileIdFrom(req);
  try {
    const state = await stopWorkerForProfile(req.user.id, profileId, {
      complete: Boolean(req.body?.complete),
    });
    return res.json({ ok: true, state });
  } catch (error) {
    return res.status(400).json({
      ok: false,
      error: error?.message || String(error),
      state: idleState(profileId),
    });
  }
});

router.post("/connect", authMiddleware, async (req, res) => {
  const profileId = profileIdFrom(req);
  const header = cookiesToHeader(req.body?.cookies, req.body?.cookieHeader);
  const dreamJwt = String(req.body?.dreamJwt || "").trim();
  const worker = getWorker(req, profileId);
  try {
    await ensureWorkerSession(worker, { cookieHeader: header, dreamJwt });
    return res.json({ ok: true, state: await worker.connect() });
  } catch (error) {
    return res.status(400).json({
      ok: false,
      error: error?.message || String(error),
      state: worker.getState(),
    });
  }
});

/** Director cabinet — list all operators with active cloud LetterBot mailings. */
router.get("/admin/running", adminMiddleware, async (req, res) => {
  try {
    const jobs = await listActiveMailingJobs();
    return res.json({ ok: true, jobs });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: error?.message || String(error),
      jobs: [],
    });
  }
});

/** Director cabinet — letters by questionnaire for a day + month calendar totals. */
router.get("/admin/letters-by-profile", adminMiddleware, async (req, res) => {
  try {
    await ensureMailingDailyTables();
    const today = kyivDayKey();
    let date = String(req.query?.date || today).slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) date = today;

    const [yStr, mStr] = date.split("-");
    const year = Number(req.query?.year) || Number(yStr);
    const month = Number(req.query?.month) || Number(mStr);
    const syncDream =
      date === today &&
      ["1", "true", "yes"].includes(String(req.query?.syncDream || "").toLowerCase());

    if (date === today) {
      await mergeKnownDreamDailyTotals(today).catch(() => {});
    }
    if (syncDream) {
      await syncDreamLetterBotDailyTotals({ dayKey: today }).catch(() => {});
    }

    const [rows, monthDays, profileMap] = await Promise.all([
      listMailingDailyByProfile(date),
      listMailingDailyMonthTotals(year, month),
      mapAgencyProfilesByFemaleId().catch(() => new Map()),
    ]);

    const byProfile = new Map();
    for (const row of rows) {
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
      if (row.product === "online") entry.online += row.letters;
      else if (row.product === "read") entry.read += row.letters;
      else entry.letterbot += row.letters;
      entry.total = entry.letterbot + entry.read + entry.online;
      if (row.operatorName || row.operatorEmail) {
        entry.operatorName = row.operatorName || entry.operatorName;
        entry.operatorEmail = row.operatorEmail || entry.operatorEmail;
      }
    }

    // Overlay V2 Dream Daily Totals into LETTERBOT column (same director cabinet).
    const v2Daily = await listV2LetterbotDailyByProfile(date).catch(() => []);
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

    // Live V2 running jobs may be ahead of the daily table — prefer their WS total.
    if (date === today) {
      const v2Jobs = await listV2ActiveDirectorJobs().catch(() => []);
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
            displayName: meta?.displayName || job.displayName || "",
            dreamUsername: meta?.dreamUsername || "",
            photoUrl:
              meta?.photoUrl ||
              job.photoUrl ||
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
    }

    const profiles = [...byProfile.values()].sort((a, b) => {
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
      monthDays,
      profiles,
      syncedDream: Boolean(syncDream),
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

/** Persist already-known Dream TOTAL DAY from live workers / job state. */
async function mergeKnownDreamDailyTotals(dayKey) {
  const day = String(dayKey || kyivDayKey()).slice(0, 10);
  const writes = [];

  for (const [key, worker] of workers) {
    const total = Number(worker?.state?.dailyTotal);
    if (!Number.isFinite(total) || total <= 0) continue;
    const totalDay = String(worker.state.dailyTotalDayKey || day).slice(0, 10);
    if (totalDay && totalDay !== day) continue;
    const colon = String(key).indexOf(":");
    if (colon <= 0) continue;
    const userId = Number(key.slice(0, colon));
    const profileId = key.slice(colon + 1);
    if (!/^\d+$/.test(profileId)) continue;
    writes.push(
      setMailingDailyLettersAbsolute({
        dayKey: day,
        profileId,
        product: "letterbot",
        userId,
        letters: total,
      }),
    );
  }

  const jobTotals = await listLetterBotJobDailyTotals().catch(() => []);
  for (const row of jobTotals) {
    if (!Number.isFinite(row.dailyTotal) || row.dailyTotal <= 0) continue;
    if (row.dailyTotalDayKey && row.dailyTotalDayKey !== day) continue;
    writes.push(
      setMailingDailyLettersAbsolute({
        dayKey: day,
        profileId: row.profileId,
        product: "letterbot",
        userId: row.userId,
        letters: row.dailyTotal,
      }),
    );
  }

  if (writes.length) await Promise.allSettled(writes);
}

/**
 * Login to Dream LetterBot for profiles with saved credentials and store TOTAL DAY.
 * Used on manual Mailings refresh so director numbers match Dream.
 */
async function syncDreamLetterBotDailyTotals({ dayKey } = {}) {
  const day = String(dayKey || kyivDayKey()).slice(0, 10);
  const creds = await listDreamCredentialsForProfiles().catch(() => []);
  // One credential row per questionnaire (latest operator wins).
  const byProfile = new Map();
  for (const row of creds) {
    if (!byProfile.has(row.profileId)) byProfile.set(row.profileId, row);
  }
  const rows = [...byProfile.values()];
  const concurrency = 2;
  for (let i = 0; i < rows.length; i += concurrency) {
    const batch = rows.slice(i, i + concurrency);
    await Promise.allSettled(
      batch.map(async (row) => {
        const worker = getWorkerForUser(row.userId, row.profileId);
        await ensureWorkerSession(worker, {});
        const total = Number(worker.state?.dailyTotal);
        if (!Number.isFinite(total) || total <= 0) return;
        await setMailingDailyLettersAbsolute({
          dayKey: day,
          profileId: row.profileId,
          product: "letterbot",
          userId: row.userId,
          letters: total,
        });
        await persistJob({
          userId: row.userId,
          profileId: row.profileId,
          cookieHeader: worker.cookieHeader || "",
          selection: worker.userSelection || {},
          state: worker.getState(),
          isRunning: Boolean(worker.senderRunning && worker.state.sessionActive),
        }).catch(() => {});
      }),
    );
  }
}

/** Operator / extension can report Dream TOTAL DAY for the current questionnaire. */
router.post("/daily-total", authMiddleware, async (req, res) => {
  const profileId = profileIdFrom(req);
  const raw = req.body?.dailyTotal ?? req.body?.totalDay ?? req.body?.total;
  const num = Number(String(raw ?? "").replace(/,/g, ""));
  if (!/^\d+$/.test(String(profileId || "")) || !Number.isFinite(num) || num <= 0) {
    return res.status(400).json({ ok: false, error: "profileId and dailyTotal required" });
  }
  try {
    const day = kyivDayKey();
    const worker = getWorker(req, profileId);
    worker.applyDailyTotal(num);
    await setMailingDailyLettersAbsolute({
      dayKey: day,
      profileId,
      product: "letterbot",
      userId: req.user.id,
      letters: num,
    });
    await persistJob({
      userId: req.user.id,
      profileId,
      cookieHeader: worker.cookieHeader || "",
      selection: worker.userSelection || {},
      state: worker.getState(),
      isRunning: Boolean(worker.senderRunning && worker.state.sessionActive),
    }).catch(() => {});
    return res.json({ ok: true, profileId, dayKey: day, dailyTotal: num });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error?.message || String(error) });
  }
});

/** Director cabinet — force-stop operator mailing (no operator Chrome required). */
router.post("/admin/stop", adminMiddleware, async (req, res) => {
  const userId = Number(req.body?.userId);
  const profileId = String(req.body?.profileId || "default");
  if (!userId) {
    return res.status(400).json({ ok: false, error: "userId is required" });
  }
  try {
    let state = idleState(profileId);
    try {
      state = await stopWorkerForProfile(userId, profileId, {
        complete: Boolean(req.body?.complete),
      });
    } catch (_) {}
    await markV2LetterBotStopped(userId, profileId).catch(() => {});
    await stopV2LetterBotRemote(userId, profileId, { disconnect: false }).catch(() => {});
    return res.json({ ok: true, state, stopped: true });
  } catch (error) {
    return res.status(400).json({
      ok: false,
      error: error?.message || String(error),
      state: idleState(profileId),
    });
  }
});

/** Director cabinet — stop mailing and remote-logout operator profile (анкета). */
router.post("/admin/disconnect-shift", adminMiddleware, async (req, res) => {
  const userId = Number(req.body?.userId);
  const profileId = String(req.body?.profileId || "default");
  if (!userId) {
    return res.status(400).json({ ok: false, error: "userId is required" });
  }
  try {
    let state = idleState(profileId);
    try {
      state = await stopWorkerForProfile(userId, profileId);
    } catch (_) {}
    try {
      const { stopAllSenderChannelsForProfile } = await import("./senderReads.js");
      await stopAllSenderChannelsForProfile(userId, profileId);
    } catch (_) {}
    await requestOperatorShiftDisconnect(userId, profileId).catch(() => {});
    await markV2LetterBotStopped(userId, profileId).catch(() => {});
    await requestV2OperatorShiftDisconnect(userId, profileId).catch(() => {});
    await stopV2LetterBotRemote(userId, profileId, { disconnect: true }).catch(() => {});
    return res.json({ ok: true, state, stopped: true, disconnectRequested: true });
  } catch (error) {
    return res.status(400).json({
      ok: false,
      error: error?.message || String(error),
      state: idleState(profileId),
    });
  }
});

router.get("/shift-control", authMiddleware, async (req, res) => {
  const profileId = profileIdFrom(req);
  try {
    const requestedAt = await getOperatorShiftDisconnectRequest(req.user.id, profileId);
    return res.json({
      ok: true,
      profileId,
      disconnectRequested: Boolean(requestedAt),
      requestedAt: requestedAt || null,
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: error?.message || String(error),
      disconnectRequested: false,
    });
  }
});

router.post("/shift-control/ack", authMiddleware, async (req, res) => {
  const profileId = profileIdFrom(req);
  try {
    await clearOperatorShiftDisconnect(req.user.id, profileId);
    return res.json({ ok: true, profileId });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error?.message || String(error) });
  }
});

export async function restoreRunningLetterBotJobs() {
  await ensureLetterBotTables();
  const rows = await listRunningLetterBotJobs();
  for (const row of rows) {
    const userId = Number(row.user_id);
    const profileId = String(row.profile_id || "default");
    const worker = getWorkerForUser(userId, profileId);
    if (row.cookie_header) worker.setCookieHeader(row.cookie_header);
    const selection = row.selection || {};
    const prev = row.state || {};
    try {
      if (prev.isPaused) {
        worker.userSelection = selection;
        worker.senderRunning = true;
        worker.senderPaused = true;
        worker.state.sessionActive = true;
        worker.state.isPaused = true;
        worker.state.progress = prev.progress || null;
        worker.state.filter = prev.filter || worker.state.filter;
        worker.state.daySent = Number.isFinite(Number(prev.daySent)) ? Number(prev.daySent) : 0;
        worker.state.sendDayKey = String(prev.sendDayKey || "");
        if (Number.isFinite(Number(prev.dailyTotal))) {
          worker.state.dailyTotal = Number(prev.dailyTotal);
          worker.state.dailyTotalAt = Number(prev.dailyTotalAt) || Date.now();
          worker.state.dailyTotalDayKey = String(prev.dailyTotalDayKey || "");
        }
        worker.state.statusMessage = "Paused";
        worker.emitState();
        continue;
      }
      if (Number.isFinite(Number(prev.dailyTotal))) {
        worker.state.dailyTotal = Number(prev.dailyTotal);
        worker.state.dailyTotalAt = Number(prev.dailyTotalAt) || 0;
        worker.state.dailyTotalDayKey = String(prev.dailyTotalDayKey || "");
      }
      if (Number.isFinite(Number(prev.daySent))) {
        worker.state.daySent = Number(prev.daySent);
        worker.state.sendDayKey = String(prev.sendDayKey || "");
      }
      await ensureWorkerSession(worker, { cookieHeader: row.cookie_header || "" });
      const cycle = prev.cycle && typeof prev.cycle === "object" ? prev.cycle : {};
      await worker.start(selection, {
        restoreCycle: {
          firstStartIndex: cycle.firstStartIndex,
          mailing247Index: cycle.mailing247Index,
          categoryIndex: cycle.categoryIndex,
          onlineStage: cycle.onlineStage,
          progress: prev.progress || null,
          filter: prev.filter || "",
        },
      });
      worker.startKeepAlive();
      console.log(`Restored LetterBot job user=${userId} profile=${profileId}`);
    } catch (error) {
      console.error(`Failed to restore LetterBot job user=${userId}:`, error?.message || error);
      await markLetterBotJobStopped(userId, profileId);
    }
  }
}

/**
 * Run Inbox/Dream HTTP work without fighting an active LetterBot send.
 * Soft-pauses mailing for this profile, shares live cookies, then resumes.
 */
export async function withLetterBotDreamQuiet(userId, profileId, fn) {
  const pid = String(profileId || "default");
  const key = workerKey(userId, pid);
  const worker = getWorkerForUser(userId, pid);
  const shouldPause = Boolean(worker?.senderRunning && !worker?.senderPaused);
  if (shouldPause) {
    try {
      await worker.pause();
      worker.state.statusMessage = "Paused for Inbox sync";
      worker.emitState();
    } catch (_) {}
  }
  try {
    return await withDreamGate(key, async () => fn(worker));
  } finally {
    if (shouldPause) {
      try {
        await worker.resume();
      } catch (_) {}
    }
  }
}

export { getWorkerForUser, workerKey };

export default router;
