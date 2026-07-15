import express from "express";
import { authMiddleware } from "../auth.js";
import { decryptSecret } from "../cryptoUtil.js";
import { getDreamCredentials } from "../letterbotStore.js";
import {
  ensureSenderReadsTables,
  getSenderReadsJob,
  listRunningSenderReadsJobs,
  markSenderReadsJobStopped,
  upsertSenderReadsJob,
} from "../senderReadsStore.js";
import { SenderReadsWorker } from "../senderReadsWorker.js";

const router = express.Router();

/** @type {Map<string, SenderReadsWorker>} */
const workers = new Map();
/** @type {Map<string, object>} */
const lastStates = new Map();

function profileIdFrom(req) {
  return String(
    req.body?.profileId ||
      req.query?.profileId ||
      req.headers["x-profile-id"] ||
      "default",
  );
}

function channelFrom(req) {
  const v = String(
    req.body?.channel || req.body?.direction || req.query?.channel || "",
  )
    .toLowerCase()
    .trim();
  if (v === "online") return "online";
  if (v === "read") return "read";
  return "";
}

function requireChannel(req, res) {
  const channel = channelFrom(req);
  if (!channel) {
    res.status(400).json({
      ok: false,
      error: "channel required: read|online",
    });
    return null;
  }
  return channel;
}

function storeProfileId(profileId, channel) {
  const pid = String(profileId || "default");
  return channel === "online" ? `${pid}__online` : pid;
}

function dreamProfileIdFromStore(storeId) {
  const id = String(storeId || "default");
  return id.endsWith("__online") ? id.slice(0, -"__online".length) || "default" : id;
}

function channelFromStoreProfileId(storeId) {
  return String(storeId || "").endsWith("__online") ? "online" : "read";
}

function workerKey(userId, profileId, channel = "read") {
  const ch = channel === "online" ? "online" : "read";
  return `${userId || "anon"}:${profileId}:${ch}`;
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

async function persistJob(payload) {
  if (!payload?.userId) return;
  try {
    await upsertSenderReadsJob(payload);
  } catch (error) {
    console.error("upsertSenderReadsJob failed:", error?.message || error);
  }
}

function getWorkerForUser(userId, profileId, channel = "read") {
  const ch = channel === "online" ? "online" : "read";
  const key = workerKey(userId, profileId, ch);
  let worker = workers.get(key);
  if (!worker) {
    worker = new SenderReadsWorker(profileId, {
      ownerUserId: userId,
      channel: ch,
      onStateChange(state) {
        lastStates.set(key, state);
      },
      onPersist: persistJob,
      credentialsProvider: makeCredentialsProvider(userId, profileId),
    });
    workers.set(key, worker);
  } else {
    if (worker.ownerUserId == null) worker.ownerUserId = userId;
    worker.channel = ch;
    worker.storeProfileId = storeProfileId(profileId, ch);
    worker.setCredentialsProvider(makeCredentialsProvider(userId, profileId));
  }
  return worker;
}

function getWorker(req, profileId, channel = "read") {
  return getWorkerForUser(req.user?.id, profileId, channel);
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

router.post("/session", authMiddleware, async (req, res) => {
  const profileId = profileIdFrom(req);
  const channel = requireChannel(req, res);
  if (!channel) return;
  try {
    const worker = getWorker(req, profileId, channel);
    const cookieHeader = cookiesToHeader(req.body?.cookies, req.body?.cookieHeader);
    if (cookieHeader) worker.setCookieHeader(cookieHeader);
    return res.json({
      ok: true,
      channel,
      state: worker.getState(),
      hasProxy: Boolean(String(process.env.DREAM_PROXY_URL || "").trim()),
    });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error?.message || String(error) });
  }
});

router.get("/capabilities", authMiddleware, async (_req, res) => {
  const hasProxy = Boolean(String(process.env.DREAM_PROXY_URL || "").trim());
  const hasCaptchaSolver = Boolean(String(process.env.TWOCAPTCHA_API_KEY || "").trim());
  return res.json({
    ok: true,
    hasProxy,
    hasCaptchaSolver,
    cookieFirst: true,
    cloudReads: true,
    cloudOnline: true,
    reloginCaptcha: hasCaptchaSolver,
  });
});

router.get("/status", authMiddleware, async (req, res) => {
  const profileId = profileIdFrom(req);
  const channel = requireChannel(req, res);
  if (!channel) return;
  try {
    const key = workerKey(req.user.id, profileId, channel);
    const worker = workers.get(key);
    if (worker) {
      return res.json({ ok: true, channel, state: worker.getState(), live: true });
    }
    const cached = lastStates.get(key);
    if (cached) {
      return res.json({ ok: true, channel, state: cached, live: false });
    }
    const job = await getSenderReadsJob(req.user.id, storeProfileId(profileId, channel));
    if (job?.state) {
      return res.json({
        ok: true,
        channel,
        state: { ...job.state, cloud: true, channel, direction: channel },
        live: false,
        isRunning: Boolean(job.is_running),
      });
    }
    return res.json({
      ok: true,
      channel,
      state: {
        running: false,
        paused: false,
        statusMessage: "Idle",
        cloud: true,
        channel,
        direction: channel,
        profileId,
        updatedAt: Date.now(),
      },
      live: false,
    });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error?.message || String(error) });
  }
});

