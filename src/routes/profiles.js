import express from "express";
import { adminMiddleware, authMiddleware } from "../auth.js";
import {
  createAgencyProfile,
  deleteAgencyProfile,
  listAgencyProfilesAssignedToUser,
  getAgencyProfileAssignedToUser,
  getAgencyProfileById,
  getAgencyProfileSecrets,
  listAgencyProfiles,
  listProfileAssignmentsForUserDay,
  listProfileAssignmentHistoryForUser,
  updateAgencyProfile,
  verifyAndResolveDreamProfile,
} from "../agencyProfileStore.js";
import { encryptSecret } from "../cryptoUtil.js";
import { scrapeDreamInboxCloud } from "../inboxCloudScraper.js";
import { syncInboxMenItems } from "../inboxSync.js";
import { upsertDreamCredentials } from "../letterbotStore.js";
import { getPool } from "../db.js";
import { fetchBonusActions } from "../dreamAgencyFinance.js";

const router = express.Router();

function mapPublicProfile(row) {
  if (!row) return null;
  const femaleProfileId = row.female_profile_id ? Number(row.female_profile_id) : null;
  return {
    id: row.id,
    femaleProfileId,
    displayName: row.display_name || "",
    dreamUsername: row.dream_username || "",
    photoUrl: femaleProfileId
      ? `https://profile-photos-cdn.dream-singles.com/im${femaleProfileId}_small.jpg`
      : "",
    assignedUserId: row.assigned_user_id ? Number(row.assigned_user_id) : null,
  };
}

function mapAdminProfile(profile, password = "") {
  return {
    ...profile,
    password: password || null,
  };
}

async function getAgencyProfileRowById(id) {
  const db = getPool();
  const result = await db.query(`SELECT * FROM agency_profiles WHERE id = $1 LIMIT 1`, [
    Number(id),
  ]);
  return result.rows[0] || null;
}

async function runAgencyProfileScan(profileRow, { maxPages = 3, addedBy = "admin" } = {}) {
  const secrets = await getAgencyProfileSecrets(profileRow);
  if (!secrets?.dreamUsername || !secrets.password) {
    throw new Error("Dream credentials are missing for this profile");
  }

  const scrapeResult = await scrapeDreamInboxCloud({
    username: secrets.dreamUsername,
    password: secrets.password,
    maxPages,
    onProgress() {},
  });

  const femaleProfileId = Number(scrapeResult.femaleProfileId || profileRow.female_profile_id);
  if (!femaleProfileId) {
    throw new Error("Could not detect questionnaire ID during scan");
  }

  if (Number(profileRow.female_profile_id) !== femaleProfileId) {
    const db = getPool();
    await db.query(
      `UPDATE agency_profiles SET female_profile_id = $2, updated_at = NOW() WHERE id = $1`,
      [profileRow.id, femaleProfileId],
    );
  }

  const items = (scrapeResult.items || []).map((item, index) => ({
    ...item,
    inboxOrder: index + 1,
    letterCount:
      Number(item.letterCount) ||
      Number(scrapeResult.letterCounts?.[item.maleProfileId]) ||
      1,
  }));

  const sync = await syncInboxMenItems(femaleProfileId, items, addedBy);
  return {
    femaleProfileId,
    pagesScraped: scrapeResult.pagesScraped || 0,
    men: items.length,
    synced: sync.synced,
    added: sync.added,
  };
}

router.get("/admin/list", adminMiddleware, async (_req, res) => {
  try {
    const profiles = await listAgencyProfiles();
    const withPasswords = [];
    for (const profile of profiles) {
      const row = await getAgencyProfileRowById(profile.id);
      const secrets = await getAgencyProfileSecrets(row);
      withPasswords.push(mapAdminProfile(profile, secrets.password));
    }
    return res.json({ ok: true, profiles: withPasswords });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ ok: false, error: error?.message || "Failed to load profiles" });
  }
});

router.post("/admin", adminMiddleware, async (req, res) => {
  try {
    const row = await createAgencyProfile({
      username: req.body?.dreamUsername || req.body?.username,
      password: req.body?.password,
      displayName: req.body?.displayName || req.body?.name,
      assignedUserId: req.body?.assignedUserId,
    });
    const profile = await getAgencyProfileById(row.id);
    const secrets = await getAgencyProfileSecrets(row);
    return res.json({
      ok: true,
      profile: mapAdminProfile(profile, secrets.password),
    });
  } catch (error) {
    console.error(error);
    return res.status(400).json({ ok: false, error: error?.message || "Failed to create profile" });
  }
});

