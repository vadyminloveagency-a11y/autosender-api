import { getPool } from "./db.js";
import { decryptSecret, encryptSecret } from "./cryptoUtil.js";
import { dreamLogin } from "./dreamLogin.js";
import {
  sqlCurrentDreamDayStart,
  sqlDreamDayEnd,
  sqlDreamDayStart,
} from "./dreamDay.js";
import { resolveDreamFemaleProfileId } from "./inboxCloudScraper.js";

export async function ensureAgencyProfileTables() {
  const db = getPool();
  await db.query(`
    CREATE TABLE IF NOT EXISTS agency_profiles (
      id SERIAL PRIMARY KEY,
      female_profile_id BIGINT,
      display_name TEXT NOT NULL DEFAULT '',
      dream_username TEXT NOT NULL,
      password_enc TEXT NOT NULL,
      assigned_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (dream_username)
    )
  `);
  await db.query(`
    CREATE INDEX IF NOT EXISTS agency_profiles_assigned_idx
    ON agency_profiles (assigned_user_id)
  `);
  await db.query(`
    CREATE INDEX IF NOT EXISTS agency_profiles_female_idx
    ON agency_profiles (female_profile_id)
  `);
  await db.query(`
    CREATE TABLE IF NOT EXISTS agency_profile_assignments (
      id BIGSERIAL PRIMARY KEY,
      agency_profile_id INTEGER REFERENCES agency_profiles(id) ON DELETE SET NULL,
      female_profile_id BIGINT NOT NULL,
      display_name TEXT NOT NULL DEFAULT '',
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      assigned_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      unassigned_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await db.query(`
    CREATE INDEX IF NOT EXISTS agency_profile_assignments_user_idx
    ON agency_profile_assignments (user_id, assigned_at, unassigned_at)
  `);
  await db.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS agency_profile_assignments_open_idx
    ON agency_profile_assignments (agency_profile_id)
    WHERE agency_profile_id IS NOT NULL AND unassigned_at IS NULL
  `);
  // Existing assignments predate this history table. Seed the current operator
  // from the start of the current Dream day (10:00 Kyiv) so today's finance
  // data is immediately visible without claiming older assignment history.
  await db.query(`
    INSERT INTO agency_profile_assignments (
      agency_profile_id, female_profile_id, display_name, user_id, assigned_at
    )
    SELECT
      ap.id,
      ap.female_profile_id,
      ap.display_name,
      ap.assigned_user_id,
      ${sqlCurrentDreamDayStart()}
    FROM agency_profiles ap
    WHERE ap.assigned_user_id IS NOT NULL
      AND ap.female_profile_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1
        FROM agency_profile_assignments h
        WHERE h.agency_profile_id = ap.id
          AND h.unassigned_at IS NULL
      )
    ON CONFLICT DO NOTHING
  `);
}

/** Parse YYYY-MM-DD or D/M[/YYYY] into Kyiv calendar day (YYYY-MM-DD), or null. */
function parseAssignmentDay(assignedAt) {
  const raw = String(assignedAt || "").trim();
  if (!raw) return null;
  const iso = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const dmy = raw.match(/^(\d{1,2})[./](\d{1,2})(?:[./](\d{2,4}))?$/);
  if (dmy) {
    const dd = String(dmy[1]).padStart(2, "0");
    const mm = String(dmy[2]).padStart(2, "0");
    let yyyy = dmy[3] ? String(dmy[3]) : String(new Date().getFullYear());
    if (yyyy.length === 2) yyyy = `20${yyyy}`;
    return `${yyyy}-${mm}-${dd}`;
  }
  const parsed = new Date(raw);
  if (!Number.isNaN(parsed.getTime())) return parsed.toISOString().slice(0, 10);
  return null;
}

