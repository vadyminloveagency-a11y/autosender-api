import { dreamLogin } from "./dreamLogin.js";

const ORIGIN = "https://www.dream-singles.com";
const INBOX_URL = `${ORIGIN}/members/messaging/inbox`;
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

function parseSetCookieHeader(response) {
  try {
    if (typeof response.headers.getSetCookie === "function") {
      return response.headers.getSetCookie() || [];
    }
  } catch (_) {}
  const single = response.headers.get("set-cookie");
  return single ? [single] : [];
}

function mergeCookieJar(header, setCookieList) {
  const map = new Map();
  for (const part of String(header || "").split(";")) {
    const idx = part.indexOf("=");
    if (idx <= 0) continue;
    map.set(part.slice(0, idx).trim(), part.slice(idx + 1).trim());
  }
  for (const raw of setCookieList || []) {
    const first = String(raw || "").split(";")[0] || "";
    const idx = first.indexOf("=");
    if (idx <= 0) continue;
    const name = first.slice(0, idx).trim();
    const value = first.slice(idx + 1).trim();
    if (!name) continue;
    if (value === "" || /deleted/i.test(value)) map.delete(name);
    else map.set(name, value);
  }
  return [...map.entries()].map(([n, v]) => `${n}=${v}`).join("; ");
}

