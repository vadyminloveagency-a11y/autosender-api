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
  dayCache.set(day, { at: Date.now(), rows });
  return rows;
}

export function clearAgencyFinanceCaches() {
  sessionCache = null;
  dayCache.clear();
}
