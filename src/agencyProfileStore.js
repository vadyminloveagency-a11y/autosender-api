import { getPool } from "./db.js";
import { decryptSecret, encryptSecret } from "./cryptoUtil.js";
import { dreamLogin } from "./dreamLogin.js";
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
  return result.rows[0];
}

export async function updateAgencyProfile(id, patch = {}) {
  const existing = await getAgencyProfileById(id);
  if (!existing) return null;

  let femaleProfileId = existing.femaleProfileId;
  let displayName = existing.displayName;
  let dreamUsername = existing.dreamUsername;
  let passwordEnc = null;

  if (patch.username || patch.password) {
    const current = await getAgencyProfileRowRaw(id);
    const secrets = await getAgencyProfileSecrets(current);
    const verified = await verifyAndResolveDreamProfile({
      username: patch.username || secrets.dreamUsername,
      password: patch.password || secrets.password,
      displayName: patch.displayName ?? displayName,
    });
    femaleProfileId = verified.femaleProfileId;
    displayName = verified.displayName;
    dreamUsername = verified.dreamUsername;
    passwordEnc = encryptSecret(verified.dreamPassword);
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
  return result.rows[0] || null;
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