function looksLikeLogin(html, finalUrl) {
  const url = String(finalUrl || "").toLowerCase();
  if (/\/login(?:[/?#]|$)/i.test(url)) return true;
  const lower = String(html || "").toLowerCase();
  return (
    lower.includes('id="loginform2"') ||
    (lower.includes('name="_password"') && lower.includes('name="_username"'))
  );
}

function buildCdnPhoto(id) {
  return `https://profile-photos-cdn.dream-singles.com/im${id}_small.jpg`;
}

function normalizeIsoDate(raw) {
  const value = String(raw || "").trim();
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function normalizeInboxJsonList(data) {
  if (!data) return [];
  if (Array.isArray(data)) return data;
  const keys = [
    "messages",
    "inboxMessages",
    "inbox_messages",
    "items",
    "list",
    "data",
    "rows",
    "result",
  ];
  for (const key of keys) {
    const value = data[key];
    if (Array.isArray(value) && value.length) return value;
  }
  const queue = [data];
  const seen = new Set();
  while (queue.length) {
    const node = queue.shift();
    if (!node || typeof node !== "object" || seen.has(node)) continue;
    seen.add(node);
    if (Array.isArray(node) && node.length && typeof node[0] === "object") {
      const sample = node[0];
      if (
        sample.profile_from ||
        sample.profile_from_id ||
        sample.male_profile_id ||
        sample.sender_id ||
        sample.man_id ||
        sample.profile_id
      ) {
        return node;
      }
    }
    Object.values(node).forEach((value) => {
      if (value && typeof value === "object") queue.push(value);
    });
  }
  return [];
}

function extractFemaleIdFromJson(data) {
  if (!data || Array.isArray(data)) return null;
  const id = Number(
    data.female_profile_id ||
      data.femaleProfileId ||
      data.profile_id ||
      data.account_id ||
      data.member_id,
  );
  return id || null;
}

function extractMaxPageFromJson(data, page) {
  if (!data || Array.isArray(data)) return page;
  const maxPage = Number(
    data.maxPage || data.max_page || data.totalPages || data.total_pages || data.pages || page,
  );
  return Number.isFinite(maxPage) && maxPage > 0 ? maxPage : page;
}

function mapInboxJsonItem(item, femaleProfileId) {
  if (!item || typeof item !== "object") return null;
  const maleProfileId = Number(
    item.male_profile_id ||
      item.maleProfileId ||
      item.profile_from ||
      item.profile_from_id ||
      item.man_id ||
      item.manId ||
      item.sender_id ||
      item.senderId ||
      item.interlocutor_id ||
      item.interlocutorId ||
      item.partner_id ||
      item.partnerId ||
      item.correspondent_id ||
      item.profile?.id ||
      item.man?.id ||
      item.user?.id ||
      item.regularId ||
      item.profile_id ||
      item.profileId ||
      item.id,
  );
  if (!maleProfileId || (femaleProfileId && maleProfileId === femaleProfileId)) return null;

  const displayName = String(
    item.display_name ||
      item.displayName ||
      item.name ||
      item.first_name ||
      item.firstName ||
      item.username ||
      item.nickname ||
      "",
  ).trim();

  let photoUrl = String(
    item.photo_url || item.photoUrl || item.photo || item.avatar || item.image || item.thumb || "",
  ).trim();
  if (photoUrl.startsWith("//")) photoUrl = `https:${photoUrl}`;
  if (photoUrl.startsWith("/")) photoUrl = `${ORIGIN}${photoUrl}`;
  if (!photoUrl) photoUrl = buildCdnPhoto(maleProfileId);

  const letterCount = Number(
    item.letter_count || item.letterCount || item.message_count || item.messages_count || item.count || 0,
  );

  return {
    maleProfileId,
    displayName,
    photoUrl,
    letterCount: letterCount || 1,
    firstContactAt: normalizeIsoDate(
      item.first_contact_at || item.firstContactAt || item.first_message_at || item.created_at,
    ),
    lastContactAt: normalizeIsoDate(
      item.last_contact_at ||
        item.lastContactAt ||
        item.last_message_at ||
        item.last_letter_at ||
        item.updated_at ||
        item.date,
    ),
  };
}

function extractFemaleIdFromHtml(html) {
  const text = String(html || "");
  const patterns = [
    /data-female(?:-profile)?-id=["']?(\d+)/i,
    /female(?:Profile)?Id["']?\s*[:=]\s*["']?(\d+)/i,
    /"profileId"\s*:\s*(\d+)/i,
    /\/members\/profile\/(\d+)/i,
    /im(\d+)_small\.jpg/i,
  ];
  for (const re of patterns) {
    const m = text.match(re);
    const id = Number(m?.[1] || 0);
    if (id > 1000) return id;
  }
  return null;
}

/** Resolve female questionnaire id from an authenticated Dream session. */
export async function resolveDreamFemaleProfileId(cookieHeader) {
  const header = String(cookieHeader || "").trim();
  if (!header) return null;

  const urls = [
    `${ORIGIN}/members/messaging/inbox`,
    `${ORIGIN}/members/`,
    `${ORIGIN}/members/profile`,
  ];
  for (const url of urls) {
    try {
      const page = await dreamFetch({ value: header }, url, { acceptJson: false, timeoutMs: 20000 });
      const html = page.text || "";
      const id = extractFemaleIdFromHtml(html);
      if (id) return id;
    } catch (_) {}
  }
  return null;
}

function extractEmbeddedInboxJson(html) {
  const text = String(html || "");
  const match =
    text.match(/inboxMessages\s*=\s*(\[[\s\S]*?\])\s*;/) ||
    text.match(/"inboxMessages"\s*:\s*(\[[\s\S]*?\])/);
  if (!match?.[1]) return null;
  try {
    return JSON.parse(match[1]);
  } catch {
    return null;
  }
}

async function dreamFetch(cookieHeaderRef, pathOrUrl, { acceptJson = false, timeoutMs = 20000 } = {}) {
  const url = String(pathOrUrl).startsWith("http") ? pathOrUrl : `${ORIGIN}${pathOrUrl}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(3000, Number(timeoutMs) || 20000));
  let response;
  try {
    response = await fetch(url, {
      method: "GET",
      redirect: "follow",
      signal: controller.signal,
      headers: {
        Accept: acceptJson
          ? "application/json, text/javascript, */*;q=0.1"
          : "text/html,application/xhtml+xml,application/json,*/*",
        Cookie: cookieHeaderRef.value,
        "X-Requested-With": "XMLHttpRequest",
        Referer: INBOX_URL,
        "User-Agent": UA,
      },
    });
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new Error("Dream Inbox request timed out");
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
  cookieHeaderRef.value = mergeCookieJar(cookieHeaderRef.value, parseSetCookieHeader(response));
  const text = await response.text();
  return { response, text, url: response.url || url };
}

async function fetchInboxJsonPage(cookieHeaderRef, page) {
  const pageNum = Math.max(1, Number(page) || 1);
  const paths = [
    `${INBOX_URL}?mode=inbox&folder=-1&page=${pageNum}&view=all&fq=&fd=&td=&returnJson=1`,
    `${INBOX_URL}?mode=inbox&folder=-1&page=${pageNum}&view=all&returnJson=1`,
    `${INBOX_URL}?mode=inbox&view=all&page=${pageNum}&returnJson=1`,
    `/members/messaging/inboxMessages?page=${pageNum}&returnJson=1`,
    `/members/messaging/getInboxMessages?page=${pageNum}&returnJson=1`,
  ];

  for (const path of paths) {
    const { response, text, url } = await dreamFetch(cookieHeaderRef, path, { acceptJson: true });
    if (!response.ok) continue;
    if (looksLikeLogin(text, url)) {
      throw new Error("Dream login required — update password in LetterBot Cloud login");
    }
    let payload = null;
    try {
      payload = JSON.parse(text);
    } catch {
      const embedded = extractEmbeddedInboxJson(text);
      if (embedded) payload = embedded;
    }
    if (!payload) continue;
    const list = normalizeInboxJsonList(payload);
    if (!list.length) continue;
    return {
      ok: true,
      items: list,
      maxPage: extractMaxPageFromJson(payload, pageNum),
      femaleProfileId: extractFemaleIdFromJson(payload),
    };
  }
  return { ok: false };
}

async function fetchInboxHtmlFallback(cookieHeaderRef, page, femaleProfileId) {
  const pageNum = Math.max(1, Number(page) || 1);
  const path =
    pageNum <= 1
      ? `${INBOX_URL}?mode=inbox&folder=-1&page=1&view=all`
      : `${INBOX_URL}?mode=inbox&folder=-1&page=${pageNum}&view=all`;
  const { response, text, url } = await dreamFetch(cookieHeaderRef, path);
  if (!response.ok) return { ok: false };
  if (looksLikeLogin(text, url)) {
    throw new Error("Dream login required — update password in LetterBot Cloud login");
  }
  const embedded = extractEmbeddedInboxJson(text);
  const list = normalizeInboxJsonList(embedded);
  if (list.length) {
    return {
      ok: true,
      items: list,
      maxPage: pageNum,
      femaleProfileId: femaleProfileId || extractFemaleIdFromHtml(text),
    };
  }
  return {
    ok: false,
    femaleProfileId: femaleProfileId || extractFemaleIdFromHtml(text),
  };
}

/**
 * Scrape Dream Inbox via HTTP using cookie header and/or stored credentials.
 * @param {{ cookieHeader?: string, username?: string, password?: string, maxPages?: number, onProgress?: Function }} options
 */
export async function scrapeDreamInboxCloud(options = {}) {
  const maxPagesOpt = options.maxPages == null ? 3 : Number(options.maxPages);
  const unlimited = maxPagesOpt === 0;
  const pageLimit = unlimited ? 9999 : Math.max(1, maxPagesOpt);
  const onProgress = typeof options.onProgress === "function" ? options.onProgress : () => {};

  let cookieHeader = String(options.cookieHeader || "").trim();
  if (!cookieHeader && options.username && options.password) {
    onProgress({ message: "Cloud Inbox: logging in to Dream…" });
    const login = await dreamLogin(options.username, options.password);
    cookieHeader = login.cookieHeader;
  }
  if (!cookieHeader) {
    throw new Error("No Dream session — save login in LetterBot Cloud login");
  }

  const cookieRef = { value: cookieHeader };
  const merged = new Map();
  const order = [];
  const letterCounts = {};
  let femaleProfileId = null;
  let pagesScraped = 0;
  let maxKnownPage = 1;

  onProgress({ message: "Cloud Inbox: page 1…", page: 1 });

  let page1 = await fetchInboxJsonPage(cookieRef, 1);
  if (!page1.ok) {
    page1 = await fetchInboxHtmlFallback(cookieRef, 1, null);
  }
  if (!page1.ok || !(page1.items || []).length) {
    throw new Error("Cloud Inbox empty — check Dream login in LetterBot");
  }

  femaleProfileId = page1.femaleProfileId || null;
  maxKnownPage = Math.max(1, Number(page1.maxPage) || 1);

  const absorb = (rawList, pageNum) => {
    let added = 0;
    for (const raw of rawList || []) {
      const item = mapInboxJsonItem(raw, femaleProfileId);
      if (!item) continue;
      added += 1;
      const id = item.maleProfileId;
      letterCounts[id] = (letterCounts[id] || 0) + Math.max(1, Number(item.letterCount) || 1);
      if (!merged.has(id)) {
        merged.set(id, item);
        order.push(id);
      } else {
        const existing = merged.get(id);
        if (item.displayName && !existing.displayName) existing.displayName = item.displayName;
        if (item.photoUrl && !existing.photoUrl) existing.photoUrl = item.photoUrl;
        if (item.lastContactAt && (!existing.lastContactAt || item.lastContactAt > existing.lastContactAt)) {
          existing.lastContactAt = item.lastContactAt;
        }
        if (item.firstContactAt && (!existing.firstContactAt || item.firstContactAt < existing.firstContactAt)) {
          existing.firstContactAt = item.firstContactAt;
        }
      }
    }
    pagesScraped = pageNum;
    return added;
  };

  absorb(page1.items, 1);
  onProgress({
    message: `Cloud Inbox: page 1 — ${order.length} men`,
    page: 1,
    men: order.length,
  });

  const endPage = unlimited ? maxKnownPage : Math.min(pageLimit, maxKnownPage);
  for (let page = 2; page <= endPage; page += 1) {
    onProgress({
      message: `Cloud Inbox: page ${page}/${endPage}…`,
      page,
      men: order.length,
    });
    let pageData = await fetchInboxJsonPage(cookieRef, page);
    if (!pageData.ok) {
      pageData = await fetchInboxHtmlFallback(cookieRef, page, femaleProfileId);
    }
    if (!pageData.ok || !(pageData.items || []).length) break;
    if (pageData.femaleProfileId && !femaleProfileId) femaleProfileId = pageData.femaleProfileId;
    const added = absorb(pageData.items, page);
    if (Number(pageData.maxPage) > maxKnownPage) {
      maxKnownPage = Number(pageData.maxPage);
    }
    if (!added) break;
    // Gentle pacing so Dream is less likely to rate-limit while LetterBot is paused.
    await new Promise((r) => setTimeout(r, 120));
  }

  if (!order.length) {
    throw new Error("Cloud Inbox empty — check Dream login in LetterBot");
  }

  const items = order.map((id, index) => {
    const row = merged.get(id);
    return {
      maleProfileId: id,
      displayName: row.displayName || "",
      photoUrl: row.photoUrl || buildCdnPhoto(id),
      letterCount: letterCounts[id] || 1,
      firstContactAt: row.firstContactAt || null,
      lastContactAt: row.lastContactAt || null,
      inboxOrder: index + 1,
      isSiteFavorite: false,
      isSiteIgnored: false,
    };
  });

  return {
    ok: true,
    source: "cloud",
    femaleProfileId,
    pagesScraped,
    letterCounts,
    items,
    cookieHeader: cookieRef.value,
  };
}
