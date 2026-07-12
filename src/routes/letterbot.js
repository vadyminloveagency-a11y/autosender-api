import express from "express";
import { authMiddleware } from "../auth.js";
import { LetterBotWorker } from "../letterBotWorker.js";

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
      req.user?.id ||
      "default",
  );
}

function workerKey(req, profileId) {
  return `${req.user?.id || "anon"}:${profileId}`;
}

function getWorker(req, profileId) {
  const key = workerKey(req, profileId);
  let worker = workers.get(key);
  if (!worker) {
    worker = new LetterBotWorker(profileId, {
      onStateChange(state) {
        lastStates.set(key, state);
      },
    });
    workers.set(key, worker);
  }
  return worker;
}

router.post("/session", authMiddleware, (req, res) => {
  const profileId = profileIdFrom(req);
  const header = cookiesToHeader(req.body?.cookies, req.body?.cookieHeader);
  if (!header) {
    return res.status(400).json({
      ok: false,
      error: "No Dream cookies — open dream-singles.com while logged in",
      state: idleState(profileId),
    });
  }
  const worker = getWorker(req, profileId);
  worker.setCookieHeader(header);
  lastStates.set(workerKey(req, profileId), worker.getState());
  return res.json({ ok: true, state: worker.getState() });
});

router.get("/status", authMiddleware, (req, res) => {
  const profileId = profileIdFrom(req);
  const key = workerKey(req, profileId);
  const worker = workers.get(key);
  const state = worker ? worker.getState() : lastStates.get(key) || idleState(profileId);
  return res.json({ ok: true, state });
});

router.post("/start", authMiddleware, async (req, res) => {
  const profileId = profileIdFrom(req);
  const header = cookiesToHeader(req.body?.cookies, req.body?.cookieHeader);
  const worker = getWorker(req, profileId);
  if (header) worker.setCookieHeader(header);
  if (!worker.cookieHeader) {
    return res.status(400).json({
      ok: false,
      error: "Dream session missing — open dream-singles.com while logged in",
      state: worker.getState(),
    });
  }
  try {
    const state = await worker.start(req.body?.selection || {});
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
  const worker = getWorker(req, profileIdFrom(req));
  try {
    return res.json({
      ok: true,
      state: await worker.stop({ complete: Boolean(req.body?.complete) }),
    });
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
  const worker = getWorker(req, profileId);
  if (header) worker.setCookieHeader(header);
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

export default router;
