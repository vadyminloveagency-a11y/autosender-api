import {
  getAgencyFinanceCredentials,
} from "./agencyFinanceStore.js";

const ORIGIN = "https://agency.dream-singles.com";
const LOGIN_URL = `${ORIGIN}/login`;
const LOGIN_CHECK_URL = `${ORIGIN}/login_check`;
const BONUSES_URL = `${ORIGIN}/finances/bonuses`;

/** @type {{ cookieHeader: string, expAt: number } | null} */
let sessionCache = null;
/** @type {Map<string, { at: number, rows: Array<{ profileId: string, name: string, amount: number }> }>} */
const dayCache = new Map();
/** @type {Map<string, { at: number, actions: Array<object> }>} */
const detailCache = new Map();
const SESSION_TTL_MS = 45 * 60_000;
const DAY_CACHE_TTL_MS = 3 * 60_000;
const DETAIL_CACHE_TTL_MS = 60_000;

function cookieMapFromHeader(header) {
  const jar = new Map();
  for (const part of String(header || "")
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean)) {
    const eq = part.indexOf("=");
    if (eq > 0) jar.set(part.slice(0, eq), part.slice(eq + 1));
  }
  return jar;
}

function parseSetCookieHeaders(response) {
  const list =
    typeof response.headers.getSetCookie === "function"
      ? response.headers.getSetCookie()
      : [];
  const out = Array.isArray(list) ? [...list] : [];
  if (!out.length) {
    const single = response.headers.get("set-cookie");
    if (single) out.push(single);
  }
  return out;
}

function applySetCookies(jar, response) {
  for (const line of parseSetCookieHeaders(response)) {
    const part = String(line || "").split(";")[0];
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    jar.set(part.slice(0, eq).trim(), part.slice(eq + 1).trim());
  }
}

function cookieHeaderFromJar(jar) {
  return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
}

function extractCsrf(html) {
  const match =
    String(html || "").match(/name="_csrf_token"\s+value="([^"]+)"/i) ||
    String(html || "").match(/name="form\[_token\]"\s+value="([^"]+)"/i);
  return match?.[1] || "";
}

function parseMoney(value) {
  const raw = String(value || "").replace(/[^0-9.,-]/g, "").replace(/,/g, "");
  const num = Number(raw);
  return Number.isFinite(num) ? num : 0;
}

function stripTags(html) {
  return String(html || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/\s+/g, " ")
    .trim();
}