router.patch("/admin/:id", adminMiddleware, async (req, res) => {
  try {
    const row = await updateAgencyProfile(req.params.id, {
      username: req.body?.dreamUsername || req.body?.username,
      password: req.body?.password,
      displayName: req.body?.displayName || req.body?.name,
      assignedUserId: req.body?.assignedUserId,
    });
    if (!row) {
      return res.status(404).json({ ok: false, error: "Profile not found" });
    }
    const profile = await getAgencyProfileById(row.id);
    const secrets = await getAgencyProfileSecrets(row);
    return res.json({
      ok: true,
      profile: mapAdminProfile(profile, secrets.password),
    });
  } catch (error) {
    console.error(error);
    return res.status(400).json({ ok: false, error: error?.message || "Failed to update profile" });
  }
});

router.delete("/admin/:id", adminMiddleware, async (req, res) => {
  try {
    const deleted = await deleteAgencyProfile(req.params.id);
    if (!deleted) {
      return res.status(404).json({ ok: false, error: "Profile not found" });
    }
    return res.json({ ok: true, deleted: true });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ ok: false, error: error?.message || "Failed to delete profile" });
  }
});

router.post("/admin/:id/scan", adminMiddleware, async (req, res) => {
  try {
    const row = await getAgencyProfileRowById(req.params.id);
    if (!row) {
      return res.status(404).json({ ok: false, error: "Profile not found" });
    }
    const maxPages =
      req.body?.maxPages === 0 || req.body?.maxPages === "0"
        ? 0
        : Number(req.body?.maxPages ?? 3);
    const result = await runAgencyProfileScan(row, {
      maxPages,
      addedBy: req.user?.email || "admin",
    });
    return res.json({ ok: true, ...result });
  } catch (error) {
    console.error(error);
    return res.status(400).json({ ok: false, error: error?.message || "Scan failed" });
  }
});

router.get("/mine", authMiddleware, async (req, res) => {
  try {
    const rows = await listAgencyProfilesAssignedToUser(req.user.id);
    const profiles = rows.map((row) => mapPublicProfile(row));
    return res.json({
      ok: true,
      assigned: profiles.length > 0,
      profiles,
      profile: profiles[0] || null,
      userId: Number(req.user.id) || null,
      userEmail: req.user.email || "",
      userRole: req.user.role || "operator",
    });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ ok: false, error: error?.message || "Failed to load profile", profiles: [] });
  }
});

function agencyActionTimestampMs(value) {
  const match = String(value || "").match(
    /^(\d{2})\/(\d{2})\/(\d{4})\s+(\d{2}):(\d{2}):(\d{2})$/,
  );
  if (!match) return NaN;
  const [, month, day, year, hour, minute, second] = match;
  // Agency reports use the office calendar. Approximate as Kyiv local time;
  // the one-hour DST correction is derived for the action's month.
  const utcGuess = Date.UTC(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second),
  );
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Kyiv",
    timeZoneName: "longOffset",
  }).formatToParts(new Date(utcGuess));
  const offsetText =
    parts.find((part) => part.type === "timeZoneName")?.value || "GMT+00:00";
  const offsetMatch = offsetText.match(/GMT([+-])(\d{2}):?(\d{2})?/);
  const sign = offsetMatch?.[1] === "-" ? -1 : 1;
  const offsetMinutes = offsetMatch
    ? sign * (Number(offsetMatch[2]) * 60 + Number(offsetMatch[3] || 0))
    : 0;
  return utcGuess - offsetMinutes * 60_000;
}

function actionFallsInAssignment(action, assignment) {
  const at = agencyActionTimestampMs(action.occurredAt);
  if (!Number.isFinite(at)) return true;
  const start = new Date(assignment.assignedAt).getTime();
  const end = assignment.unassignedAt
    ? new Date(assignment.unassignedAt).getTime()
    : Infinity;
  return at >= start && at <= end;
}

