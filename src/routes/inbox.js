import express from "express";

import { authMiddleware } from "../auth.js";
import { getPool } from "../db.js";

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
    inbox_order = COALESCE(inbox_men.inbox_order, EXCLUDED.inbox_order),
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

export default router;
