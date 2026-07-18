import express from "express";
import { adminMiddleware } from "../auth.js";
import {
  listAssignmentsForDreamDayRange,
  mapAgencyProfilesByFemaleId,
} from "../agencyProfileStore.js";
import {
  ensureAgencyFinanceTables,
  getAgencyFinanceCredentials,
  upsertAgencyFinanceCredentials,
} from "../agencyFinanceStore.js";
import {
  clearAgencyFinanceCaches,
  fetchBonusesByGirlRange,
} from "../dreamAgencyFinance.js";
import {
  loadCachedFinanceActionsRange,
  repairIncompleteFinanceDays,
} from "../agencyFinanceActionsCache.js";
import {
  listAgencyFinanceActions,
  listAgencyFinanceDaySyncs,
  listAgencyFinanceManQuestionnaires,
  listAgencyFinanceMen,
} from "../agencyFinanceActionsStore.js";
import { dreamDayKey } from "../dreamDay.js";
import { kyivDayKey } from "../mailingDailyStore.js";

const router = express.Router();

function parseFinanceDateRange(query, today) {
  const day = String(query?.date || "").slice(0, 10);
  let from = String(query?.from || query?.start || "").slice(0, 10);
  let to = String(query?.to || query?.end || "").slice(0, 10);
  if (/^\d{4}-\d{2}-\d{2}$/.test(day) && !from && !to) {
    from = day;
    to = day;
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from)) from = today;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(to)) to = from;
  if (from > to) {
    const swap = from;
    from = to;
    to = swap;
  }
  const fromMs = Date.parse(`${from}T00:00:00Z`);
  const toMs = Date.parse(`${to}T00:00:00Z`);
  const daySpan =
    Number.isFinite(fromMs) && Number.isFinite(toMs)
      ? Math.floor((toMs - fromMs) / 86_400_000) + 1
      : 1;
  if (daySpan > 62) {
    throw new Error("Date range too long (max 62 days)");
  }
  const profileId = String(query?.profileId || "").trim();
  return {
    from,
    to,
    date: from === to ? from : `${from}…${to}`,
    profileId: /^\d+$/.test(profileId) ? profileId : "",
    daySpan,
  };
}

function shiftIsoDay(dayKey, offsetDays) {
  const date = new Date(`${String(dayKey || "").slice(0, 10)}T00:00:00Z`);
  if (!Number.isFinite(date.getTime())) return "";
  date.setUTCDate(date.getUTCDate() + Number(offsetDays || 0));
  return date.toISOString().slice(0, 10);
}

function agencyActionTimestampMs(value) {
  const match = String(value || "").match(
    /^(\d{2})\/(\d{2})\/(\d{4})\s+(\d{2}):(\d{2}):(\d{2})$/,
  );
  if (!match) return NaN;
  const [, month, day, year, hour, minute, second] = match;
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

function pickDayOperators(assignments) {
  const byProfile = new Map();
  for (const item of Array.isArray(assignments) ? assignments : []) {
    const key = String(item.femaleProfileId || "");
    if (!key) continue;
    const prev = byProfile.get(key);
    if (!prev || (!prev.unassignedAt && item.unassignedAt)) {
      if (prev && !prev.unassignedAt) continue;
    }
    if (!prev || !item.unassignedAt || (prev.unassignedAt && item.assignedAt >= prev.assignedAt)) {
      byProfile.set(key, item);
    }
  }
  return byProfile;
}

function resolveOperatorForAction(action, assignmentsByProfile) {
  const key = String(action?.femaleProfileId || "");
  const list = assignmentsByProfile.get(key) || [];
  if (!list.length) return { operatorName: "", operatorEmail: "" };
  const at = agencyActionTimestampMs(action.occurredAt);
  if (!Number.isFinite(at)) {
    const open = list.find((item) => !item.unassignedAt) || list[list.length - 1];
    return {
      operatorName: open?.operatorName || "",
      operatorEmail: open?.operatorEmail || "",
    };
  }
  const match = list.find((item) => {
    const start = new Date(item.assignedAt).getTime();
    const end = item.unassignedAt ? new Date(item.unassignedAt).getTime() : Infinity;
    return at >= start && at < end;
  });
  return {
    operatorName: match?.operatorName || "",
    operatorEmail: match?.operatorEmail || "",
  };
}

router.get("/gold-men", adminMiddleware, async (req, res) => {
  try {
    const data = await listAgencyFinanceMen({
      search: req.query?.search,
      limit: req.query?.limit,
    });
    return res.json({ ok: true, ...data });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      men: [],
      coverage: {},
      error: error?.message || String(error),
    });
  }
});