async function recordAssignmentChange(db, profile, previousUserId, nextUserId, assignedAt = null) {
  const profileId = Number(profile?.id) || 0;
  const femaleProfileId = Number(profile?.female_profile_id) || 0;
  const oldUserId = Number(previousUserId) || null;
  const newUserId = Number(nextUserId) || null;
  if (!profileId || !femaleProfileId) return;

  const day = parseAssignmentDay(assignedAt);
  const sameUser = oldUserId === newUserId;

  // Same operator + explicit date: backdate (or create) the open interval.
  // Day keys map to Dream day start (10:00 Kyiv), not midnight.
  if (sameUser && newUserId && day) {
    const updated = await db.query(
      `UPDATE agency_profile_assignments
       SET assigned_at = ${sqlDreamDayStart(2)}
       WHERE agency_profile_id = $1
         AND user_id = $3
         AND unassigned_at IS NULL
       RETURNING id`,
      [profileId, day, newUserId],
    );
    if (updated.rowCount) return;
    await db.query(
      `INSERT INTO agency_profile_assignments (
         agency_profile_id, female_profile_id, display_name, user_id, assigned_at
       ) VALUES ($1, $2, $3, $4, ${sqlDreamDayStart(5)})`,
      [profileId, femaleProfileId, String(profile.display_name || ""), newUserId, day],
    );
    return;
  }

  if (sameUser) return;

  await db.query(
    `UPDATE agency_profile_assignments
     SET unassigned_at = NOW()
     WHERE agency_profile_id = $1
       AND unassigned_at IS NULL`,
    [profileId],
  );
  if (!newUserId) return;

  if (day) {
    await db.query(
      `INSERT INTO agency_profile_assignments (
         agency_profile_id, female_profile_id, display_name, user_id, assigned_at
       ) VALUES ($1, $2, $3, $4, ${sqlDreamDayStart(5)})`,
      [profileId, femaleProfileId, String(profile.display_name || ""), newUserId, day],
    );
  } else {
    await db.query(
      `INSERT INTO agency_profile_assignments (
         agency_profile_id, female_profile_id, display_name, user_id, assigned_at
       ) VALUES ($1, $2, $3, $4, NOW())`,
      [profileId, femaleProfileId, String(profile.display_name || ""), newUserId],
    );
  }
}

export async function listProfileAssignmentHistoryForUser(userId) {
  const db = getPool();
  const result = await db.query(
    `SELECT
       h.id,
       h.agency_profile_id,
       h.female_profile_id,
       h.display_name,
       h.assigned_at,
       h.unassigned_at,
       ap.dream_username
     FROM agency_profile_assignments h
     LEFT JOIN agency_profiles ap ON ap.id = h.agency_profile_id
     WHERE h.user_id = $1
     ORDER BY h.assigned_at DESC, h.id DESC`,
    [Number(userId)],
  );
  return result.rows.map((row) => ({
    id: Number(row.id),
    agencyProfileId: row.agency_profile_id ? Number(row.agency_profile_id) : null,
    femaleProfileId: Number(row.female_profile_id),
    displayName: String(row.display_name || ""),
    dreamUsername: String(row.dream_username || ""),
    assignedAt: row.assigned_at,
    unassignedAt: row.unassigned_at || null,
    photoUrl: `https://profile-photos-cdn.dream-singles.com/im${Number(row.female_profile_id)}_small.jpg`,
  }));
}

export async function listProfileAssignmentsForUserDay(userId, dayKey) {
  const day = String(dayKey || "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return [];
  const db = getPool();
  const result = await db.query(
    `SELECT
       h.agency_profile_id,
       h.female_profile_id,
       h.display_name,
       h.assigned_at,
       h.unassigned_at,
       ap.dream_username
     FROM agency_profile_assignments h
     LEFT JOIN agency_profiles ap ON ap.id = h.agency_profile_id
     WHERE h.user_id = $1
       AND h.assigned_at < ${sqlDreamDayEnd(2)}
       AND (
         h.unassigned_at IS NULL
         OR h.unassigned_at >= ${sqlDreamDayStart(2)}
       )
     ORDER BY h.female_profile_id, h.assigned_at DESC`,
    [Number(userId), day],
  );
  return result.rows.map((row) => ({
    agencyProfileId: row.agency_profile_id ? Number(row.agency_profile_id) : null,
    femaleProfileId: Number(row.female_profile_id),
    displayName: String(row.display_name || ""),
    dreamUsername: String(row.dream_username || ""),
    assignedAt: row.assigned_at,
    unassignedAt: row.unassigned_at || null,
    photoUrl: `https://profile-photos-cdn.dream-singles.com/im${Number(row.female_profile_id)}_small.jpg`,
  }));
}

/** All assignment intervals that overlap a Dream business day (admin finance views). */
export async function listAssignmentsForDreamDay(dayKey) {
  return listAssignmentsForDreamDayRange(dayKey, dayKey);
}

/** Assignment intervals overlapping Dream days [startDay, endDay] inclusive. */
export async function listAssignmentsForDreamDayRange(startDayKey, endDayKey = startDayKey) {
  const startDay = String(startDayKey || "").slice(0, 10);
  const endDay = String(endDayKey || startDay).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(startDay) || !/^\d{4}-\d{2}-\d{2}$/.test(endDay)) {
    return [];
  }
  const from = startDay <= endDay ? startDay : endDay;
  const to = startDay <= endDay ? endDay : startDay;
  const db = getPool();
  const result = await db.query(
    `SELECT
       h.agency_profile_id,
       h.female_profile_id,
       h.display_name,
       h.assigned_at,
       h.unassigned_at,
       h.user_id,
       u.name AS operator_name,
       u.email AS operator_email,
       ap.dream_username
     FROM agency_profile_assignments h
     LEFT JOIN agency_profiles ap ON ap.id = h.agency_profile_id
     LEFT JOIN users u ON u.id = h.user_id
     WHERE h.assigned_at < ${sqlDreamDayEnd(2)}
       AND (
         h.unassigned_at IS NULL
         OR h.unassigned_at >= ${sqlDreamDayStart(1)}
       )
     ORDER BY h.female_profile_id, h.assigned_at ASC`,
    [from, to],
  );
  return result.rows.map((row) => ({
    agencyProfileId: row.agency_profile_id ? Number(row.agency_profile_id) : null,
    femaleProfileId: Number(row.female_profile_id),
    displayName: String(row.display_name || ""),
    dreamUsername: String(row.dream_username || ""),
    userId: Number(row.user_id) || null,
    operatorName: String(row.operator_name || "").trim(),
    operatorEmail: String(row.operator_email || "").trim(),
    assignedAt: row.assigned_at,
    unassignedAt: row.unassigned_at || null,
    photoUrl: `https://profile-photos-cdn.dream-singles.com/im${Number(row.female_profile_id)}_small.jpg`,
  }));
}

