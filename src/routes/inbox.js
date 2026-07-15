import express from "express";

import { authMiddleware } from "../auth.js";
import { decryptSecret } from "../cryptoUtil.js";
import { getPool } from "../db.js";
import { scrapeDreamInboxCloud } from "../inboxCloudScraper.js";
import {
  getDreamCredentials,
  getLetterBotJob,
} from "../letterbotStore.js";
import {
  getWorkerForUser,
  withLetterBotDreamQuiet,
} from "./letterbot.js";
import { withSenderReadsDreamQuiet } from "./senderReads.js";

const router = express.Router();
router.use(authMiddleware);

function mapRow(row) {
  return {
    id: row.id,
    femaleProfileId: Number(row.female_profile_id),
    maleProfileId: Number(row.male_profile_id),
    displayName: row.display_name,
    photoUrl: row.photo_url,
    profileUrl: row.profile_url,
    inboxOrder: row.inbox_order,
    letterCount: Number(row.letter_count) || 0,
    firstContactAt: row.first_contact_at,
    lastLetterAt: row.last_letter_at,
    lastLetterPreview: row.last_letter_preview,
    addedBy: row.added_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function parseOptionalDate(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function itemToParams(femaleProfileId, raw, addedBy) {
  return [
    femaleProfileId,
    Number(raw.maleProfileId),
    String(raw.displayName || ""),
    String(raw.photoUrl || ""),
    String(raw.profileUrl || ""),
    Number.isFinite(Number(raw?.inboxOrder)) ? Number(raw.inboxOrder) : null,
    Number(raw?.letterCount ?? raw?.letter_count) || 0,
    parseOptionalDate(raw?.firstContactAt ?? raw?.first_contact_at),
    parseOptionalDate(raw?.lastLetterAt ?? raw?.last_contact_at ?? raw?.lastContactAt),
    String(raw?.lastLetterPreview || raw?.last_letter_preview || ""),
    addedBy,
  ];
}

const UPSERT_SQL = `
  INSERT INTO inbox_men (
    female_profile_id, male_profile_id, display_name, photo_url, profile_url,
    inbox_order, letter_count, first_contact_at, last_letter_at, last_letter_preview, added_by
  ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
  ON CONFLICT (female_profile_id, male_profile_id) DO UPDATE SET
    display_name = CASE
      WHEN EXCLUDED.display_name <> '' AND EXCLUDED.display_name !~* '^(i''?m\\s+)?online$'
      THEN EXCLUDED.display_name
      ELSE inbox_men.display_name
    END,
    photo_url = CASE WHEN EXCLUDED.photo_url <> '' THEN EXCLUDED.photo_url ELSE inbox_men.photo_url END,
    profile_url = CASE WHEN EXCLUDED.profile_url <> '' THEN EXCLUDED.profile_url ELSE inbox_men.profile_url END,
    inbox_order = CASE
      WHEN EXCLUDED.inbox_order IS NOT NULL THEN EXCLUDED.inbox_order
      ELSE inbox_men.inbox_order
    END,
    letter_count = GREATEST(inbox_men.letter_count, EXCLUDED.letter_count),
    first_contact_at = CASE
      WHEN inbox_men.first_contact_at IS NULL THEN EXCLUDED.first_contact_at
      WHEN EXCLUDED.first_contact_at IS NULL THEN inbox_men.first_contact_at
      WHEN EXCLUDED.first_contact_at < inbox_men.first_contact_at THEN EXCLUDED.first_contact_at
      ELSE inbox_men.first_contact_at
    END,
    last_letter_at = CASE
      WHEN inbox_men.last_letter_at IS NULL THEN EXCLUDED.last_letter_at
      WHEN EXCLUDED.last_letter_at IS NULL THEN inbox_men.last_letter_at
      WHEN EXCLUDED.last_letter_at > inbox_men.last_letter_at THEN EXCLUDED.last_letter_at
      ELSE inbox_men.last_letter_at
    END,
    last_letter_preview = CASE
      WHEN EXCLUDED.last_letter_preview <> '' THEN EXCLUDED.last_letter_preview
      ELSE inbox_men.last_letter_preview
    END,
    updated_at = NOW()
`;

router.get("/", async (req, res) => {
  try {
    const femaleProfileId = Number(req.query.femaleProfileId);
    if (!femaleProfileId) {
      return res.status(400).json({ ok: false, error: "femaleProfileId is required" });
    }

    const db = getPool();
    const result = await db.query(
      `SELECT * FROM inbox_men
       WHERE female_profile_id = $1
       ORDER BY inbox_order ASC NULLS LAST, id ASC`,
      [femaleProfileId],
    );

    return res.json({ ok: true, items: result.rows.map(mapRow) });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ ok: false, error: "Failed to load inbox men" });
  }
});

router.post("/sync", async (req, res) => {
  try {
    const femaleProfileId = Number(req.body?.femaleProfileId);
    const items = Array.isArray(req.body?.items) ? req.body.items : [];
    if (!femaleProfileId) {
      return res.status(400).json({ ok: false, error: "femaleProfileId is required" });
    }
    if (!items.length) {
      return res.status(400).json({ ok: false, error: "items required" });
    }

    const db = getPool();
    let synced = 0;
    let added = 0;

    for (const raw of items) {
      const maleProfileId = Number(raw?.maleProfileId);
      if (!maleProfileId) continue;

      const existing = await db.query(
        "SELECT id FROM inbox_men WHERE female_profile_id = $1 AND male_profile_id = $2",
        [femaleProfileId, maleProfileId],
      );
      if (!existing.rows.length) added += 1;

      await db.query(`${UPSERT_SQL}`, [...itemToParams(femaleProfileId, raw, req.user.email)]);
      synced += 1;
    }

    return res.json({ ok: true, synced, added });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ ok: false, error: "Sync failed" });
  }
});

