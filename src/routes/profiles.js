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
  upsertAgencySyncedProfiles,
  verifyAndResolveDreamProfile,
} from "../agencyProfileStore.js";
import { encryptSecret } from "../cryptoUtil.js";
import { scrapeDreamInboxCloud } from "../inboxCloudScraper.js";
import { syncInboxMenItems } from "../inboxSync.js";
import { upsertDreamCredentials } from "../letterbotStore.js";
import { getPool } from "../db.js";
import {
  fetchAgencyProfiles,
  fetchBonusActions,
  fetchBonusesByGirlRange,
} from "../dreamAgencyFinance.js";
import { getAgencyFinanceCredentials } from "../agencyFinanceStore.js";
import { dreamDayKey } from "../dreamDay.js";

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

function hasDreamLadyLogin(username, password) {
  const user = String(username || "").trim();
  const pass = String(password || "");
  if (!user || !pass) return false;
  if (/^agency:\d+$/i.test(user)) return false;
  return true;
}

function mapAdminProfile(profile, password = "") {
  return {
    ...profile,
    password: password || null,
    hasDreamLogin: hasDreamLadyLogin(profile?.dreamUsername, password),
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

/** Pull Active Dream agency questionnaires into Account Manager. */
router.post("/admin/sync-dream", adminMiddleware, async (req, res) => {
  try {
    const creds = await getAgencyFinanceCredentials();
    if (!creds.configured) {
      return res.json({
        ok: true,
        configured: false,
        created: 0,
        updated: 0,
        count: 0,
        error: "Agency finance login not configured",
      });
    }
    const force = Boolean(req.body?.force);
    const dreamProfiles = await fetchAgencyProfiles({ status: "active", force });
    const result = await upsertAgencySyncedProfiles(dreamProfiles);
    return res.json({
      ok: true,
      configured: true,
      created: result.created,
      updated: result.updated,
      count: dreamProfiles.length,
    });
  } catch (error) {
    console.error(error);
    return res.status(500).json({
      ok: false,
      error: error?.message || "Failed to sync Dream profiles",
    });
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
    const raw = String(error?.message || error || "");
    if (/duplicate key|unique constraint|agency_profiles_dream_username/i.test(raw)) {
      return res.status(409).json({
        ok: false,
        error: "This Dream login is already added",
      });
    }
    return res.status(400).json({ ok: false, error: error?.message || "Failed to create profile" });
  }
});

router.patch("/admin/:id", adminMiddleware, async (req, res) => {
  try {
    const { row, verifyWarning } = await updateAgencyProfile(req.params.id, {
      username: req.body?.dreamUsername || req.body?.username,
      password: req.body?.password,
      displayName: req.body?.displayName || req.body?.name,
      assignedUserId: req.body?.assignedUserId,
      assignedAt: req.body?.assignedAt,
    });
    if (!row) {
      return res.status(404).json({ ok: false, error: "Profile not found" });
    }
    const profile = await getAgencyProfileById(row.id);
    const secrets = await getAgencyProfileSecrets(row);
    return res.json({
      ok: true,
      profile: mapAdminProfile(profile, secrets.password),
      verifyWarning: verifyWarning || "",
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

function dreamBusinessDay(value) {
  return dreamDayKey(value);
}

function monthBounds(day, today) {
  const month = String(day || today).slice(0, 7);
  const start = `${month}-01`;
  const [year, monthNumber] = month.split("-").map(Number);
  const lastDay = new Date(Date.UTC(year, monthNumber, 0))
    .toISOString()
    .slice(0, 10);
  return { month, start, end: month === today.slice(0, 7) ? today : lastDay };
}

function mergeProfileMonthRanges(history, start, end) {
  const byProfile = new Map();
  for (const item of history) {
    const profileId = String(item.femaleProfileId || "");
    const assignedDay = dreamBusinessDay(item.assignedAt);
    const unassignedDay = item.unassignedAt
      ? dreamBusinessDay(item.unassignedAt)
      : end;
    const rangeStart = assignedDay > start ? assignedDay : start;
    const rangeEnd = unassignedDay && unassignedDay < end ? unassignedDay : end;
    if (!profileId || !rangeStart || rangeStart > rangeEnd) continue;
    if (!byProfile.has(profileId)) {
      byProfile.set(profileId, {
        profileId,
        displayName: item.displayName || `Profile ${profileId}`,
        dreamUsername: item.dreamUsername || "",
        photoUrl: item.photoUrl || "",
        ranges: [],
      });
    }
    byProfile.get(profileId).ranges.push({ start: rangeStart, end: rangeEnd });
  }

  for (const profile of byProfile.values()) {
    profile.ranges.sort((a, b) => a.start.localeCompare(b.start));
    profile.ranges = profile.ranges.reduce((merged, range) => {
      const previous = merged[merged.length - 1];
      if (!previous || range.start > previous.end) {
        merged.push({ ...range });
      } else if (range.end > previous.end) {
        previous.end = range.end;
      }
      return merged;
    }, []);
  }
  return [...byProfile.values()];
}

async function loadOperatorMonthBalance(history, selectedDay, today) {
  const bounds = monthBounds(selectedDay, today);
  const profiles = mergeProfileMonthRanges(history, bounds.start, bounds.end);
  await Promise.all(
    profiles.map(async (profile) => {
      const amounts = await Promise.all(
        profile.ranges.map(async (range) => {
          const rows = await fetchBonusesByGirlRange(range.start, range.end, {
            profileId: profile.profileId,
          });
          return rows
            .filter((row) => String(row.profileId) === profile.profileId)
            .reduce((sum, row) => sum + (Number(row.amount) || 0), 0);
        }),
      );
      profile.balanceUsd = Number(
        amounts.reduce((sum, amount) => sum + amount, 0).toFixed(2),
      );
      delete profile.ranges;
    }),
  );
  profiles.sort((a, b) => b.balanceUsd - a.balanceUsd);
  return {
    month: bounds.month,
    totalUsd: Number(
      profiles.reduce((sum, profile) => sum + profile.balanceUsd, 0).toFixed(2),
    ),
    profiles,
  };
}

router.get("/balances", authMiddleware, async (req, res) => {
  try {
    const today = dreamDayKey();
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
    let monthBalance = null;
    try {
      monthBalance = await loadOperatorMonthBalance(history, date, today);
    } catch (monthError) {
      monthBalance = {
        month: date.slice(0, 7),
        totalUsd: 0,
        profiles: [],
        error: monthError?.message || String(monthError),
      };
    }

    return res.json({
      ok: true,
      date,
      today,
      totalUsd: Number(
        profiles.reduce((sum, profile) => sum + profile.balanceUsd, 0).toFixed(2),
      ),
      profiles,
      history,
      month: monthBalance,
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: error?.message || String(error),
      profiles: [],
      history: [],
      month: null,
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