function mapAgencyProfileRow(row, extras = {}) {
  return {
    id: row.id,
    femaleProfileId: row.female_profile_id ? Number(row.female_profile_id) : null,
    displayName: row.display_name || "",
    dreamUsername: row.dream_username || "",
    assignedUserId: row.assigned_user_id ? Number(row.assigned_user_id) : null,
    assignedOperatorEmail: extras.assignedOperatorEmail || "",
    assignedOperatorName: extras.assignedOperatorName || "",
    inboxMenCount: Number(extras.inboxMenCount) || 0,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function listAgencyProfiles() {
  const db = getPool();
  const result = await db.query(
    `SELECT
       ap.*,
       u.email AS assigned_operator_email,
       u.name AS assigned_operator_name,
       (
         SELECT COUNT(*)::int
         FROM inbox_men im
         WHERE ap.female_profile_id IS NOT NULL
           AND im.female_profile_id = ap.female_profile_id
       ) AS inbox_men_count
     FROM agency_profiles ap
     LEFT JOIN users u ON u.id = ap.assigned_user_id
     ORDER BY ap.updated_at DESC, ap.id DESC`,
  );
  return result.rows.map((row) =>
    mapAgencyProfileRow(row, {
      assignedOperatorEmail: row.assigned_operator_email || "",
      assignedOperatorName: row.assigned_operator_name || "",
      inboxMenCount: row.inbox_men_count,
    }),
  );
}

/** Fast lookup for admin Mailings: femaleProfileId → name + photo + operator. */
export async function mapAgencyProfilesByFemaleId() {
  const profiles = await listAgencyProfiles();
  const map = new Map();
  for (const profile of profiles) {
    const id = Number(profile.femaleProfileId) || 0;
    if (!id || map.has(id)) continue;
    map.set(id, {
      displayName: String(profile.displayName || "").trim(),
      dreamUsername: String(profile.dreamUsername || "").trim(),
      photoUrl: `https://profile-photos-cdn.dream-singles.com/im${id}_small.jpg`,
      operatorName: String(profile.assignedOperatorName || "").trim(),
      operatorEmail: String(profile.assignedOperatorEmail || "").trim(),
    });
  }
  return map;
}

export async function getAgencyProfileById(id) {
  const db = getPool();
  const result = await db.query(
    `SELECT ap.*, u.email AS assigned_operator_email, u.name AS assigned_operator_name
     FROM agency_profiles ap
     LEFT JOIN users u ON u.id = ap.assigned_user_id
     WHERE ap.id = $1
     LIMIT 1`,
    [Number(id)],
  );
  const row = result.rows[0];
  if (!row) return null;
  return mapAgencyProfileRow(row, {
    assignedOperatorEmail: row.assigned_operator_email || "",
    assignedOperatorName: row.assigned_operator_name || "",
  });
}

export async function getAgencyProfileAssignedToUser(userId) {
  const db = getPool();
  const result = await db.query(
    `SELECT *
     FROM agency_profiles
     WHERE assigned_user_id = $1
     ORDER BY updated_at DESC, id DESC
     LIMIT 1`,
    [Number(userId)],
  );
  return result.rows[0] || null;
}

export async function listAgencyProfilesAssignedToUser(userId) {
  const db = getPool();
  const result = await db.query(
    `SELECT *
     FROM agency_profiles
     WHERE assigned_user_id = $1
     ORDER BY display_name ASC, dream_username ASC, id ASC`,
    [Number(userId)],
  );
  return result.rows;
}

export async function getAgencyProfileSecrets(row) {
  if (!row) return null;
  let password = "";
  try {
    password = decryptSecret(row.password_enc);
  } catch (_) {
    password = "";
  }
  return {
    dreamUsername: String(row.dream_username || "").trim(),
    password,
    femaleProfileId: row.female_profile_id ? Number(row.female_profile_id) : null,
    displayName: row.display_name || "",
  };
}

export async function verifyAndResolveDreamProfile({ username, password, displayName = "" }) {
  const dreamUsername = String(username || "").trim();
  const dreamPassword = String(password || "");
  if (!dreamUsername || !dreamPassword) {
    throw new Error("Dream login and password are required");
  }

  const { cookieHeader, cookies } = await dreamLogin(dreamUsername, dreamPassword);
  let femaleProfileId = await resolveDreamFemaleProfileId(cookieHeader);
  if (!femaleProfileId) {
    throw new Error("Could not detect questionnaire ID from Dream — check login");
  }

  return {
    cookieHeader,
    cookies: cookies || {},
    femaleProfileId,
    displayName: String(displayName || "").trim() || `Profile ${femaleProfileId}`,
    dreamUsername,
    dreamPassword,
  };
}

export async function createAgencyProfile({ username, password, displayName, assignedUserId }) {
  const verified = await verifyAndResolveDreamProfile({ username, password, displayName });
  const db = getPool();
  const result = await db.query(
    `INSERT INTO agency_profiles (
       female_profile_id, display_name, dream_username, password_enc, assigned_user_id, updated_at
     ) VALUES ($1, $2, $3, $4, $5, NOW())
     RETURNING *`,
    [
      verified.femaleProfileId,
      verified.displayName,
      verified.dreamUsername,
      encryptSecret(verified.dreamPassword),
      assignedUserId ? Number(assignedUserId) : null,
    ],
  );
  const row = result.rows[0];
  if (row?.assigned_user_id) {
    await recordAssignmentChange(db, row, null, row.assigned_user_id);
  }
  return row;
}

/**
 * Upsert Dream agency Active questionnaires into Account Manager.
 * Does not overwrite real lady Dream logins — only creates placeholders
 * or refreshes display_name when matched by female_profile_id.
 */
export async function upsertAgencySyncedProfiles(items = []) {
  await ensureAgencyProfileTables();
  const db = getPool();
  const emptyEnc = encryptSecret("");
  let created = 0;
  let updated = 0;

  for (const item of Array.isArray(items) ? items : []) {
    const femaleProfileId = Number(item.profileId || item.femaleProfileId || 0);
    if (!femaleProfileId) continue;
    const displayName =
      String(item.name || item.displayName || "").trim() || `Profile ${femaleProfileId}`;
    const placeholderUser = `agency:${femaleProfileId}`;

    const byFemale = await db.query(
      `SELECT id, display_name FROM agency_profiles WHERE female_profile_id = $1 LIMIT 1`,
      [femaleProfileId],
    );
    if (byFemale.rows[0]) {
      if (String(byFemale.rows[0].display_name || "") !== displayName) {
        await db.query(
          `UPDATE agency_profiles SET display_name = $2, updated_at = NOW() WHERE id = $1`,
          [byFemale.rows[0].id, displayName],
        );
        updated += 1;
      }
      continue;
    }

    const byUser = await db.query(
      `SELECT id FROM agency_profiles WHERE dream_username = $1 LIMIT 1`,
      [placeholderUser],
    );
    if (byUser.rows[0]) {
      await db.query(
        `UPDATE agency_profiles
         SET female_profile_id = $2, display_name = $3, updated_at = NOW()
         WHERE id = $1`,
        [byUser.rows[0].id, femaleProfileId, displayName],
      );
      updated += 1;
      continue;
    }

    await db.query(
      `INSERT INTO agency_profiles (
         female_profile_id, display_name, dream_username, password_enc, assigned_user_id, updated_at
       ) VALUES ($1, $2, $3, $4, NULL, NOW())`,
      [femaleProfileId, displayName, placeholderUser, emptyEnc],
    );
    created += 1;
  }

  return { created, updated };
}

export async function updateAgencyProfile(id, patch = {}) {
  const existing = await getAgencyProfileById(id);
  if (!existing) return { row: null, verifyWarning: "" };

  let femaleProfileId = existing.femaleProfileId;
  let displayName = existing.displayName;
  let dreamUsername = existing.dreamUsername;
  let passwordEnc = null;
  let verifyWarning = "";

  if (patch.username || patch.password) {
    const current = await getAgencyProfileRowRaw(id);
    const secrets = await getAgencyProfileSecrets(current);
    const nextUser = String(patch.username || secrets.dreamUsername || "").trim();
    const nextPass = String(patch.password || secrets.password || "");
    if (!nextUser || !nextPass) {
      throw new Error("Dream login and password are required");
    }
    if (/^agency:\d+$/i.test(nextUser)) {
      throw new Error("Enter the lady Dream login, not the agency placeholder");
    }

    const applyVerified = (verified) => {
      if (
        femaleProfileId &&
        verified.femaleProfileId &&
        Number(femaleProfileId) !== Number(verified.femaleProfileId)
      ) {
        throw new Error(
          `This Dream login belongs to profile ${verified.femaleProfileId}, expected ${femaleProfileId}`,
        );
      }
      femaleProfileId = verified.femaleProfileId || femaleProfileId;
      displayName =
        patch.displayName != null
          ? String(patch.displayName || "").trim() || verified.displayName
          : verified.displayName;
      dreamUsername = verified.dreamUsername;
      passwordEnc = encryptSecret(verified.dreamPassword);
    };

    // Agency-synced profiles already have female_profile_id. If live Dream login
    // fails from Render IP (even with 2captcha), still store the credentials —
    // Scan / LetterBot will verify later.
    if (femaleProfileId) {
      try {
        const verified = await verifyAndResolveDreamProfile({
          username: nextUser,
          password: nextPass,
          displayName: patch.displayName ?? displayName,
        });
        applyVerified(verified);
      } catch (error) {
        const msg = String(error?.message || error || "");
        if (/belongs to profile/i.test(msg) && /expected/i.test(msg)) {
          throw error;
        }
        console.warn(
          `[updateAgencyProfile] soft-save credentials for ${femaleProfileId}: ${msg}`,
        );
        dreamUsername = nextUser;
        passwordEnc = encryptSecret(nextPass);
        if (patch.displayName != null) {
          displayName = String(patch.displayName || "").trim() || displayName;
        }
        verifyWarning = msg;
      }
    } else {
      const verified = await verifyAndResolveDreamProfile({
        username: nextUser,
        password: nextPass,
        displayName: patch.displayName ?? displayName,
      });
      applyVerified(verified);
    }
  } else if (patch.displayName != null) {
    displayName = String(patch.displayName || "").trim() || displayName;
  }

  const db = getPool();
  const result = await db.query(
    `UPDATE agency_profiles
     SET female_profile_id = $2,
         display_name = $3,
         dream_username = $4,
         password_enc = COALESCE($5, password_enc),
         assigned_user_id = $6,
         updated_at = NOW()
     WHERE id = $1
     RETURNING *`,
    [
      Number(id),
      femaleProfileId,
      displayName,
      dreamUsername,
      passwordEnc,
      patch.assignedUserId === undefined
        ? existing.assignedUserId
        : patch.assignedUserId
          ? Number(patch.assignedUserId)
          : null,
    ],
  );
  const row = result.rows[0] || null;
  if (row) {
    const userChanged =
      Number(existing.assignedUserId || 0) !== Number(row.assigned_user_id || 0);
    const backdate = Boolean(parseAssignmentDay(patch.assignedAt));
    if (userChanged || (backdate && row.assigned_user_id)) {
      await recordAssignmentChange(
        db,
        row,
        existing.assignedUserId,
        row.assigned_user_id,
        patch.assignedAt,
      );
    }
  }
  return { row, verifyWarning };
}

async function getAgencyProfileRowRaw(id) {
  const db = getPool();
  const result = await db.query(`SELECT * FROM agency_profiles WHERE id = $1 LIMIT 1`, [
    Number(id),
  ]);
  return result.rows[0] || null;
}

export async function deleteAgencyProfile(id) {
  const db = getPool();
  const result = await db.query(`DELETE FROM agency_profiles WHERE id = $1 RETURNING id`, [
    Number(id),
  ]);
  return Boolean(result.rowCount);
}