router.post("/start", authMiddleware, async (req, res) => {
  const profileId = profileIdFrom(req);
  const channel = requireChannel(req, res);
  if (!channel) return;
  try {
    const cookieHeader = cookiesToHeader(req.body?.cookies, req.body?.cookieHeader);
    const creds = await getDreamCredentials(req.user.id, profileId);
    if (!cookieHeader && !creds?.username) {
      return res.status(400).json({
        ok: false,
        error:
          "Open dream-singles.com in Chrome (cookies) or save Cloud Dream login in LetterBot",
        useLocal: true,
      });
    }
    const worker = getWorker(req, profileId, channel);
    if (cookieHeader) worker.setCookieHeader(cookieHeader);
    const existing = await getSenderReadsJob(req.user.id, storeProfileId(profileId, channel));
    const result = await worker.start({
      text: req.body?.text,
      preset: req.body?.preset,
      galleryId: req.body?.galleryId,
      delayMs: req.body?.delayMs,
      maxPages: req.body?.maxPages,
      excludeFavorites: req.body?.excludeFavorites,
      checkDuplicates: req.body?.checkDuplicates,
      channel,
      direction: channel,
      dupes: Array.isArray(existing?.dupes) ? existing.dupes : [],
    });
    return res.status(result.ok ? 200 : 400).json({ ...result, channel });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: error?.message || String(error),
      useLocal: true,
    });
  }
});

router.post("/pause", authMiddleware, async (req, res) => {
  const profileId = profileIdFrom(req);
  const channel = requireChannel(req, res);
  if (!channel) return;
  try {
    const worker = getWorker(req, profileId, channel);
    if (!worker.getState().running) {
      return res
        .status(400)
        .json({ ok: false, error: "Not running", channel, state: worker.getState() });
    }
    return res.json({ ok: true, channel, state: worker.pause() });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error?.message || String(error) });
  }
});

router.post("/resume", authMiddleware, async (req, res) => {
  const profileId = profileIdFrom(req);
  const channel = requireChannel(req, res);
  if (!channel) return;
  try {
    const worker = getWorker(req, profileId, channel);
    if (!worker.getState().running) {
      return res
        .status(400)
        .json({ ok: false, error: "Not running", channel, state: worker.getState() });
    }
    return res.json({ ok: true, channel, state: worker.resume() });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error?.message || String(error) });
  }
});

router.post("/stop", authMiddleware, async (req, res) => {
  const profileId = profileIdFrom(req);
  const channel = requireChannel(req, res);
  if (!channel) return;
  try {
    const worker = getWorker(req, profileId, channel);
    const state = worker.stop();
    await markSenderReadsJobStopped(req.user.id, storeProfileId(profileId, channel)).catch(
      () => {},
    );
    return res.json({ ok: true, channel, state: { ...state, channel, direction: channel } });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error?.message || String(error) });
  }
});

export async function restoreRunningSenderReadsJobs() {
  await ensureSenderReadsTables();
  const rows = await listRunningSenderReadsJobs();
  for (const row of rows) {
    try {
      const channel = channelFromStoreProfileId(row.profile_id);
      const dreamProfileId = dreamProfileIdFromStore(row.profile_id);
      const worker = getWorkerForUser(row.user_id, dreamProfileId, channel);
      await worker.restoreFromJob({
        ...row,
        selection: {
          ...(row.selection || {}),
          channel,
          direction: channel,
        },
      });
    } catch (error) {
      console.error(
        `SenderReads restore failed for ${row.user_id}:${row.profile_id}:`,
        error?.message || error,
      );
      await markSenderReadsJobStopped(row.user_id, row.profile_id).catch(() => {});
    }
  }
}

/**
 * Soft-pause cloud Read + Online while Inbox Update scrapes Dream
 * (same idea as withLetterBotDreamQuiet — avoids 5× rate-limit delays).
 */
export async function withSenderReadsDreamQuiet(userId, profileId, fn) {
  const pid = String(profileId || "default");
  const channels = ["read", "online"];
  const paused = [];
  for (const channel of channels) {
    const key = workerKey(userId, pid, channel);
    const worker = workers.get(key);
    if (!worker) continue;
    const st = worker.getState?.() || worker.state || {};
        if (st.running && !st.paused && !st.stopRequested) {
      try {
        worker.pause();
        worker.emit({ statusMessage: "Paused for Inbox sync" });
        paused.push(worker);
      } catch (_) {}
    }
  }
  try {
    return await fn();
  } finally {
    for (const worker of paused) {
      try {
        worker.resume();
      } catch (_) {}
    }
  }
}

export { getWorkerForUser, workerKey, workers };

export default router;
