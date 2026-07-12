import express from "express";
import { authMiddleware } from "../auth.js";
import { decryptSecret, encryptSecret, maskUsername } from "../cryptoUtil.js";
import { withDreamGate } from "../dreamGate.js";
import { dreamLogin } from "../dreamLogin.js";
import { LetterBotWorker } from "../letterBotWorker.js";
import {
  deleteDreamCredentials,
  ensureLetterBotTables,
  getDreamCredentials,
  getLetterBotJob,
  listRunningLetterBotJobs,
  markLetterBotJobStopped,
  upsertDreamCredentials,
  upsertLetterBotJob,
} from "../letterbotStore.js";

const router = express.Router();

/** @type {Map<string, LetterBotWorker>} */
const workers = new Map();
/** @type {Map<string, object>} */
const lastStates = new Map();

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
  if (!worker) {
    try {
      const row = await getLetterBotJob(userId, pid);
      if (row?.is_running) {
        worker = getWorkerForUser(userId, pid);
        if (row.cookie_header) worker.setCookieHeader(row.cookie_header);
        worker.senderRunning = true;
        worker.state.sessionActive = true;
      }
    } catch (_) {}
  }
  let state = idleState(pid);
  if (worker) {
    try {
      state = await worker.stop({ complete });
    } catch (_) {
      state = idleState(pid);
    }
  }
  await markLetterBotJobStopped(userId, pid);
  lastStates.set(key, state);
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
        worker.state.statusMessage = "Paused";
        worker.emitState();
        continue;
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
