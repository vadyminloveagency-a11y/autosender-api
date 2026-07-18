import { createHash } from "node:crypto";
import {
  getAgencyFinanceDaySync,
  listAgencyFinanceActions,
  listAgencyFinanceDaySyncs,
  listIncompleteAgencyFinanceDays,
  markAgencyFinanceDaySyncError,
  saveAgencyFinanceDay,
} from "./agencyFinanceActionsStore.js";
import {
  fetchBonusActionsDayDetail,
  fetchBonusesByGirl,
} from "./dreamAgencyFinance.js";
import { dreamDayKey } from "./dreamDay.js";
import { getAgencyFinanceCredentials } from "./agencyFinanceStore.js";

const CURRENT_DAY_TTL_MS = 5 * 60_000;
const INCOMPLETE_RETRY_TTL_MS = 15 * 60_000;
const syncLocks = new Map();

function validDay(value) {
  const day = String(value || "").slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : "";
}

function eachDayKey(fromDay, toDay) {
  const days = [];
  let current = fromDay;
  while (current <= toDay) {
    days.push(current);
    const [year, month, day] = current.split("-").map(Number);
    current = new Date(Date.UTC(year, month - 1, day + 1))
      .toISOString()
      .slice(0, 10);
  }
  return days;
}

function actionKey(action) {
  return createHash("sha256")
    .update(
      [
        action.type,
        action.maleProfileId,
        action.maleName,
        action.femaleProfileId,
        action.femaleName,
        action.occurredAt,
        Number(action.amountUsd) || 0,
      ].join("|"),
    )
    .digest("hex");
}

function shouldRefreshDay(day, state, { force = false, forceCurrent = false } = {}) {
  if (force) return true;
  if (!state) return true;
  const now = Date.now();
  const age = now - new Date(state.syncedAt || 0).getTime();
  const today = dreamDayKey();
  if (day === today) {
    return forceCurrent || !Number.isFinite(age) || age >= CURRENT_DAY_TTL_MS;
  }
  if (state.complete) {
    // A "complete" snapshot taken while that Dream day was still open is not
    // final. Refresh it once after the 10:00 Kyiv boundary has passed.
    const syncedDreamDay = state.syncedAt
      ? dreamDayKey(new Date(state.syncedAt))
      : "";
    return syncedDreamDay === day;
  }
  return !Number.isFinite(age) || age >= INCOMPLETE_RETRY_TTL_MS;
}

async function resolveOfficialTotalUsd(day, detail, { forceDream = false } = {}) {
  if (detail?.officialTotalUsd != null && Number.isFinite(Number(detail.officialTotalUsd))) {
    return Number(Number(detail.officialTotalUsd).toFixed(2));
  }
  try {
    const grouped = await fetchBonusesByGirl(day, { force: forceDream, profileId: 0 });
    return Number(
      (Array.isArray(grouped) ? grouped : [])
        .reduce((sum, row) => sum + (Number(row.amount) || 0), 0)
        .toFixed(2),
    );
  } catch (_) {
    return Number(
      (Array.isArray(detail?.actions) ? detail.actions : [])
        .reduce((sum, row) => sum + (Number(row.amountUsd) || 0), 0)
        .toFixed(2),
    );
  }
}

async function syncOneDay(day, { force = false, forceCurrent = false } = {}) {
  const existing = await getAgencyFinanceDaySync(day);
  if (!shouldRefreshDay(day, existing, { force, forceCurrent })) return existing;
  if (syncLocks.has(day)) return syncLocks.get(day);

  const task = (async () => {
    try {
      // Always hit Dream on an intentional refresh so incomplete/wrong days can heal.
      const forceDream = true;
      const detail = await fetchBonusActionsDayDetail(day, { force: forceDream });
      const normalized = (Array.isArray(detail.actions) ? detail.actions : []).map(
        (action) => ({
          ...action,
          actionKey: actionKey(action),
        }),
      );
      const officialTotalUsd = await resolveOfficialTotalUsd(day, detail, { forceDream });
      const actionsTotalUsd = Number(
        normalized
          .reduce((sum, row) => sum + (Number(row.amountUsd) || 0), 0)
          .toFixed(2),
      );
      const complete = Math.abs(actionsTotalUsd - officialTotalUsd) < 0.05;
      const error = complete
        ? ""
        : `Cached $${actionsTotalUsd.toFixed(2)} of Dream total $${officialTotalUsd.toFixed(2)}`;
      return await saveAgencyFinanceDay({
        dayKey: day,
        actions: normalized,
        officialTotalUsd,
        complete,
        error,
      });
    } catch (error) {
      await markAgencyFinanceDaySyncError(day, error).catch(() => {});
      const cached = await getAgencyFinanceDaySync(day).catch(() => null);
      if (cached?.actionCount) return cached;
      throw error;
    } finally {
      syncLocks.delete(day);
    }
  })();

  syncLocks.set(day, task);
  return task;
}

