import express from "express";

import { authMiddleware } from "../auth.js";

import { getPool } from "../db.js";



const router = express.Router();

router.use(authMiddleware);



const VALID_MAN_TYPES = new Set(["", "serious", "sexter", "hazard", "other"]);



function mapRow(row) {

  return {

    id: row.id,

    femaleProfileId: Number(row.female_profile_id),

    maleProfileId: Number(row.male_profile_id),

    displayName: row.display_name,

    photoUrl: row.photo_url,

    notes: row.notes,

    tags: row.tags || [],

    inboxOrder: row.inbox_order,

    letterCount: Number(row.letter_count) || 0,

    isSiteFavorite: Boolean(row.is_site_favorite),

    isSiteIgnored: Boolean(row.is_site_ignored),

    manType: row.man_type || "",

    isPinned: Boolean(row.is_pinned),

    pinOrder: row.pin_order != null ? Number(row.pin_order) : null,

    firstContactAt: row.first_contact_at,

    lastLetterAt: row.last_letter_at,

    lastLetterPreview: row.last_letter_preview,

    source: row.source,

    addedBy: row.added_by,

    createdAt: row.created_at,

    updatedAt: row.updated_at,

  };

}



function normalizeManType(value) {
  const text = String(value || "").trim().toLowerCase();
  if (text === "other") return "hazard";
  return VALID_MAN_TYPES.has(text) ? text : "";
}

function readManType(raw) {
  return normalizeManType(raw?.manType ?? raw?.man_type ?? raw?.type);
}

function readLetterCount(raw) {
  return Number(raw?.letterCount ?? raw?.letter_count) || 0;
}

