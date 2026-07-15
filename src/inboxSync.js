import { getPool } from "./db.js";

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

export async function syncInboxMenItems(femaleProfileId, items, addedBy) {
  const pid = Number(femaleProfileId);
  if (!pid) throw new Error("femaleProfileId is required");
  const list = Array.isArray(items) ? items : [];
  if (!list.length) return { synced: 0, added: 0 };

  const db = getPool();
  let synced = 0;
  let added = 0;

  for (const raw of list) {
    const maleProfileId = Number(raw?.maleProfileId);
    if (!maleProfileId) continue;

    const existing = await db.query(
      "SELECT id FROM inbox_men WHERE female_profile_id = $1 AND male_profile_id = $2",
      [pid, maleProfileId],
    );
    if (!existing.rows.length) added += 1;

    await db.query(UPSERT_SQL, [...itemToParams(pid, raw, addedBy)]);
    synced += 1;
  }

  return { synced, added };
}