/** Parse Group By Girl table rows: [17838562] Name | $4.50 */
export function parseBonusesGroupedByGirl(html) {
  const raw = String(html || "");
  const rows = [];
  const trMatches = raw.matchAll(/<tr[\s\S]*?<\/tr>/gi);
  for (const tr of trMatches) {
    const cells = [...tr[0].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((m) =>
      stripTags(m[1]),
    );
    if (cells.length < 2) continue;
    const girl = cells[0];
    const amountCell = cells[cells.length - 1];
    const idMatch = girl.match(/\[(\d{5,})\]/);
    if (!idMatch) continue;
    const amount = parseMoney(amountCell);
    if (!Number.isFinite(amount)) continue;
    const name = girl.replace(/\[[\d]+\]\s*/, "").trim();
    rows.push({
      profileId: idMatch[1],
      name,
      amount,
    });
  }
  return rows;
}

/** Parse regular bonuses table: action, man, questionnaire, time and amount. */
export function parseBonusActions(html) {
  const actions = [];
  for (const tr of String(html || "").matchAll(/<tr[\s\S]*?<\/tr>/gi)) {
    const cells = [...tr[0].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((m) =>
      stripTags(m[1]),
    );
    if (cells.length < 5) continue;
    if (/^Type of Bonus$/i.test(cells[0]) || /Total$/i.test(cells[0])) continue;

    // Dream sometimes inserts an extra utility column; keep the first five semantic cells.
    const type = cells[0];
    const manCell = cells[1];
    const womanCell = cells[2];
    const dateCell = cells[3];
    const amountCell = cells[cells.length - 1];

    const manMatch =
      manCell.match(/^(\d{5,})\s*(.*)$/) ||
      manCell.match(/(\d{5,})\s*(.*)$/);
    const womanMatch =
      womanCell.match(/^\[(\d{5,})\]\s*(.*)$/) ||
      womanCell.match(/\[(\d{5,})\]\s*(.*)$/);
    const amount = parseMoney(amountCell);
    if (!womanMatch || !Number.isFinite(amount)) continue;

    actions.push({
      type,
      maleProfileId: manMatch?.[1] || "",
      maleName: String(manMatch?.[2] || manCell || "").trim(),
      femaleProfileId: womanMatch[1],
      femaleName: String(womanMatch[2] || "").trim(),
      occurredAt: dateCell,
      amountUsd: amount,
    });
  }
  return actions;
}

function eachDreamDayKey(startDay, endDay) {
  const days = [];
  let cur = startDay;
  while (cur <= endDay) {
    days.push(cur);
    const [year, month, day] = cur.split("-").map(Number);
    const next = new Date(Date.UTC(year, month - 1, day + 1));
    cur = next.toISOString().slice(0, 10);
  }
  return days;
}

function bonusesUrl(startDay, groupBy, page = 1, endDay = startDay, profileId = 0) {
  const url = new URL(BONUSES_URL);
  // Dream agency form accepts ISO dates (verified against live curls).
  url.searchParams.set("form[startDate]", String(startDay || "").slice(0, 10));
  url.searchParams.set("form[endDate]", String(endDay || startDay || "").slice(0, 10));
  url.searchParams.set("form[type]", "0");
  url.searchParams.set("form[profileId]", String(Number(profileId) || 0));
  url.searchParams.set("form[groupBy]", String(groupBy));
  url.searchParams.set("form[extra]", "");
  if (page > 1) url.searchParams.set("page", String(page));
  return url;
}

const MAX_BONUS_PAGES = 500;

function maxPaginationPage(html) {
  let max = 1;
  for (const match of String(html || "").matchAll(/(?:[?&]|&amp;)page=(\d+)/gi)) {
    max = Math.max(max, Number(match[1]) || 1);
  }
  return Math.min(max, MAX_BONUS_PAGES);
}

/** Official Dream table total from detail view footer. */
export function parseBonusGrandTotal(html) {
  const text = stripTags(html);
  const grand = text.match(/Grand\s*Total[^$]*\$\s*([0-9.,]+)/i);
  if (grand) return parseMoney(grand[1]);
  return null;
}

function actionDedupeKey(action) {
  return [
    action.type,
    action.maleProfileId,
    action.femaleProfileId,
    action.occurredAt,
    action.amountUsd,
  ].join("|");
}

function filterRequestedActions(actions, profileId = 0) {
  const pid = Number(profileId) || 0;
  return (Array.isArray(actions) ? actions : []).filter((action) => {
    if (pid && String(action.femaleProfileId) !== String(pid)) return false;
    return true;
  });
}

function sumActionsUsd(actions) {
  return Number(
    (Array.isArray(actions) ? actions : [])
      .reduce((sum, row) => sum + (Number(row.amountUsd) || 0), 0)
      .toFixed(2),
  );
}

async function fetchWithCookies(url, { method = "GET", headers = {}, body, jar, maxRedirects = 8 } = {}) {
  let current = String(url);
  let currentMethod = method;
  let currentBody = body;
  for (let i = 0; i <= maxRedirects; i += 1) {
    const response = await fetch(current, {
      method: currentMethod,
      redirect: "manual",
      signal: AbortSignal.timeout(25000),
      headers: {
        ...headers,
        Cookie: cookieHeaderFromJar(jar),
      },
      body: currentBody,
    });
    applySetCookies(jar, response);
    const status = response.status;
    if (status >= 300 && status < 400) {
      const location = response.headers.get("location");
      if (!location) {
        return { response, html: await response.text(), jar };
      }
      current = new URL(location, current).toString();
      // POST login_check → GET home
      currentMethod = "GET";
      currentBody = undefined;
      // Drain body before following.
      try {
        await response.arrayBuffer();
      } catch (_) {}
      continue;
    }
    const html = await response.text();
    return { response, html, jar };
  }
  throw new Error("Agency login: too many redirects");
}

async function loginAgency() {
  const creds = await getAgencyFinanceCredentials();
  if (!creds.configured) {
    throw new Error(
      "Agency finance login not configured — save login in Balances section",
    );
  }

  const jar = new Map();
  const loginPage = await fetchWithCookies(LOGIN_URL, {
    method: "GET",
    jar,
    headers: {
      Accept: "text/html,application/xhtml+xml",
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    },
  });
  const csrf = extractCsrf(loginPage.html);
  if (!csrf) throw new Error("Agency login CSRF not found");

  const body = new URLSearchParams({
    _username: creds.username,
    _password: creds.password,
    _csrf_token: csrf,
    _remember_me: "on",
  });

  const after = await fetchWithCookies(LOGIN_CHECK_URL, {
    method: "POST",
    jar,
    headers: {
      Accept: "text/html,application/xhtml+xml",
      "Content-Type": "application/x-www-form-urlencoded",
      Origin: ORIGIN,
      Referer: LOGIN_URL,
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    },
    body,
  });

  const cookieHeader = cookieHeaderFromJar(jar);
  const loggedIn =
    /logout/i.test(after.html) ||
    /DSAGPHPSESSION|REMEMBERME_AGENCY/i.test(cookieHeader);
  const stillLogin =
    /id="_username"/i.test(after.html) && /name="_password"/i.test(after.html);
  if (!loggedIn || stillLogin) {
    throw new Error("Agency login failed — check username/password");
  }

  sessionCache = { cookieHeader, expAt: Date.now() + SESSION_TTL_MS };
  return cookieHeader;
}

async function getCookieHeader({ force = false } = {}) {
  if (!force && sessionCache?.cookieHeader && sessionCache.expAt > Date.now()) {
    return sessionCache.cookieHeader;
  }
  return loginAgency();
}

export async function fetchBonusesByGirlRange(
  startDayKey,
  endDayKey = startDayKey,
  { force = false, profileId = 0 } = {},
) {
  const startDay = String(startDayKey || "").slice(0, 10);
  const endDay = String(endDayKey || "").slice(0, 10);
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(startDay) ||
    !/^\d{4}-\d{2}-\d{2}$/.test(endDay)
  ) {
    throw new Error("Invalid date range");
  }

  const cacheKey = `${startDay}|${endDay}|${Number(profileId) || 0}`;
  const cached = dayCache.get(cacheKey);
  if (!force && cached && Date.now() - cached.at < DAY_CACHE_TTL_MS) {
    return cached.rows;
  }

  const url = bonusesUrl(startDay, 2, 1, endDay, profileId); // Group By Girl

  const jar = cookieMapFromHeader(await getCookieHeader());
  let result = await fetchWithCookies(url.toString(), {
    method: "GET",
    jar,
    headers: {
      Accept: "text/html,application/xhtml+xml",
      Referer: BONUSES_URL,
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    },
  });

  if (/id="_username"/i.test(result.html) && /name="_password"/i.test(result.html)) {
    const fresh = cookieMapFromHeader(await getCookieHeader({ force: true }));
    result = await fetchWithCookies(url.toString(), {
      method: "GET",
      jar: fresh,
      headers: {
        Accept: "text/html,application/xhtml+xml",
        Referer: BONUSES_URL,
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      },
    });
  }

  if (!result.response.ok) {
    throw new Error(`Agency bonuses HTTP ${result.response.status}`);
  }

  const cookieHeader = cookieHeaderFromJar(result.jar);
  if (sessionCache) {
    sessionCache.cookieHeader = cookieHeader;
    sessionCache.expAt = Date.now() + SESSION_TTL_MS;
  }

  const rows = parseBonusesGroupedByGirl(result.html);
  dayCache.set(cacheKey, { at: Date.now(), rows });
  return rows;
}

export async function fetchBonusesByGirl(dayKey, options = {}) {
  return fetchBonusesByGirlRange(dayKey, dayKey, options);
}

async function fetchBonusPage(day, page, pid, headers, cookieJar) {
  let lastError = null;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const result = await fetchWithCookies(bonusesUrl(day, 1, page, day, pid).toString(), {
        method: "GET",
        jar: cookieMapFromHeader(cookieHeaderFromJar(cookieJar)),
        headers,
      });
      if (/id="_username"/i.test(result.html) && /name="_password"/i.test(result.html)) {
        const cookieHeader = await getCookieHeader({ force: true });
        cookieJar = cookieMapFromHeader(cookieHeader);
        continue;
      }
      if (!result.response.ok) {
        lastError = new Error(`Agency bonuses HTTP ${result.response.status}`);
        continue;
      }
      return result;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error(`Failed to load bonuses page ${page}`);
}

function totalsMatch(actionsSum, targetTotal) {
  return targetTotal != null && Math.abs(actionsSum - targetTotal) < 0.02;
}

async function fetchBonusActionsOneDay(dayKey, { force = false, profileId = 0, allowSplit = true } = {}) {
  const day = String(dayKey || "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) {
    throw new Error("Invalid day key");
  }

  const pid = Number(profileId) || 0;
  const cacheKey = `${day}|${day}|${pid}`;
  const cached = detailCache.get(cacheKey);
  if (!force && cached && Date.now() - cached.at < DETAIL_CACHE_TTL_MS) {
    return {
      actions: cached.actions,
      officialTotalUsd:
        cached.officialTotalUsd == null ? null : Number(cached.officialTotalUsd),
    };
  }

  let cookieHeader = await getCookieHeader();
  let cookieJar = cookieMapFromHeader(cookieHeader);
  const headers = {
    Accept: "text/html,application/xhtml+xml",
    Referer: BONUSES_URL,
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  };

  const byKey = new Map();
  const loadedPages = new Set();
  const addActions = (rows, page = 0) => {
    if (page > 0) {
      if (loadedPages.has(page)) return 0;
      loadedPages.add(page);
    }
    let added = 0;
    // Dream already filters this response by its business day (10:00–10:00 Kyiv).
    // Keep identical twin rows from the same page (same second / amount) — they are
    // real paid actions. Cross-page duplicates are avoided by loading each page once.
    const list = filterRequestedActions(rows, pid);
    for (let index = 0; index < list.length; index += 1) {
      const action = list[index];
      const key =
        page > 0
          ? `${actionDedupeKey(action)}|p${page}|${index}`
          : `${actionDedupeKey(action)}|x${byKey.size}`;
      if (byKey.has(key)) continue;
      byKey.set(key, action);
      added += 1;
    }
    return added;
  };

  const first = await fetchBonusPage(day, 1, pid, headers, cookieJar);
  cookieJar = first.jar;
  let targetTotal = parseBonusGrandTotal(first.html);
  let detectedPages = maxPaginationPage(first.html);
  addActions(parseBonusActions(first.html), 1);

  const loadPage = async (page) => {
    const result = await fetchBonusPage(day, page, pid, headers, cookieJar);
    cookieJar = result.jar;
    if (targetTotal == null) targetTotal = parseBonusGrandTotal(result.html);
    detectedPages = Math.max(detectedPages, maxPaginationPage(result.html));
    addActions(parseBonusActions(result.html), page);
    return result;
  };

  // Parallel batches first, then fill gaps sequentially if the total still mismatches.
  for (let start = 2; start <= detectedPages; start += 3) {
    if (totalsMatch(sumActionsUsd([...byKey.values()]), targetTotal)) break;
    const pageNumbers = Array.from(
      { length: Math.min(3, detectedPages - start + 1) },
      (_, index) => start + index,
    );
    const results = await Promise.allSettled(pageNumbers.map((page) => loadPage(page)));
    for (let index = 0; index < results.length; index += 1) {
      if (results[index].status === "rejected") {
        await loadPage(pageNumbers[index]);
      }
    }
  }

  let emptyStreak = 0;
  const pageLimit = Math.min(MAX_BONUS_PAGES, Math.max(detectedPages + 10, detectedPages, 2));
  for (
    let page = 2;
    page <= pageLimit &&
    !totalsMatch(sumActionsUsd([...byKey.values()]), targetTotal);
    page += 1
  ) {
    try {
      const before = byKey.size;
      await loadPage(page);
      if (byKey.size === before) {
        emptyStreak += 1;
        if (emptyStreak >= 3 && page > detectedPages) break;
      } else {
        emptyStreak = 0;
      }
    } catch (_) {
      emptyStreak += 1;
      if (emptyStreak >= 3) break;
    }
  }

  // Fallback target from Group-by-Girl if footer total was missing.
  if (targetTotal == null) {
    try {
      const rows = await fetchBonusesByGirl(day, { force, profileId: pid });
      targetTotal = Number(
        rows
          .filter((row) => !pid || String(row.profileId) === String(pid))
          .reduce((sum, row) => sum + (Number(row.amount) || 0), 0)
          .toFixed(2),
      );
    } catch (_) {}
  }

  // Heavy days: split by questionnaire so Dream returns smaller page sets.
  if (
    allowSplit &&
    !pid &&
    targetTotal != null &&
    !totalsMatch(sumActionsUsd([...byKey.values()]), targetTotal)
  ) {
    try {
      const girls = await fetchBonusesByGirl(day, { force: true, profileId: 0 });
      for (let index = 0; index < girls.length; index += 2) {
        if (totalsMatch(sumActionsUsd([...byKey.values()]), targetTotal)) break;
        const batch = girls.slice(index, index + 2);
        const parts = await Promise.all(
          batch.map(async (girl) => {
            const girlId = Number(girl.profileId) || 0;
            if (!girlId) return [];
            const detail = await fetchBonusActionsOneDay(day, {
              force: true,
              profileId: girlId,
              allowSplit: false,
            });
            return detail.actions || [];
          }),
        );
        for (const rows of parts) addActions(rows, 0);
      }
      const girlSum = Number(
        girls.reduce((sum, row) => sum + (Number(row.amount) || 0), 0).toFixed(2),
      );
      const actionsSum = sumActionsUsd([...byKey.values()]);
      // Prefer Group-by-Girl when it matches the parsed rows — Dream's Grand Total
      // footer is occasionally a few cents off the visible action list.
      if (totalsMatch(actionsSum, girlSum)) {
        targetTotal = girlSum;
      }
    } catch (_) {}
  }

  const actions = [...byKey.values()];
  const officialTotalUsd =
    targetTotal == null ? null : Number(Number(targetTotal).toFixed(2));
  detailCache.set(cacheKey, { at: Date.now(), actions, officialTotalUsd });
  return { actions, officialTotalUsd };
}

export async function fetchBonusActionsRange(
  startDayKey,
  endDayKey = startDayKey,
  { force = false, profileId = 0 } = {},
) {
  const startDay = String(startDayKey || "").slice(0, 10);
  const endDay = String(endDayKey || "").slice(0, 10);
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(startDay) ||
    !/^\d{4}-\d{2}-\d{2}$/.test(endDay)
  ) {
    throw new Error("Invalid date range");
  }
  if (startDay > endDay) {
    throw new Error("Invalid date range");
  }

  const pid = Number(profileId) || 0;
  if (startDay === endDay) {
    const detail = await fetchBonusActionsOneDay(startDay, { force, profileId: pid });
    return detail.actions;
  }

  const cacheKey = `${startDay}|${endDay}|${pid}`;
  const cached = detailCache.get(cacheKey);
  if (!force && cached && Date.now() - cached.at < DETAIL_CACHE_TTL_MS) {
    return cached.actions;
  }

  // Day-by-day: each day loads until Dream Grand Total matches row sum.
  const days = eachDreamDayKey(startDay, endDay);
  if (force) {
    detailCache.delete(cacheKey);
    for (const day of days) detailCache.delete(`${day}|${day}|${pid}`);
  }

  const merged = [];
  const errors = [];
  for (let i = 0; i < days.length; i += 2) {
    const batch = days.slice(i, i + 2);
    const results = await Promise.all(
      batch.map(async (day) => {
        try {
          const detail = await fetchBonusActionsOneDay(day, { force, profileId: pid });
          return detail.actions;
        } catch (error) {
          errors.push(`${day}: ${error?.message || error}`);
          return [];
        }
      }),
    );
    for (const rows of results) merged.push(...rows);
  }

  if (!merged.length && errors.length) {
    throw new Error(`Failed to load bonus actions (${errors[0]})`);
  }

  const seen = new Set();
  const actions = merged.filter((action) => {
    const key = actionDedupeKey(action);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  detailCache.set(cacheKey, { at: Date.now(), actions, officialTotalUsd: null });
  return actions;
}

/** Full day detail including Dream Grand Total used for completeness checks. */
export async function fetchBonusActionsDayDetail(dayKey, options = {}) {
  return fetchBonusActionsOneDay(dayKey, options);
}

export async function fetchBonusActions(dayKey, options = {}) {
  const detail = await fetchBonusActionsOneDay(dayKey, options);
  return detail.actions;
}

export function clearAgencyFinanceCaches() {
  sessionCache = null;
  dayCache.clear();
  detailCache.clear();
}