router.get("/gold-men/questionnaires", adminMiddleware, async (req, res) => {
  try {
    const questionnaires = await listAgencyFinanceManQuestionnaires({
      maleProfileId: req.query?.maleProfileId,
      maleName: req.query?.maleName,
    });
    return res.json({ ok: true, questionnaires });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      questionnaires: [],
      error: error?.message || String(error),
    });
  }
});

router.post("/gold-men/sync-older", adminMiddleware, async (_req, res) => {
  try {
    const creds = await getAgencyFinanceCredentials();
    if (!creds.configured) {
      return res.status(400).json({
        ok: false,
        error: "Save the Dream agency login in Settings first.",
      });
    }
    const current = await listAgencyFinanceMen({ limit: 1 });
    const today = dreamDayKey() || kyivDayKey();
    const to = current.coverage.oldestSyncedDay
      ? shiftIsoDay(current.coverage.oldestSyncedDay, -1)
      : today;
    const from = shiftIsoDay(to, -13);
    // Force re-fetch so already-cached days can heal against Dream Grand Total.
    const synced = await loadCachedFinanceActionsRange(from, to, {
      force: true,
    });
    return res.json({
      ok: true,
      from,
      to,
      importedActions: Array.isArray(synced.actions) ? synced.actions.length : 0,
      missingDays: synced.missingDays || [],
      complete: Boolean(synced.complete),
      officialTotalUsd: synced.officialTotalUsd,
      actionsTotalUsd: synced.actionsTotalUsd,
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: error?.message || String(error),
    });
  }
});

router.post("/gold-men/sync-range", adminMiddleware, async (req, res) => {
  try {
    const creds = await getAgencyFinanceCredentials();
    if (!creds.configured) {
      return res.status(400).json({
        ok: false,
        error: "Save the Dream agency login in Settings first.",
      });
    }
    const today = dreamDayKey() || kyivDayKey();
    const range = parseFinanceDateRange(req.body || {}, today);
    if (range.daySpan > 14) {
      return res.status(400).json({
        ok: false,
        error: "Gold Men sync block is limited to 14 days.",
      });
    }
    const synced = await loadCachedFinanceActionsRange(range.from, range.to, {
      force: true,
    });
    return res.json({
      ok: true,
      from: range.from,
      to: range.to,
      importedActions: Array.isArray(synced.actions) ? synced.actions.length : 0,
      missingDays: synced.missingDays || [],
      complete: Boolean(synced.complete),
      officialTotalUsd: synced.officialTotalUsd,
      actionsTotalUsd: synced.actionsTotalUsd,
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: error?.message || String(error),
    });
  }
});

router.post("/gold-men/repair-incomplete", adminMiddleware, async (req, res) => {
  try {
    const creds = await getAgencyFinanceCredentials();
    if (!creds.configured) {
      return res.status(400).json({
        ok: false,
        error: "Save the Dream agency login in Settings first.",
      });
    }
    const limit = Math.min(62, Math.max(1, Number(req.body?.limit) || 14));
    const repaired = await repairIncompleteFinanceDays({ limit });
    return res.json({
      ok: true,
      ...repaired,
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: error?.message || String(error),
    });
  }
});