router.delete("/all", async (req, res) => {
  try {
    const femaleProfileId = Number(req.query.femaleProfileId);
    if (!femaleProfileId) {
      return res.status(400).json({ ok: false, error: "femaleProfileId is required" });
    }

    const db = getPool();
    const result = await db.query(
      "DELETE FROM inbox_men WHERE female_profile_id = $1 RETURNING id",
      [femaleProfileId],
    );

    return res.json({ ok: true, deleted: result.rowCount });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ ok: false, error: "Failed to clear inbox men" });
  }
});

/** @type {Map<string, object>} */
const cloudScrapeJobs = new Map();
let cloudScrapeSeq = 0;

function profileIdFrom(req) {
  return String(
    req.body?.profileId ||
      req.body?.femaleProfileId ||
      req.query?.profileId ||
      req.query?.femaleProfileId ||
      req.headers["x-profile-id"] ||
      "default",
  );
}

function pruneCloudScrapeJobs() {
  const cutoff = Date.now() - 30 * 60_000;
  for (const [id, job] of cloudScrapeJobs.entries()) {
    if (Number(job.updatedAt || 0) < cutoff) cloudScrapeJobs.delete(id);
  }
}

/**
 * Start cloud Dream Inbox scrape (uses LetterBot Dream credentials / live worker cookies).
 * Soft-pauses LetterBot while scraping so Dream is not hit by send + inbox at once.
 */
router.post("/cloud-scrape", async (req, res) => {
  pruneCloudScrapeJobs();
  const profileId = profileIdFrom(req);
  const maxPages =
    req.body?.maxPages === 0 || req.body?.maxPages === "0"
      ? 0
      : Number(req.body?.maxPages ?? 3);
  const userId = Number(req.user.id);
  const jobId = `inbox-${userId}-${profileId}-${Date.now()}-${++cloudScrapeSeq}`;

  const job = {
    id: jobId,
    userId,
    profileId,
    status: "running",
    message: "Cloud Inbox: starting…",
    page: 0,
    men: 0,
    error: "",
    result: null,
    updatedAt: Date.now(),
  };
  cloudScrapeJobs.set(jobId, job);

  // Respond immediately; scrape continues in background.
  res.json({ ok: true, jobId, status: "running", profileId });

  void (async () => {
    try {
      const credRow = await getDreamCredentials(userId, profileId);
      const password = credRow?.password_enc ? decryptSecret(credRow.password_enc) : "";
      const username = credRow?.username || "";

      const scrapeResult = await withLetterBotDreamQuiet(userId, profileId, async (worker) => {
        return await withSenderReadsDreamQuiet(userId, profileId, async () => {
        let cookieHeader = String(worker?.cookieHeader || "").trim();
        if (!cookieHeader) {
          try {
            const row = await getLetterBotJob(userId, profileId);
            cookieHeader = String(row?.cookie_header || "").trim();
            if (cookieHeader && worker) worker.setCookieHeader(cookieHeader);
          } catch (_) {}
        }

        if (!cookieHeader && !(username && password)) {
          throw new Error(
            "Save Dream login in LetterBot (Cloud login) to Update Inbox from the cloud",
          );
        }

        // Prefer existing session; fall back to fresh login with stored credentials.
        try {
          return await scrapeDreamInboxCloud({
            cookieHeader,
            username: cookieHeader ? "" : username,
            password: cookieHeader ? "" : password,
            maxPages,
            onProgress(progress) {
              job.message = progress?.message || job.message;
              job.page = Number(progress?.page) || job.page;
              job.men = Number(progress?.men) || job.men;
              job.updatedAt = Date.now();
            },
          });
        } catch (firstError) {
          if (!(username && password)) throw firstError;
          return await scrapeDreamInboxCloud({
            cookieHeader: "",
            username,
            password,
            maxPages,
            onProgress(progress) {
              job.message = progress?.message || job.message;
              job.page = Number(progress?.page) || job.page;
              job.men = Number(progress?.men) || job.men;
              job.updatedAt = Date.now();
            },
          });
        }
        });
      });

      if (scrapeResult?.cookieHeader) {
        try {
          const worker = getWorkerForUser(userId, profileId);
          worker.setCookieHeader(scrapeResult.cookieHeader);
        } catch (_) {}
      }

      job.status = "done";
      job.message = `Cloud Inbox: ${scrapeResult.items?.length || 0} men`;
      job.men = scrapeResult.items?.length || 0;
      job.result = {
        ok: true,
        source: "cloud",
        femaleProfileId: scrapeResult.femaleProfileId,
        pagesScraped: scrapeResult.pagesScraped,
        letterCounts: scrapeResult.letterCounts || {},
        items: scrapeResult.items || [],
      };
      job.updatedAt = Date.now();
    } catch (error) {
      job.status = "error";
      job.error = error?.message || String(error);
      job.message = job.error;
      job.updatedAt = Date.now();
    }
  })();
});

router.get("/cloud-scrape/:jobId", async (req, res) => {
  const job = cloudScrapeJobs.get(String(req.params.jobId || ""));
  if (!job || Number(job.userId) !== Number(req.user.id)) {
    return res.status(404).json({ ok: false, error: "Job not found" });
  }
  return res.json({
    ok: true,
    jobId: job.id,
    status: job.status,
    message: job.message,
    page: job.page,
    men: job.men,
    error: job.error || "",
    result: job.status === "done" ? job.result : null,
  });
});

export default router;
