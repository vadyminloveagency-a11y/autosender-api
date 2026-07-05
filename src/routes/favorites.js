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
    notes: row.notes,
    tags: row.tags || [],
    lastLetterAt: row.last_letter_at,
    lastLetterPreview: row.last_letter_preview,
    source: row.source,
    addedBy: row.added_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

router.get("/", async (req, res) => {
  try {
    const femaleProfileId = Number(req.query.femaleProfileId);
    if (!femaleProfileId) {
      return res.status(400).json({ ok: false, error: "femaleProfileId is required" });
    }

    const db = getPool();
    const result = await db.query(
      `SELECT * FROM favorites
       WHERE female_profile_id = $1
       ORDER BY updated_at DESC`,
      [femaleProfileId],
    );

    return res.json({ ok: true, items: result.rows.map(mapRow) });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ ok: false, error: "Failed to load favorites" });
  }
});

router.post("/", async (req, res) => {
  try {
    const femaleProfileId = Number(req.body?.femaleProfileId);
    const maleProfileId = Number(req.body?.maleProfileId);
    if (!femaleProfileId || !maleProfileId) {
      return res.status(400).json({ ok: false, error: "femaleProfileId and maleProfileId required" });
    }

    const displayName = String(req.body?.displayName || "");
    const photoUrl = String(req.body?.photoUrl || "");
    const notes = String(req.body?.notes || "");
    const tags = Array.isArray(req.body?.tags) ? req.body.tags.map(String) : [];
    const lastLetterAt = req.body?.lastLetterAt ? new Date(req.body.lastLetterAt) : null;
    const lastLetterPreview = String(req.body?.lastLetterPreview || "");
    const source = String(req.body?.source || "manual");

    const db = getPool();
    const result = await db.query(
      `INSERT INTO favorites (
         female_profile_id, male_profile_id, display_name, photo_url, notes, tags,
         last_letter_at, last_letter_preview, source, added_by
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (female_profile_id, male_profile_id) DO UPDATE SET
         display_name = EXCLUDED.display_name,
         photo_url = EXCLUDED.photo_url,
         notes = CASE WHEN EXCLUDED.notes <> '' THEN EXCLUDED.notes ELSE favorites.notes END,
         tags = CASE WHEN cardinality(EXCLUDED.tags) > 0 THEN EXCLUDED.tags ELSE favorites.tags END,
         last_letter_at = COALESCE(EXCLUDED.last_letter_at, favorites.last_letter_at),
         last_letter_preview = CASE WHEN EXCLUDED.last_letter_preview <> '' THEN EXCLUDED.last_letter_preview ELSE favorites.last_letter_preview END,
         source = EXCLUDED.source,
         added_by = EXCLUDED.added_by,
         updated_at = NOW()
       RETURNING *`,
      [
        femaleProfileId,
        maleProfileId,
        displayName,
        photoUrl,
        notes,
        tags,
        lastLetterAt,
        lastLetterPreview,
        source,
        req.user.email,
      ],
    );

    return res.json({ ok: true, item: mapRow(result.rows[0]) });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ ok: false, error: "Failed to save favorite" });
  }
});

router.patch("/:id", async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!id) return res.status(400).json({ ok: false, error: "Invalid id" });

    const fields = [];
    const values = [];
    let index = 1;

    if (req.body?.notes != null) {
      fields.push(`notes = $${index++}`);
      values.push(String(req.body.notes));
    }
    if (Array.isArray(req.body?.tags)) {
      fields.push(`tags = $${index++}`);
      values.push(req.body.tags.map(String));
    }
    if (req.body?.displayName != null) {
      fields.push(`display_name = $${index++}`);
      values.push(String(req.body.displayName));
    }

    if (!fields.length) {
      return res.status(400).json({ ok: false, error: "Nothing to update" });
    }

    fields.push("updated_at = NOW()");
    values.push(id);

    const db = getPool();
    const result = await db.query(
      `UPDATE favorites SET ${fields.join(", ")} WHERE id = $${index} RETURNING *`,
      values,
    );

    if (!result.rows.length) {
      return res.status(404).json({ ok: false, error: "Favorite not found" });
    }

    return res.json({ ok: true, item: mapRow(result.rows[0]) });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ ok: false, error: "Failed to update favorite" });
  }
});

router.delete("/:id", async (req, res) => {
  try {
    const id = Number(req.params.id);
    const db = getPool();
    const result = await db.query("DELETE FROM favorites WHERE id = $1 RETURNING id", [id]);
    if (!result.rows.length) {
      return res.status(404).json({ ok: false, error: "Favorite not found" });
    }
    return res.json({ ok: true });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ ok: false, error: "Failed to delete favorite" });
  }
});

router.post("/import", async (req, res) => {
  try {
    const femaleProfileId = Number(req.body?.femaleProfileId);
    const items = Array.isArray(req.body?.items) ? req.body.items : [];
    if (!femaleProfileId || !items.length) {
      return res.status(400).json({ ok: false, error: "femaleProfileId and items required" });
    }

    const db = getPool();
    let imported = 0;

    for (const raw of items) {
      const maleProfileId = Number(raw?.maleProfileId);
      if (!maleProfileId) continue;

      await db.query(
        `INSERT INTO favorites (
           female_profile_id, male_profile_id, display_name, photo_url, notes, tags,
           last_letter_at, last_letter_preview, source, added_by
         ) VALUES ($1,$2,$3,$4,'', '{}', $5, $6, 'inbox', $7)
         ON CONFLICT (female_profile_id, male_profile_id) DO UPDATE SET
           display_name = EXCLUDED.display_name,
           photo_url = EXCLUDED.photo_url,
           last_letter_at = COALESCE(EXCLUDED.last_letter_at, favorites.last_letter_at),
           last_letter_preview = CASE WHEN EXCLUDED.last_letter_preview <> '' THEN EXCLUDED.last_letter_preview ELSE favorites.last_letter_preview END,
           updated_at = NOW()`,
        [
          femaleProfileId,
          maleProfileId,
          String(raw.displayName || ""),
          String(raw.photoUrl || ""),
          raw.lastLetterAt ? new Date(raw.lastLetterAt) : null,
          String(raw.lastLetterPreview || ""),
          req.user.email,
        ],
      );
      imported += 1;
    }

    return res.json({ ok: true, imported });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ ok: false, error: "Import failed" });
  }
});

export default router;
