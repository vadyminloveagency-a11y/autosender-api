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
const SESSION_TTL_MS = 45 * 60_000;
const DAY_CACHE_TTL_MS = 3 * 60_000;

function parseSetCookieHeaders(response) {
  const raw =
    typeof response.headers.getSetCookie === "function"
      ? response.headers.getSetCookie()
      : [];
  const list = Array.isArray(raw) && raw.length ? raw : [];
  if (!list.length) {
    const single = response.headers.get("set-cookie");
    if (single) list.push(single);
  }
  const jar = new Map();
  for (const line of list) {
    const part = String(line || "").split(";")[0];
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    jar.set(part.slice(0, eq).trim(), part.slice(eq + 1).trim());
  }
  return jar;
}

function mergeCookieHeader(existing, response) {
  const jar = new Map();
  for (const part of String(existing || "")
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean)) {
    const eq = part.indexOf("=");
    if (eq > 0) jar.set(part.slice(0, eq), part.slice(eq + 1));
  }
  for (const [k, v] of parseSetCookieHeaders(response)) jar.set(k, v);
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

async function loginAgency() {
  const creds = await getAgencyFinanceCredentials();
  if (!creds.configured) {
    throw new Error(
      "Agency finance login not configured — set credentials in Mailings or DREAM_AGENCY_USERNAME/PASSWORD",
    );
  }

  const loginPage = await fetch(LOGIN_URL, {
    method: "GET",
    redirect: "follow",
    signal: AbortSignal.timeout(20000),
    headers: {
      Accept: "text/html",
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    },
  });
  let cookieHeader = mergeCookieHeader("", loginPage);
  const csrf = extractCsrf(await loginPage.text());
  if (!csrf) throw new Error("Agency login CSRF not found");

  const body = new URLSearchParams({
    _username: creds.username,
    _password: creds.password,
    _csrf_token: csrf,
    _remember_me: "on",
  });

  const response = await fetch(LOGIN_CHECK_URL, {
    method: "POST",
    redirect: "follow",
    signal: AbortSignal.timeout(20000),
    headers: {
      Accept: "text/html",
      "Content-Type": "application/x-www-form-urlencoded",
      Cookie: cookieHeader,
      Origin: ORIGIN,
      Referer: LOGIN_URL,
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    },
    body,
  });
  cookieHeader = mergeCookieHeader(cookieHeader, response);
  const html = await response.text();
  if (/\/login_check|id="_username"|Invalid credentials/i.test(html) && /name="_password"/i.test(html)) {
    throw new Error("Agency login failed — check username/password");
  }
  if (!/DSAGPHPSESSION|REMEMBERME_AGENCY/i.test(cookieHeader) && !/logout/i.test(html)) {
    throw new Error("Agency login failed — no session cookie");
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

export async function fetchBonusesByGirl(dayKey, { force = false } = {}) {
  const day = String(dayKey || "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) {
    throw new Error("Invalid day key");
  }

  const cached = dayCache.get(day);
  if (!force && cached && Date.now() - cached.at < DAY_CACHE_TTL_MS) {
    return cached.rows;
  }

  const url = new URL(BONUSES_URL);
  url.searchParams.set("form[startDate]", day);
  url.searchParams.set("form[endDate]", day);
  url.searchParams.set("form[type]", "0");
  url.searchParams.set("form[profileId]", "0");
  url.searchParams.set("form[groupBy]", "2"); // Group By Girl
  url.searchParams.set("form[extra]", "");

  let cookieHeader = await getCookieHeader();
  let response = await fetch(url, {
    method: "GET",
    redirect: "follow",
    signal: AbortSignal.timeout(30000),
    headers: {
      Accept: "text/html",
      Cookie: cookieHeader,
      Referer: BONUSES_URL,
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    },
  });
  cookieHeader = mergeCookieHeader(cookieHeader, response);
  if (sessionCache) sessionCache.cookieHeader = cookieHeader;

  let html = await response.text();
  if (response.status === 401 || response.status === 403 || /id="_username"/i.test(html)) {
    cookieHeader = await getCookieHeader({ force: true });
    response = await fetch(url, {
      method: "GET",
      redirect: "follow",
      signal: AbortSignal.timeout(30000),
      headers: {
        Accept: "text/html",
        Cookie: cookieHeader,
        Referer: BONUSES_URL,
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      },
    });
    html = await response.text();
  }
  if (!response.ok) throw new Error(`Agency bonuses HTTP ${response.status}`);

  const rows = parseBonusesGroupedByGirl(html);
  dayCache.set(day, { at: Date.now(), rows });
  return rows;
}

export function clearAgencyFinanceCaches() {
  sessionCache = null;
  dayCache.clear();
}