function readPinOrder(raw) {
  const value = raw?.pinOrder ?? raw?.pin_order;
  if (value == null || value === "") return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function readBoolField(raw, camelKey, snakeKey) {
  if (raw?.[camelKey] != null) return Boolean(raw[camelKey]);
  if (raw?.[snakeKey] != null) return Boolean(raw[snakeKey]);
  return false;
}



function parseOptionalDate(value) {

  if (!value) return null;

  const date = new Date(value);

  return Number.isNaN(date.getTime()) ? null : date;

}



function upsertFavoriteSql({ preserveNotes = false, preserveManType = false, preservePinned = false } = {}) {

  const notesClause = preserveNotes

    ? ""

    : `notes = CASE WHEN EXCLUDED.notes <> '' THEN EXCLUDED.notes ELSE favorites.notes END,`;

  const manTypeClause = preserveManType

    ? ""

    : `man_type = CASE WHEN EXCLUDED.man_type <> '' THEN EXCLUDED.man_type ELSE favorites.man_type END,`;

  const pinClause = preservePinned

    ? ""

    : `is_pinned = EXCLUDED.is_pinned,

      pin_order = EXCLUDED.pin_order,`;



  return `

    INSERT INTO favorites (

      female_profile_id, male_profile_id, display_name, photo_url, notes, tags,

      inbox_order, letter_count, is_site_favorite, is_site_ignored, first_contact_at, last_letter_at,

      last_letter_preview, man_type, is_pinned, pin_order, source, added_by

    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)

    ON CONFLICT (female_profile_id, male_profile_id) DO UPDATE SET

      display_name = CASE

        WHEN EXCLUDED.display_name <> '' AND EXCLUDED.display_name !~* '^(i''?m\\s+)?online$'

        THEN EXCLUDED.display_name

        ELSE favorites.display_name

      END,

      photo_url = CASE WHEN EXCLUDED.photo_url <> '' THEN EXCLUDED.photo_url ELSE favorites.photo_url END,

      ${notesClause}

      ${manTypeClause}

      ${pinClause}

      tags = CASE WHEN cardinality(EXCLUDED.tags) > 0 THEN EXCLUDED.tags ELSE favorites.tags END,

      inbox_order = CASE
        WHEN EXCLUDED.inbox_order IS NOT NULL THEN EXCLUDED.inbox_order
        ELSE favorites.inbox_order
      END,

      letter_count = EXCLUDED.letter_count,

      is_site_favorite = EXCLUDED.is_site_favorite,

      is_site_ignored = EXCLUDED.is_site_ignored,

      first_contact_at = CASE

        WHEN favorites.first_contact_at IS NULL THEN EXCLUDED.first_contact_at

        WHEN EXCLUDED.first_contact_at IS NULL THEN favorites.first_contact_at

        WHEN EXCLUDED.first_contact_at < favorites.first_contact_at THEN EXCLUDED.first_contact_at

        ELSE favorites.first_contact_at

      END,

      last_letter_at = CASE

        WHEN favorites.last_letter_at IS NULL THEN EXCLUDED.last_letter_at

        WHEN EXCLUDED.last_letter_at IS NULL THEN favorites.last_letter_at

        WHEN EXCLUDED.last_letter_at > favorites.last_letter_at THEN EXCLUDED.last_letter_at

        ELSE favorites.last_letter_at

      END,

      updated_at = NOW()

  `;

}



function itemToDbParams(femaleProfileId, raw, addedBy, source = "inbox") {

  return [

    femaleProfileId,

    Number(raw.maleProfileId),

    String(raw.displayName || ""),

    String(raw.photoUrl || ""),

    String(raw.notes || ""),

    Array.isArray(raw?.tags) ? raw.tags.map(String) : [],

    Number.isFinite(Number(raw?.inboxOrder)) ? Number(raw.inboxOrder) : null,

    readLetterCount(raw),

    readBoolField(raw, "isSiteFavorite", "is_site_favorite"),

    readBoolField(raw, "isSiteIgnored", "is_site_ignored"),

    parseOptionalDate(raw?.firstContactAt ?? raw?.first_contact_at),

    parseOptionalDate(raw?.lastContactAt ?? raw?.last_contact_at ?? raw?.lastLetterAt ?? raw?.last_letter_at),

    String(raw?.lastLetterPreview || ""),

    readManType(raw),

    readBoolField(raw, "isPinned", "is_pinned"),

    readPinOrder(raw),

    String(raw?.source || source),

    addedBy,

  ];

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

       ORDER BY inbox_order ASC NULLS LAST, id ASC`,

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



    const db = getPool();

    const result = await db.query(`${upsertFavoriteSql()} RETURNING *`, [

      ...itemToDbParams(femaleProfileId, { ...req.body, maleProfileId }, req.user.email, "manual"),

    ]);



    return res.json({ ok: true, item: mapRow(result.rows[0]) });

  } catch (error) {

    console.error(error);

    return res.status(500).json({ ok: false, error: "Failed to save favorite" });

  }

});



router.get("/:id", async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!id) return res.status(400).json({ ok: false, error: "Invalid id" });

    const db = getPool();
    const result = await db.query("SELECT * FROM favorites WHERE id = $1", [id]);
    if (!result.rows.length) {
      return res.status(404).json({ ok: false, error: "Favorite not found" });
    }

    return res.json({ ok: true, item: mapRow(result.rows[0]) });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ ok: false, error: "Failed to load favorite" });
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

    if (req.body?.letterCount != null || req.body?.letter_count != null) {
      fields.push(`letter_count = $${index++}`);
      values.push(readLetterCount(req.body));
    }

    if (req.body?.isSiteFavorite != null || req.body?.is_site_favorite != null) {
      fields.push(`is_site_favorite = $${index++}`);
      values.push(readBoolField(req.body, "isSiteFavorite", "is_site_favorite"));
    }

    if (req.body?.isSiteIgnored != null || req.body?.is_site_ignored != null) {
      fields.push(`is_site_ignored = $${index++}`);
      values.push(readBoolField(req.body, "isSiteIgnored", "is_site_ignored"));
    }

    const manTypeValue =
      req.body?.manType != null || req.body?.man_type != null || req.body?.type != null
        ? readManType(req.body)
        : null;
    if (manTypeValue != null) {
      fields.push(`man_type = $${index++}`);
      values.push(manTypeValue);
    }

    if (req.body?.firstContactAt != null || req.body?.first_contact_at != null) {
      fields.push(`first_contact_at = $${index++}`);
      values.push(parseOptionalDate(req.body.firstContactAt ?? req.body.first_contact_at));
    }

    if (
      req.body?.lastLetterAt != null ||
      req.body?.lastContactAt != null ||
      req.body?.last_letter_at != null ||
      req.body?.last_contact_at != null
    ) {
      fields.push(`last_letter_at = $${index++}`);
      values.push(
        parseOptionalDate(
          req.body.lastLetterAt ??
            req.body.lastContactAt ??
            req.body.last_letter_at ??
            req.body.last_contact_at,
        ),
      );
    }

    if (req.body?.isPinned != null || req.body?.is_pinned != null) {
      fields.push(`is_pinned = $${index++}`);
      values.push(readBoolField(req.body, "isPinned", "is_pinned"));
    }

    if (req.body?.pinOrder != null || req.body?.pin_order != null) {
      fields.push(`pin_order = $${index++}`);
      values.push(readPinOrder(req.body));
    } else if (req.body?.isPinned === false || req.body?.is_pinned === false) {
      fields.push(`pin_order = $${index++}`);
      values.push(null);
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



router.delete("/all", async (req, res) => {

  try {

    const femaleProfileId = Number(req.query.femaleProfileId);

    if (!femaleProfileId) {

      return res.status(400).json({ ok: false, error: "femaleProfileId is required" });

    }



    const db = getPool();

    const result = await db.query(

      "DELETE FROM favorites WHERE female_profile_id = $1 RETURNING id",

      [femaleProfileId],

    );

    return res.json({ ok: true, deleted: result.rowCount });

  } catch (error) {

    console.error(error);

    return res.status(500).json({ ok: false, error: "Failed to clear favorites" });

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



      await db.query(`${upsertFavoriteSql({ preserveNotes: true, preserveManType: true, preservePinned: true })}`, [

        ...itemToDbParams(femaleProfileId, raw, req.user.email, "inbox"),

      ]);

      imported += 1;

    }



    return res.json({ ok: true, imported });

  } catch (error) {

    console.error(error);

    return res.status(500).json({ ok: false, error: "Import failed" });

  }

});



router.post("/sync", async (req, res) => {

  try {

    const femaleProfileId = Number(req.body?.femaleProfileId);

    const items = Array.isArray(req.body?.items) ? req.body.items : [];

    if (!femaleProfileId) {

      return res.status(400).json({ ok: false, error: "femaleProfileId is required" });

    }



    const db = getPool();

    let synced = 0;

    let added = 0;



    for (const raw of items) {

      const maleProfileId = Number(raw?.maleProfileId);

      if (!maleProfileId) continue;



      const existing = await db.query(

        "SELECT id FROM favorites WHERE female_profile_id = $1 AND male_profile_id = $2",

        [femaleProfileId, maleProfileId],

      );

      if (!existing.rows.length) added += 1;



      await db.query(`${upsertFavoriteSql({ preserveNotes: true, preserveManType: true, preservePinned: true })}`, [

        ...itemToDbParams(femaleProfileId, raw, req.user.email, "inbox"),

      ]);

      synced += 1;

    }



    return res.json({ ok: true, synced, added });

  } catch (error) {

    console.error(error);

    return res.status(500).json({ ok: false, error: "Sync failed" });

  }

});



export default router;