router.get("/balances", authMiddleware, async (req, res) => {
  try {
    const today = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Europe/Kyiv",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date());
    let date = String(req.query?.date || today).slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) date = today;

    const [assignments, history, agencyActions] = await Promise.all([
      listProfileAssignmentsForUserDay(req.user.id, date),
      listProfileAssignmentHistoryForUser(req.user.id),
      fetchBonusActions(date),
    ]);
    const byProfile = new Map();
    for (const assignment of assignments) {
      const key = String(assignment.femaleProfileId);
      if (!byProfile.has(key)) {
        byProfile.set(key, {
          profileId: key,
          agencyProfileId: assignment.agencyProfileId,
          displayName: assignment.displayName || `Profile ${key}`,
          dreamUsername: assignment.dreamUsername || "",
          photoUrl: assignment.photoUrl || "",
          balanceUsd: 0,
          actions: [],
          assignments: [],
        });
      }
      byProfile.get(key).assignments.push(assignment);
    }

    for (const action of agencyActions) {
      const entry = byProfile.get(String(action.femaleProfileId));
      if (
        !entry ||
        !entry.assignments.some((assignment) =>
          actionFallsInAssignment(action, assignment),
        )
      ) {
        continue;
      }
      entry.actions.push(action);
      entry.balanceUsd += Number(action.amountUsd) || 0;
    }

    const profiles = [...byProfile.values()]
      .map(({ assignments: _assignments, ...entry }) => ({
        ...entry,
        balanceUsd: Number(entry.balanceUsd.toFixed(2)),
        actions: entry.actions.sort((a, b) =>
          String(b.occurredAt).localeCompare(String(a.occurredAt)),
        ),
      }))
      .sort((a, b) => {
        if (b.balanceUsd !== a.balanceUsd) return b.balanceUsd - a.balanceUsd;
        return String(a.displayName).localeCompare(String(b.displayName), "en");
      });

    return res.json({
      ok: true,
      date,
      today,
      totalUsd: Number(
        profiles.reduce((sum, profile) => sum + profile.balanceUsd, 0).toFixed(2),
      ),
      profiles,
      history,
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: error?.message || String(error),
      profiles: [],
      history: [],
      totalUsd: 0,
    });
  }
});

async function resolveAssignedProfileRow(userId, agencyProfileId) {
  const id = Number(agencyProfileId);
  if (id) {
    const row = await getAgencyProfileRowById(id);
    if (!row || Number(row.assigned_user_id) !== Number(userId)) {
      return null;
    }
    return row;
  }
  return getAgencyProfileAssignedToUser(userId);
}

router.post("/connect", authMiddleware, async (req, res) => {
  try {
    const row = await resolveAssignedProfileRow(req.user.id, req.body?.agencyProfileId);
    if (!row) {
      const hasAny = (await listAgencyProfilesAssignedToUser(req.user.id)).length > 0;
      return res.json({
        ok: false,
        assigned: hasAny,
        error: hasAny
          ? "Questionnaire not assigned to you"
          : "No questionnaire assigned by director",
      });
    }

    const secrets = await getAgencyProfileSecrets(row);
    if (!secrets?.dreamUsername || !secrets.password) {
      return res.status(400).json({ ok: false, error: "Dream credentials are missing for this profile" });
    }

    const dreamUsername = String(secrets.dreamUsername || "").trim();
    const dreamPassword = String(secrets.password || "");
    let femaleProfileId = Number(row.female_profile_id) || 0;
    let displayName = String(secrets.displayName || row.display_name || "").trim();

    if (!femaleProfileId) {
      const verified = await verifyAndResolveDreamProfile({
        username: dreamUsername,
        password: dreamPassword,
        displayName,
      });
      femaleProfileId = Number(verified.femaleProfileId);
      displayName = verified.displayName || displayName;
      const db = getPool();
      await db.query(
        `UPDATE agency_profiles SET female_profile_id = $2, display_name = COALESCE(NULLIF($3, ''), display_name), updated_at = NOW() WHERE id = $1`,
        [row.id, femaleProfileId, displayName],
      );
    }

    const profileId = String(femaleProfileId);

    await upsertDreamCredentials({
      userId: req.user.id,
      profileId,
      username: dreamUsername,
      passwordEnc: encryptSecret(dreamPassword),
    });

    const photoUrl = `https://profile-photos-cdn.dream-singles.com/im${femaleProfileId}_small.jpg`;
    return res.json({
      ok: true,
      assigned: true,
      agencyProfileId: row.id,
      femaleProfileId,
      displayName: displayName || `Profile ${femaleProfileId}`,
      photoUrl,
      dreamUsername,
      cloudConnect: true,
      browserLogin: {
        username: dreamUsername,
        password: dreamPassword,
      },
    });
  } catch (error) {
    console.error(error);
    return res.status(400).json({ ok: false, error: error?.message || "Cloud connect failed" });
  }
});

export default router;