export async function loadCachedFinanceActionsRange(
  fromDay,
  toDay = fromDay,
  { profileId = "", force = false, forceCurrent = false } = {},
) {
  const from = validDay(fromDay);
  const to = validDay(toDay);
  if (!from || !to || from > to) throw new Error("Invalid finance date range");
  const days = eachDayKey(from, to);

  // Two days at a time keeps Dream traffic controlled during first import.
  for (let index = 0; index < days.length; index += 2) {
    await Promise.all(
      days
        .slice(index, index + 2)
        .map((day) => syncOneDay(day, { force, forceCurrent })),
    );
  }

  const [actions, syncs] = await Promise.all([
    listAgencyFinanceActions(from, to, profileId),
    listAgencyFinanceDaySyncs(from, to),
  ]);
  const syncByDay = new Map(syncs.map((row) => [row.day, row]));
  const missingDays = days.filter((day) => !syncByDay.get(day)?.complete);
  return {
    from,
    to,
    actions,
    syncs,
    complete: missingDays.length === 0,
    missingDays,
    officialTotalUsd: Number(
      syncs.reduce((sum, row) => sum + (Number(row.officialTotalUsd) || 0), 0).toFixed(2),
    ),
    actionsTotalUsd: Number(
      actions.reduce((sum, row) => sum + (Number(row.amountUsd) || 0), 0).toFixed(2),
    ),
  };
}

/** Re-fetch incomplete cached days against Dream Grand Total, oldest first. */
export async function repairIncompleteFinanceDays({ limit = 14 } = {}) {
  const rows = await listIncompleteAgencyFinanceDays({
    limit: Math.min(62, Math.max(1, Number(limit) || 14)),
  });
  const days = rows.map((row) => row.day).filter(Boolean);
  const results = [];
  for (let index = 0; index < days.length; index += 1) {
    // One day at a time for stubborn incomplete days: split-by-girl is heavy.
    const synced = await syncOneDay(days[index], { force: true });
    results.push(synced);
  }
  return {
    days: results.map((row) => row?.day).filter(Boolean),
    repaired: results.filter((row) => row?.complete).length,
    stillIncomplete: results.filter((row) => row && !row.complete).length,
    details: results.map((row) => ({
      day: row?.day || "",
      complete: Boolean(row?.complete),
      officialTotalUsd: Number(row?.officialTotalUsd) || 0,
      actionsTotalUsd: Number(row?.actionsTotalUsd) || 0,
      error: String(row?.error || ""),
    })),
    officialTotalUsd: Number(
      results.reduce((sum, row) => sum + (Number(row?.officialTotalUsd) || 0), 0).toFixed(2),
    ),
    actionsTotalUsd: Number(
      results.reduce((sum, row) => sum + (Number(row?.actionsTotalUsd) || 0), 0).toFixed(2),
    ),
  };
}

export async function refreshCurrentFinanceActionsCache() {
  const credentials = await getAgencyFinanceCredentials();
  if (!credentials.configured) return null;
  const today = dreamDayKey();
  const [year, month, day] = today.split("-").map(Number);
  const previous = new Date(Date.UTC(year, month - 1, day - 1))
    .toISOString()
    .slice(0, 10);
  const [previousState, currentState] = await Promise.all([
    syncOneDay(previous),
    syncOneDay(today, { forceCurrent: true }),
  ]);
  return { previous: previousState, current: currentState };
}
