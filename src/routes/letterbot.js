import express from "express";
import { authMiddleware } from "../auth.js";
import { LetterBotWorker } from "../letterBotWorker.js";
import {
  ensureLetterBotTables,
  listRunningLetterBotJobs,
  markLetterBotJobStopped,
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
    });
    workers.set(key, worker);
  } else if (worker.ownerUserId == null) {
    worker.ownerUserId = userId;
  }
  return worker;
}

function getWorker(req, profileId) {
  return getWorkerForUser(req.user?.id, profileId);
}

router.post("/session", authMiddleware, async (req, res) => {
  const profileId = profileIdFrom(req);
  const header = cookiesToHeader(req.body?.cookies, req.body?.cookieHeader);
  const dreamJwt = String(req.body?.dreamJwt || "").trim();
  if (!header && !dreamJwt) {
    return res.status(400).json({
      ok: false,
      error: "No Dream cookies — open dream-singles.com while logged in",
      state: idleState(profileId),
    });
  }
  const worker = getWorker(req, profileId);
  if (header) worker.setCookieHeader(header);
  if (dreamJwt) worker.setDreamJwt(dreamJwt);
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

router.get("/status", authMiddleware, (req, res) => {
  const profileId = profileIdFrom(req);
  const key = workerKey(req.user.id, profileId);
  const worker = workers.get(key);
  const state = worker ? worker.getState() : lastStates.get(key) || idleState(profileId);
  return res.json({ ok: true, state });
});

router.post("/start", authMiddleware, async (req, res) => {
  const profileId = profileIdFrom(req);
  const header = cookiesToHeader(req.body?.cookies, req.body?.cookieHeader);
  const dreamJwt = String(req.body?.dreamJwt || "").trim();
  const worker = getWorker(req, profileId);
  if (header) worker.setCookieHeader(header);
  if (dreamJwt) worker.setDreamJwt(dreamJwt);
  if (!worker.cookieHeader && !worker.jwtCache?.token) {
    return res.status(400).json({
      ok: false,
      error: "Dream session missing — open dream-singles.com while logged in",
      state: worker.getState(),
    });
  }
  try {
    // Prove cookies can refresh JWT on the server before operator closes Chrome.
    if (worker.cookieHeader) {
      await worker.fetchLetterBotJwt(true);
    }
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
  const worker = getWorker(req, profileIdFrom(req));
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
  const worker = getWorker(req, profileIdFrom(req));
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
  const worker = getWorker(req, profileId);
  try {
    const state = await worker.stop({ complete: Boolean(req.body?.complete) });
    await markLetterBotJobStopped(req.user.id, profileId);
    return res.json({ ok: true, state });
  } catch (error) {
    return res.status(400).json({
      ok: false,
      error: error?.message || String(error),
      state: worker.getState(),
    });
  }
});

router.post("/connect", authMiddleware, async (req, res) => {
  const profileId = profileIdFrom(req);
  const header = cookiesToHeader(req.body?.cookies, req.body?.cookieHeader);
  const dreamJwt = String(req.body?.dreamJwt || "").trim();
  const worker = getWorker(req, profileId);
  if (header) worker.setCookieHeader(header);
  if (dreamJwt) worker.setDreamJwt(dreamJwt);
  try {
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
      await worker.start(selection);
      worker.startKeepAlive();
      console.log(`Restored LetterBot job user=${userId} profile=${profileId}`);
    } catch (error) {
      console.error(`Failed to restore LetterBot job user=${userId}:`, error?.message || error);
      await markLetterBotJobStopped(userId, profileId);
    }
  }
}

export default router;