router.get("/balances-by-profile", adminMiddleware, async (req, res) => {
  try {
    const today = dreamDayKey() || kyivDayKey();
    const range = parseFinanceDateRange(req.query, today);

    const creds = await getAgencyFinanceCredentials();
    if (!creds.configured) {
      return res.json({
        ok: true,
        date: range.from,
        from: range.from,
        to: range.to,
        today,
        profileId: range.profileId || null,
        configured: false,
        profiles: [],
        error: "Save agency login in Settings",
      });
    }

    const cachedSyncs = await listAgencyFinanceDaySyncs(range.from, range.to).catch(
      () => [],
    );
    const canUsePostgres =
      cachedSyncs.length === range.daySpan &&
      cachedSyncs.every((row) => row.complete);
    const bonusRowsPromise = canUsePostgres
      ? listAgencyFinanceActions(range.from, range.to, range.profileId).then((actions) => {
          const byProfile = new Map();
          for (const action of actions) {
            const key = String(action.femaleProfileId || "");
            if (!key) continue;
            if (!byProfile.has(key)) {
              byProfile.set(key, {
                profileId: key,
                name: action.femaleName || "",
                amount: 0,
              });
            }
            byProfile.get(key).amount += Number(action.amountUsd) || 0;
          }
          return [...byProfile.values()].map((row) => ({
            ...row,
            amount: Number(row.amount.toFixed(2)),
          }));
        })
      : fetchBonusesByGirlRange(range.from, range.to, {
          force: Boolean(req.query?.force),
          profileId: range.profileId || 0,
        });

    const [bonusRows, profileMap, dayAssignments] = await Promise.all([
      bonusRowsPromise,
      mapAgencyProfilesByFemaleId().catch(() => new Map()),
      listAssignmentsForDreamDayRange(range.from, range.to).catch(() => []),
    ]);

    const operatorByProfile = pickDayOperators(dayAssignments);

    let profiles = bonusRows
      .map((bonus) => {
        const idNum = Number(bonus.profileId) || 0;
        const meta = idNum ? profileMap.get(idNum) : null;
        const assigned = operatorByProfile.get(String(bonus.profileId)) || null;
        return {
          profileId: String(bonus.profileId),
          displayName: meta?.displayName || bonus.name || "",
          dreamUsername: meta?.dreamUsername || "",
          photoUrl:
            meta?.photoUrl ||
            (idNum ? `https://profile-photos-cdn.dream-singles.com/im${idNum}_small.jpg` : ""),
          operatorName: assigned?.operatorName || meta?.operatorName || "",
          operatorEmail: assigned?.operatorEmail || meta?.operatorEmail || "",
          balanceUsd: Number(bonus.amount) || 0,
        };
      })
      .sort((a, b) => {
        if (b.balanceUsd !== a.balanceUsd) return b.balanceUsd - a.balanceUsd;
        return String(a.displayName || a.profileId).localeCompare(
          String(b.displayName || b.profileId),
          "en",
        );
      });

    if (range.profileId) {
      profiles = profiles.filter((row) => String(row.profileId) === range.profileId);
    }

    return res.json({
      ok: true,
      date: range.from,
      from: range.from,
      to: range.to,
      today,
      profileId: range.profileId || null,
      configured: true,
      totalUsd: Number(
        profiles.reduce((sum, row) => sum + (Number(row.balanceUsd) || 0), 0).toFixed(2),
      ),
      source: canUsePostgres ? "postgres" : "dream",
      profiles,
      error: null,
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      date: String(req.query?.date || req.query?.from || ""),
      from: String(req.query?.from || ""),
      to: String(req.query?.to || ""),
      configured: true,
      profiles: [],
      error: error?.message || String(error),
    });
  }
});

