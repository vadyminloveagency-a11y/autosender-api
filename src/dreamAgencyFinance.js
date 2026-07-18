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
    if (cells.length !== 5) continue;
    if (/^Type of Bonus$/i.test(cells[0]) || /Total$/i.test(cells[0])) continue;

    const manMatch = cells[1].match(/^(\d{5,})\s*(.*)$/);
    const womanMatch = cells[2].match(/^\[(\d{5,})\]\s*(.*)$/);
    const amount = parseMoney(cells[4]);
    if (!womanMatch || !Number.isFinite(amount)) continue;

    actions.push({
      type: cells[0],
      maleProfileId: manMatch?.[1] || "",
      maleName: String(manMatch?.[2] || "").trim(),
      femaleProfileId: womanMatch[1],
      femaleName: String(womanMatch[2] || "").trim(),
      occurredAt: cells[3],
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

/** Calendar day YYYY-MM-DD from Dream action timestamp MM/DD/YYYY HH:MM:SS. */
function actionCalendarDayKey(occurredAt) {
  const match = String(occurredAt || "").match(
    /^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s|$)/,
  );
  if (!match) return "";
  return `${match[3]}-${String(match[1]).padStart(2, "0")}-${String(match[2]).padStart(2, "0")}`;
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

function maxPaginationPage(html) {
  let max = 1;
  for (const match of String(html || "").matchAll(/[?&]page=(\d+)/gi)) {
    max = Math.max(max, Number(match[1]) || 1);
  }
  return Math.min(max, 200);
}

/** Official Dream table total from detail view footer. */
export function parseBonusGrandTotal(html) {
  const text = stripTags(html);
  const grand = text.match(/Grand\s*Total[^$]*\$\s*([0-9.,]+)/i);
  if (grand) return parseMoney(grand[1]);
  const pageTotal = text.match(/Page\s*Total[^$]*\$\s*([0-9.,]+)/i);
  if (pageTotal) return parseMoney(pageTotal[1]);
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

function filterDayActions(actions, day, profileId = 0) {
  const pid = Number(profileId) || 0;
  return (Array.isArray(actions) ? actions : []).filter((action) => {
    if (pid && String(action.femaleProfileId) !== String(pid)) return false;
    if (actionCalendarDayKey(action.occurredAt) !== day) return false;
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

async function fetchBonusActionsOneDay(dayKey, { force = false, profileId = 0 } = {}) {
  const day = String(dayKey || "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) {
    throw new Error("Invalid day key");
  }

  const pid = Number(profileId) || 0;
  const cacheKey = `${day}|${day}|${pid}`;
  const cached = detailCache.get(cacheKey);
  if (!force && cached && Date.now() - cached.at < DETAIL_CACHE_TTL_MS) {
    return cached.actions;
  }

  let cookieHeader = await getCookieHeader();
  let jar = cookieMapFromHeader(cookieHeader);
  const headers = {
    Accept: "text/html,application/xhtml+xml",
    Referer: BONUSES_URL,
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  };

  let first = await fetchWithCookies(bonusesUrl(day, 1, 1, day, pid).toString(), {
    method: "GET",
    jar,
    headers,
  });
  if (/id="_username"/i.test(first.html) && /name="_password"/i.test(first.html)) {
    cookieHeader = await getCookieHeader({ force: true });
    jar = cookieMapFromHeader(cookieHeader);
    first = await fetchWithCookies(bonusesUrl(day, 1, 1, day, pid).toString(), {
      method: "GET",
      jar,
      headers,
    });
  }
  if (!first.response.ok) {
    throw new Error(`Agency bonuses HTTP ${first.response.status}`);
  }

  const byKey = new Map();
  const addActions = (rows) => {
    let added = 0;
    for (const action of filterDayActions(rows, day, pid)) {
      const key = actionDedupeKey(action);
      if (byKey.has(key)) continue;
      byKey.set(key, action);
      added += 1;
    }
    return added;
  };

  let targetTotal = parseBonusGrandTotal(first.html);
  let detectedPages = maxPaginationPage(first.html);
  let cookieJar = first.jar;
  addActions(parseBonusActions(first.html));

  // Load every page Dream advertises, refreshing the last-page estimate as we go.
  for (let start = 2; start <= detectedPages; start += 4) {
    const pageNumbers = Array.from(
      { length: Math.min(4, detectedPages - start + 1) },
      (_, index) => start + index,
    );
    const results = await Promise.all(
      pageNumbers.map((page) =>
        fetchWithCookies(bonusesUrl(day, 1, page, day, pid).toString(), {
          method: "GET",
          jar: cookieMapFromHeader(cookieHeaderFromJar(cookieJar)),
          headers,
        }),
      ),
    );
    for (const result of results) {
      if (!result.response.ok) continue;
      cookieJar = result.jar;
      if (targetTotal == null) targetTotal = parseBonusGrandTotal(result.html);
      detectedPages = Math.max(detectedPages, maxPaginationPage(result.html));
      addActions(parseBonusActions(result.html));
    }
    if (targetTotal != null && Math.abs(sumActionsUsd([...byKey.values()]) - targetTotal) < 0.02) {
      break;
    }
  }

  // Keep walking past hidden pagination until totals match or pages run out.
  let emptyStreak = 0;
  for (
    let page = detectedPages + 1;
    page <= 200 &&
    (targetTotal == null ||
      Math.abs(sumActionsUsd([...byKey.values()]) - targetTotal) >= 0.02);
    page += 1
  ) {
    const result = await fetchWithCookies(bonusesUrl(day, 1, page, day, pid).toString(), {
      method: "GET",
      jar: cookieMapFromHeader(cookieHeaderFromJar(cookieJar)),
      headers,
    });
    if (!result.response.ok) break;
    cookieJar = result.jar;
    if (targetTotal == null) targetTotal = parseBonusGrandTotal(result.html);
    const added = addActions(parseBonusActions(result.html));
    if (!added) {
      emptyStreak += 1;
      if (emptyStreak >= 2) break;
      continue;
    }
    emptyStreak = 0;
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

  const actions = [...byKey.values()];
  detailCache.set(cacheKey, { at: Date.now(), actions });
  return actions;
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
    return fetchBonusActionsOneDay(startDay, { force, profileId: pid });
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
          return await fetchBonusActionsOneDay(day, { force, profileId: pid });
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
  detailCache.set(cacheKey, { at: Date.now(), actions });
  return actions;
}

export async function fetchBonusActions(dayKey, options = {}) {
  return fetchBonusActionsOneDay(dayKey, options);
}

export function clearAgencyFinanceCaches() {
  sessionCache = null;
  dayCache.clear();
  detailCache.clear();
}
