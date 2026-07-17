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
} from "../mailingDailyStore.js";
import {
  ensureAgencyFinanceTables,
  getAgencyFinanceCredentials,
  upsertAgencyFinanceCredentials,
} from "../agencyFinanceStore.js";
import {
  clearAgencyFinanceCaches,
  fetchBonusesByGirl,
} from "../dreamAgencyFinance.js";

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
      if (worker.socket?.readyState !== WebSocket.OPEN && cookieHeader) {
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
  const total = Number.isFinite(Number(progress.total)) ? Number(progress.total) : null;
  let pct = Number(progress.percent);
  if ((!Number.isFinite(pct) || pct === 0) && sent != null && total > 0) {
    pct = (sent / total) * 100;
  }
  const daySent = Number.isFinite(Number(state?.daySent)) ? Number(state.daySent) : null;
  const dailyTotal = Number.isFinite(Number(state?.dailyTotal)) ? Number(state.dailyTotal) : null;
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
    total,
    daySent,
    dailyTotal,
    statusMessage: String(state?.statusMessage || ""),
    updatedAt: state?.updatedAt || null,
  };
}

async function listActiveMailingJobs() {
  const byKey = new Map();
  const profileMap = await mapAgencyProfilesByFemaleId().catch(() => new Map());

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

  return [...byKey.values()].sort((a, b) => {
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

    const [rows, monthDays, profileMap] = await Promise.all([
      listMailingDailyByProfile(date),
      listMailingDailyMonthTotals(year, month),
      mapAgencyProfilesByFemaleId().catch(() => new Map()),
    ]);

    let bonusRows = [];
    let balanceError = "";
    let balanceConfigured = false;
    try {
      const creds = await getAgencyFinanceCredentials();
      balanceConfigured = Boolean(creds.configured);
      if (creds.configured) {
        bonusRows = await fetchBonusesByGirl(date);
      }
    } catch (error) {
      balanceError = error?.message || String(error);
    }

    const byProfile = new Map();
    const ensureEntry = (key, metaExtra = {}) => {
      let entry = byProfile.get(key);
      if (entry) return entry;
      const idNum = Number(key) || 0;
      const meta = idNum ? profileMap.get(idNum) : null;
      entry = {
        profileId: key,
        displayName: meta?.displayName || metaExtra.name || "",
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
        balanceUsd: null,
      };
      byProfile.set(key, entry);
      return entry;
    };

    for (const row of rows) {
      const key = String(row.profileId || "");
      if (!key) continue;
      const entry = ensureEntry(key);
      if (row.product === "online") entry.online += row.letters;
      else if (row.product === "read") entry.read += row.letters;
      else entry.letterbot += row.letters;
      entry.total = entry.letterbot + entry.read + entry.online;
      if (row.operatorName || row.operatorEmail) {
        entry.operatorName = row.operatorName || entry.operatorName;
        entry.operatorEmail = row.operatorEmail || entry.operatorEmail;
      }
    }

    for (const bonus of bonusRows) {
      const key = String(bonus.profileId || "");
      if (!key) continue;
      const entry = ensureEntry(key, { name: bonus.name });
      entry.balanceUsd = Number(bonus.amount) || 0;
      if (!entry.displayName && bonus.name) entry.displayName = bonus.name;
    }

    const profiles = [...byProfile.values()].sort((a, b) => {
      const balA = Number(a.balanceUsd) || 0;
      const balB = Number(b.balanceUsd) || 0;
      if (balB !== balA) return balB - balA;
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
      balanceConfigured,
      balanceError: balanceError || null,
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

router.get("/admin/agency-finance-credentials", adminMiddleware, async (_req, res) => {
  try {
    await ensureAgencyFinanceTables();
    const creds = await getAgencyFinanceCredentials();
    return res.json({
      ok: true,
      configured: Boolean(creds.configured),
      usernameMasked: creds.usernameMasked || "",
      source: creds.source || "",
      updatedAt: creds.updatedAt || null,
    });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error?.message || String(error) });
  }
});

router.post("/admin/agency-finance-credentials", adminMiddleware, async (req, res) => {
  try {
    const username = String(req.body?.username || "").trim();
    const password = String(req.body?.password || "");
    const saved = await upsertAgencyFinanceCredentials({ username, password });
    clearAgencyFinanceCaches();
    return res.json({ ok: true, ...saved });
  } catch (error) {
    return res.status(400).json({ ok: false, error: error?.message || String(error) });
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
    const state = await stopWorkerForProfile(userId, profileId, {
      complete: Boolean(req.body?.complete),
    });
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
    const state = await stopWorkerForProfile(userId, profileId);
    try {
      const { stopAllSenderChannelsForProfile } = await import("./senderReads.js");
      await stopAllSenderChannelsForProfile(userId, profileId);
    } catch (_) {}
    await requestOperatorShiftDisconnect(userId, profileId);
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
      await worker.start(selection);
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