router.get("/bonuses-actions", adminMiddleware, async (req, res) => {
  try {
    const today = dreamDayKey() || kyivDayKey();
    const range = parseFinanceDateRange(req.query, today);

    const creds = await getAgencyFinanceCredentials();
    if (!creds.configured) {
      return res.json({
        ok: true,
        date: range.from,
        from: range.from,
        to: range.to,
        today,
        profileId: range.profileId || null,
        configured: false,
        totalUsd: 0,
        profiles: [],
        error: "Save agency login in Settings",
      });
    }

    const [cachedFinance, profileMap, dayAssignments] = await Promise.all([
      loadCachedFinanceActionsRange(range.from, range.to, {
        profileId: range.profileId,
        forceCurrent: Boolean(req.query?.refreshCurrent),
      }),
      mapAgencyProfilesByFemaleId().catch(() => new Map()),
      listAssignmentsForDreamDayRange(range.from, range.to).catch(() => []),
    ]);
    const actions = cachedFinance.actions;

    const assignmentsByProfile = new Map();
    for (const item of dayAssignments) {
      const key = String(item.femaleProfileId || "");
      if (!key) continue;
      if (!assignmentsByProfile.has(key)) assignmentsByProfile.set(key, []);
      assignmentsByProfile.get(key).push(item);
    }

    const byProfile = new Map();
    for (const action of actions) {
      const key = String(action.femaleProfileId || "");
      if (!key) continue;
      if (range.profileId && key !== range.profileId) continue;
      const idNum = Number(key) || 0;
      const meta = idNum ? profileMap.get(idNum) : null;
      const operator = resolveOperatorForAction(action, assignmentsByProfile);
      if (!byProfile.has(key)) {
        byProfile.set(key, {
          profileId: key,
          displayName: meta?.displayName || action.femaleName || "",
          dreamUsername: meta?.dreamUsername || "",
          photoUrl:
            meta?.photoUrl ||
            (idNum ? `https://profile-photos-cdn.dream-singles.com/im${idNum}_small.jpg` : ""),
          balanceUsd: 0,
          actions: [],
        });
      }
      const entry = byProfile.get(key);
      const amount = Number(action.amountUsd) || 0;
      entry.balanceUsd += amount;
      entry.actions.push({
        type: action.type || "Paid action",
        maleProfileId: action.maleProfileId || "",
        maleName: action.maleName || "",
        occurredAt: action.occurredAt || "",
        amountUsd: amount,
        operatorName: operator.operatorName,
        operatorEmail: operator.operatorEmail,
      });
    }

    const profiles = [...byProfile.values()]
      .map((entry) => ({
        ...entry,
        balanceUsd: Number(entry.balanceUsd.toFixed(2)),
        actions: entry.actions.sort((a, b) =>
          String(b.occurredAt).localeCompare(String(a.occurredAt)),
        ),
      }))
      .sort((a, b) => {
        if (b.balanceUsd !== a.balanceUsd) return b.balanceUsd - a.balanceUsd;
        return String(a.displayName || a.profileId).localeCompare(
          String(b.displayName || b.profileId),
          "en",
        );
      });

    const actionsSumUsd = Number(
      profiles.reduce((sum, row) => sum + (Number(row.balanceUsd) || 0), 0).toFixed(2),
    );
    const officialTotalUsd = range.profileId
      ? actionsSumUsd
      : Number(cachedFinance.officialTotalUsd) || actionsSumUsd;
    const totalsMatch =
      cachedFinance.complete &&
      Math.abs(actionsSumUsd - officialTotalUsd) < 0.05;
    const totalUsd = officialTotalUsd || actionsSumUsd;

    return res.json({
      ok: true,
      date: range.from,
      from: range.from,
      to: range.to,
      today,
      profileId: range.profileId || null,
      configured: true,
      totalUsd,
      actionsSumUsd,
      listIncomplete: !totalsMatch,
      missingDays: cachedFinance.missingDays,
      source: "postgres",
      profiles,
      error: totalsMatch
        ? null
        : `Cached action list is incomplete for: ${cachedFinance.missingDays.join(", ")}`,
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      date: String(req.query?.date || req.query?.from || ""),
      from: String(req.query?.from || ""),
      to: String(req.query?.to || ""),
      configured: true,
      totalUsd: 0,
      profiles: [],
      error: error?.message || String(error),
    });
  }
});

router.get("/credentials", adminMiddleware, async (_req, res) => {
  try {
    await ensureAgencyFinanceTables();
    const creds = await getAgencyFinanceCredentials();
    return res.json({
      ok: true,
      configured: Boolean(creds.configured),
      usernameMasked: creds.usernameMasked || "",
      source: creds.source || "",
      updatedAt: creds.updatedAt || null,
    });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error?.message || String(error) });
  }
});

router.post("/credentials", adminMiddleware, async (req, res) => {
  try {
    const username = String(req.body?.username || "").trim();
    const password = String(req.body?.password || "");
    const saved = await upsertAgencyFinanceCredentials({ username, password });
    clearAgencyFinanceCaches();
    return res.json({ ok: true, ...saved });
  } catch (error) {
    return res.status(400).json({ ok: false, error: error?.message || String(error) });
  }
});

export default router;
