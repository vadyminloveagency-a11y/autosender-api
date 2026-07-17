import { dreamLogin } from "./dreamLogin.js";
import { dreamHttp, hasDreamProxy } from "./dreamHttp.js";
import { hasTwoCaptcha } from "./twoCaptcha.js";
import WebSocket from "ws";

const ORIGIN = "https://www.dream-singles.com";
const READS_URL = `${ORIGIN}/members/messaging/inbox`;
const FAVORITES_URL = `${ORIGIN}/members/connections/myFavorites`;
const DREAM_WS_URL = "wss://ws.dream-singles.com/ws";
const DUPES_MAX = 8000;

const PRESETS = {
  allReaders: {
    excludeFavorites: true,
    checkDuplicates: true,
    onlineOnly: false,
    enableCycling: false,
    todayOnly: false,
  },
  allReadersOnline: {
    excludeFavorites: true,
    checkDuplicates: true,
    onlineOnly: true,
    enableCycling: true,
    todayOnly: false,
  },
  onlyOnline: {
    excludeFavorites: true,
    checkDuplicates: true,
    onlineOnly: true,
    enableCycling: true,
    todayOnly: false,
  },
  readersToday: {
    excludeFavorites: true,
    checkDuplicates: true,
    onlineOnly: false,
    enableCycling: true,
    todayOnly: true,
  },
  readersTodayOnline: {
    excludeFavorites: true,
    checkDuplicates: true,
    onlineOnly: true,
    enableCycling: true,
    todayOnly: true,
  },
};

function normalizePreset(value) {
  const v = String(value || "").trim();
  if (v === "onlyOnline" || v === "allReadersOnline") return "allReadersOnline";
  if (v === "readersLast24h" || v === "readersToday") return "readersToday";
  if (v === "readersTodayOnline") return "readersTodayOnline";
  return "allReaders";
}

function resolveFilters(preset, overrides = {}) {
  const key = normalizePreset(preset);
  const base = { ...(PRESETS[key] || PRESETS.allReaders) };
  if (typeof overrides.excludeFavorites === "boolean") {
    base.excludeFavorites = overrides.excludeFavorites;
  }
  if (typeof overrides.checkDuplicates === "boolean") {
    base.checkDuplicates = overrides.checkDuplicates;
  }
  return base;
}

/** Dream calendar day for Readers today — agency TZ (not Render UTC). */
const DREAM_DAY_TZ = "Europe/Kyiv";

/** Dream UI fd=MM/DD/YYYY — calendar day in agency timezone. */
function formatDreamFdDate(nowMs = Date.now()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: DREAM_DAY_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(nowMs));
  const get = (type) => parts.find((p) => p.type === type)?.value || "";
  return `${get("month")}/${get("day")}/${get("year")}`;
}

function dayKeyFromFd(fd) {
  const m = String(fd || "").trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return "";
  const mm = String(Number(m[1])).padStart(2, "0");
  const dd = String(Number(m[2])).padStart(2, "0");
  return `${m[3]}-${mm}-${dd}`;
}

function dayKeyInAgencyTz(ms) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: DREAM_DAY_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(ms));
  const get = (type) => parts.find((p) => p.type === type)?.value || "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

function parseReadMessageDate(message) {
  const raw = String(message?.date || "").trim();
  if (!raw) return null;
  // Prefer the calendar day Dream shows ("2026-07-16 07:46") — do not append UTC
  // (evening-of-16 as UTC becomes the 17th in Kyiv and wrongly passes "today").
  const day = raw.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (day) {
    const ms = Date.parse(`${day[1]}-${day[2]}-${day[3]}T12:00:00Z`);
    return Number.isFinite(ms) ? ms : null;
  }
  const normalized = /(?:z|gmt|[+-]\d{2}:?\d{2})$/i.test(raw) ? raw : `${raw} UTC`;
  const ms = Date.parse(normalized);
  return Number.isFinite(ms) ? ms : null;
}

/** Calendar day as Dream shows on the letter row (YYYY-MM-DD prefix). */
function dreamRowDayKey(message) {
  const raw = String(message?.date || "").trim();
  const m = raw.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : "";
}

function isReadOnFdDay(message, fd) {
  const want = dayKeyFromFd(fd);
  if (!want) return true;
  const rowDay = dreamRowDayKey(message);
  // No date on row → skip (do not treat as today).
  if (!rowDay) return false;
  return rowDay === want;
}

function readPageHasOlderThanFd(messages, fd) {
  const want = dayKeyFromFd(fd);
  if (!want) return false;
  return (messages || []).some((message) => {
    const rowDay = dreamRowDayKey(message);
    return rowDay && rowDay < want;
  });
}

function messageHash(profileId, text) {
  // Must not contain \u0000 — Postgres JSONB rejects null bytes and crashed the API (502).
  return `${profileId}::${String(text || "").trim()}`;
}

/** DreamAuto-speed: remember hash so next pass won't POST again. */
function isComposeRejectWorthDuping(error) {
  const msg = String(error?.message || error || "");
  return /already sent|duplicate message|compose rejected|compose http\s*500|rejected by dream/i.test(
    msg,
  );
}

function generateReplyId() {
  const hex = Array.from({ length: 32 }, () =>
    Math.floor(Math.random() * 16).toString(16),
  ).join("");
  const memberLike = () => String(Math.floor(9e6 * Math.random() + 1e6));
  return `${memberLike()}-${memberLike()}-${hex}`;
}

function parseReadTarget(message) {
  const maleProfileId = Number(message?.sender_pid);
  const link = String(message?.link_read || "").trim();
  const token = link.split("/").pop()?.split("?")[0] || "";
  const parts = token.split("-").filter(Boolean);
  const linkMemberId = String(parts[1] || "").trim();
  if (!maleProfileId) return null;
  return { maleProfileId, linkMemberId };
}

  function isMessageOnlineFlag(message) {
  const v = message?.online ?? message?.is_online ?? message?.isOnline;
  if (v === true || v === 1) return true;
  if (v === false || v === 0 || v == null || v === "") return false;
  const s = String(v).trim().toLowerCase();
  if (s === "1" || s === "true" || s === "yes" || s === "online" || s === "on") return true;
  if (s === "0" || s === "false" || s === "no" || s === "offline" || s === "off") return false;
  return Boolean(s);
}

/** Readers “I'M ONLINE” badge = message.online in returnJson (DreamAuto: !onlineOnly || A.online). */
function isReadOnlineEligible(message, onlineOnly) {
  if (!onlineOnly) return true;
  return isMessageOnlineFlag(message);
}

function normalizeChannel(value) {
  return String(value || "").toLowerCase() === "online" ? "online" : "read";
}

/** DreamAuto men-online-response row → profile id + compose member id */
function parseMenOnlinePayload(payload) {
  const rows = [];
  const seen = new Set();
  let list = payload;
  if (!Array.isArray(list) && list && typeof list === "object") {
    list = list.users || list.data || list.men || list.payload || list.items || [];
  }
  for (const row of Array.isArray(list) ? list : []) {
    const id = Number(row?.id || row?.profile_id || row?.regularId) || 0;
    const memberId = String(row?.member_id || row?.memberId || "").trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    rows.push({ id, memberId });
  }
  return rows;
}

function normalizeInviteJwt(raw) {
  let token = String(raw || "").trim();
  if (!token) return "";
  if (
    (token.startsWith('"') && token.endsWith('"')) ||
    (token.startsWith("'") && token.endsWith("'"))
  ) {
    token = token.slice(1, -1).trim();
  }
  try {
    if (token.startsWith("{")) {
      const obj = JSON.parse(token);
      token = String(obj.token || obj.jwt || obj.jwtKey || obj.payload || "").trim();
    }
  } catch (_) {}
  if (token.length < 20 || token.startsWith("<")) return "";
  return token;
}

export class SenderReadsWorker {
  constructor(profileId, options = {}) {
    this.profileId = String(profileId || "default");
    this.channel = normalizeChannel(options.channel);
    // Separate DB row per channel without schema migration.
    this.storeProfileId =
      this.channel === "online" ? `${this.profileId}__online` : this.profileId;
    this.ownerUserId = options.ownerUserId ?? null;
    this.onStateChange = typeof options.onStateChange === "function" ? options.onStateChange : null;
    this.onPersist = typeof options.onPersist === "function" ? options.onPersist : null;
    this.credentialsProvider =
      typeof options.credentialsProvider === "function" ? options.credentialsProvider : null;

    this.cookieHeader = "";
    this.runToken = 0;
    this.seenMemberIds = new Set();
    this.dupeList = [];
    this._manualBlacklistIds = new Set();

    this.state = this.idleState("Idle");
  }

  setManualBlacklistIds(ids) {
    this._manualBlacklistIds = new Set(
      (Array.isArray(ids) ? ids : [])
        .map(Number)
        .filter((id) => id >= 1000),
    );
    return [...this._manualBlacklistIds];
  }

  setFavoritesExcludeIds(ids) {
    this._favoritesExcludeIds = [
      ...new Set(
        (Array.isArray(ids) ? ids : [])
          .map(Number)
          .filter((id) => id >= 1000),
      ),
    ];
    return this._favoritesExcludeIds;
  }

  mergeFavoritesExcludeIds(ids) {
    const next = new Set(
      (Array.isArray(this._favoritesExcludeIds) ? this._favoritesExcludeIds : [])
        .map(Number)
        .filter((id) => id >= 1000),
    );
    for (const raw of Array.isArray(ids) ? ids : []) {
      const id = Number(raw) || 0;
      if (id >= 1000) next.add(id);
    }
    this._favoritesExcludeIds = [...next];
    return this._favoritesExcludeIds;
  }

  /** Live Active+Gold / new writers — always read current exclude list. */
  favoritesExcludeSet() {
    return new Set(
      Array.isArray(this._favoritesExcludeIds) ? this._favoritesExcludeIds : [],
    );
  }

  setCredentialsProvider(fn) {
    this.credentialsProvider = typeof fn === "function" ? fn : null;
  }

  setCookieHeader(header) {
    this.cookieHeader = String(header || "").trim();
  }

  idleState(message = "Idle") {
    return {
      running: false,
      paused: false,
      stopRequested: false,
      page: 0,
      cycle: 0,
      sent: 0,
      failed: 0,
      skipped: 0,
      remaining: 0,
      duplicates: 0,
      favoritesFetched: 0,
      favoritesExcluded: 0,
      favoritesFetchedIds: [],
      favoritesExcludedIds: [],
      startedAt: 0,
      activeMs: 0,
      seen: 0,
      preset: "allReaders",
      galleryId: "",
      channel: this.channel || "read",
      direction: this.channel || "read",
      statusMessage: message,
      lastError: "",
      sentIds: [],
      failedIds: [],
      cloud: true,
      updatedAt: Date.now(),
      profileId: this.profileId,
    };
  }

  getState() {
    return { ...this.state, seen: this.seenMemberIds.size };
  }

  emit(patch = {}) {
    this.state = {
      ...this.state,
      ...patch,
      seen: this.seenMemberIds.size,
      cloud: true,
      updatedAt: Date.now(),
      profileId: this.profileId,
    };
    if (this.onStateChange) this.onStateChange(this.getState());
    return this.getState();
  }

  rememberId(kind, id) {
    const key = kind === "failed" ? "failedIds" : "sentIds";
    const n = Number(id) || 0;
    if (!n) return Array.isArray(this.state[key]) ? this.state[key] : [];
    const list = Array.isArray(this.state[key]) ? [...this.state[key]] : [];
    if (!list.includes(n)) list.push(n);
    return list;
  }

  /** Unique Failed men only — Online cycles must not inflate the counter. */
  bumpFailed(id) {
    const list = this.rememberId("failed", id);
    return {
      failed: list.length,
      failedIds: list,
    };
  }

  rememberExcludedFav(id) {
    const n = Number(id) || 0;
    const list = Array.isArray(this.state.favoritesExcludedIds)
      ? [...this.state.favoritesExcludedIds]
      : [];
    // Unique men only — Online cycles must not inflate the counter.
    if (n && !list.includes(n)) list.push(n);
    return {
      favoritesExcluded: list.length,
      favoritesExcludedIds: list,
    };
  }

  setFavoritesFetched(favorites) {
    const list =
      favorites instanceof Set
        ? Array.from(favorites)
        : Array.isArray(favorites)
          ? favorites
          : [];
    const ids = list.map(Number).filter(Boolean).slice(0, 4000);
    return {
      favoritesFetched: list.length,
      favoritesFetchedIds: ids,
    };
  }

  nextRemaining() {
    return { remaining: Math.max(0, (Number(this.state.remaining) || 0) - 1) };
  }

  keepRunStats() {
    const startedAt = Number(this.state.startedAt) || 0;
    const activeMs = startedAt
      ? Math.max(Number(this.state.activeMs) || 0, Date.now() - startedAt)
      : Number(this.state.activeMs) || 0;
    return {
      sent: this.state.sent,
      failed: this.state.failed,
      skipped: this.state.skipped,
      remaining: 0,
      duplicates: this.state.duplicates,
      favoritesFetched: this.state.favoritesFetched,
      favoritesExcluded: this.state.favoritesExcluded,
      favoritesFetchedIds: this.state.favoritesFetchedIds,
      favoritesExcludedIds: this.state.favoritesExcludedIds,
      startedAt,
      activeMs,
      sentIds: this.state.sentIds,
      failedIds: this.state.failedIds,
      preset: this.state.preset,
      galleryId: this.state.galleryId,
    };
  }

  async persist(isRunning = Boolean(this.state.running && !this.state.stopRequested)) {
    if (!this.onPersist || this.ownerUserId == null) return;
    try {
      const safeDupes = (this.dupeList || [])
        .map((v) => String(v || "").replace(/\u0000/g, "::"))
        .filter(Boolean)
        .slice(-DUPES_MAX);
      await this.onPersist({
        userId: this.ownerUserId,
        profileId: this.storeProfileId || this.profileId,
        cookieHeader: this.cookieHeader,
        selection: {
          text: this._jobText || "",
          preset: this.state.preset,
          galleryId: this.state.galleryId,
          delayMs: this._jobDelayMs || 1000,
          maxPages: this._jobMaxPages || 0,
          channel: this.channel || "read",
          direction: this.channel || "read",
          excludeFavorites: this.state.excludeFavorites !== false,
          checkDuplicates: this.state.checkDuplicates !== false,
          favoritesExcludeIds: this._favoritesExcludeIds,
          manualBlacklistIds: [...(this._manualBlacklistIds || [])],
        },
        state: this.getState(),
        dupes: safeDupes,
        isRunning,
      });
    } catch (error) {
      console.error("SenderReads persist failed:", error?.message || error);
    }
  }

  async ensureSession() {
    const probeUrl =
      this.channel === "online"
        ? `${ORIGIN}/members/jwtToken`
        : `${READS_URL}?mode=sent&page=1&returnJson=1&view=read`;

    if (this.cookieHeader) {
      try {
        const res = await this.dreamFetch(probeUrl, { method: "GET" });
        if (res.ok || res.status === 200) {
          const text = await res.text().catch(() => "");
          const finalUrl = String(res.url || "");
          const looksLogin =
            /id=["']loginform2["']/i.test(text) ||
            /\/login(?:[/?#]|$)/i.test(finalUrl) ||
            res.status === 401 ||
            res.status === 403;
          if (!looksLogin) return;
        }
      } catch (_) {}
    }

    if (!this.credentialsProvider) {
      throw new Error(
        "Dream session expired — open dream-singles.com in Chrome and Start again, or save Cloud Dream login in LetterBot",
      );
    }
    const creds = await this.credentialsProvider();
    if (!creds?.username || !creds?.password) {
      throw new Error(
        "Dream session expired — open dream-singles.com in Chrome and Start again, or save Cloud Dream login in LetterBot",
      );
    }
    try {
      const { cookieHeader } = await dreamLogin(creds.username, creds.password);
      this.setCookieHeader(cookieHeader);
    } catch (error) {
      const msg = String(error?.message || error);
      if (!hasTwoCaptcha() && !hasDreamProxy() && /captcha/i.test(msg)) {
        throw new Error(
          "Dream re-login needs captcha from server IP — set TWOCAPTCHA_API_KEY on Render (or open Chrome and Start with a live session)",
        );
      }
      if (!hasTwoCaptcha() && !hasDreamProxy()) {
        throw new Error(
          msg ||
            "Dream re-login failed from server — set TWOCAPTCHA_API_KEY on Render or Start from Chrome while logged in",
        );
      }
      throw new Error(msg || "Dream login failed");
    }
  }

  async dreamFetch(url, { method = "GET", body = null, headers = {} } = {}) {
    const nextHeaders = {
      Accept: method === "POST" ? "text/html" : "application/json,text/plain,*/*",
      "Accept-Language": "en-US,en;q=0.9",
      Referer: `${ORIGIN}/members/messaging/inbox`,
      ...headers,
    };
    if (this.cookieHeader) nextHeaders.Cookie = this.cookieHeader;
    return dreamHttp(url, {
      method,
      headers: nextHeaders,
      body,
      redirect: method === "POST" ? "manual" : "follow",
      timeoutMs: 45000,
    });
  }
  async fetchFavoritesIds() {
    // Same source as extension Inbox site-favorites: all folders + broad id fields.
    const ids = new Set();
    for (let page = 1; page <= 80; page += 1) {
      const url = `${FAVORITES_URL}?returnJson=1&all=1&folder=-1&page=${page}`;
      const response = await this.dreamFetch(url);
      if (response.status === 401 || response.status === 403) {
        throw new Error("Dream session expired — re-save credentials");
      }
      if (response.status === 429) {
        const retryAfter = Number(response.headers.get("Retry-After") || 60);
        await new Promise((r) => setTimeout(r, Math.max(5, retryAfter) * 1000));
        page -= 1;
        continue;
      }
      if (!response.ok) break;
      const data = await response.json().catch(() => null);
      const list = Array.isArray(data)
        ? data
        : data?.items || data?.profiles || data?.favorites || data?.data || [];
      if (!Array.isArray(list) || !list.length) break;
      const before = ids.size;
      for (const item of list) {
        if (!item || typeof item !== "object") continue;
        const candidates = [
          item.profile_id,
          item.profileId,
          item.id,
          item.regularId,
          item.profile_to?.id,
          item.profile_to,
          item.profile_from?.id,
          item.profile_from,
        ];
        for (const value of candidates) {
          const id = Number(value);
          if (id && id >= 1000) ids.add(id);
        }
      }
      if (ids.size === before) break;
      await new Promise((r) => setTimeout(r, 250));
    }
    return ids;
  }

  /** DreamAuto Online: favorites via WS (one round-trip), not 80 HTML pages. */
  async fetchFavoritesViaWs() {
    const ws = await this.ensureOnlineWs();
    return new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error("favorites-response timeout"));
      }, 12000);
      const cleanup = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try {
          ws.removeListener("message", onMessage);
        } catch (_) {}
      };
      const onMessage = (raw) => {
        let msg;
        try {
          msg = JSON.parse(String(raw));
        } catch {
          return;
        }
        if (msg.type !== "favorites-response") return;
        cleanup();
        const ids = new Set();
        const payload = Array.isArray(msg.payload) ? msg.payload : [];
        for (const item of payload) {
          const id = Number(item?.profile_to || item?.profile_id || item?.id || item?.regularId) || 0;
          if (id >= 1000) ids.add(id);
        }
        resolve(ids);
      };
      ws.on("message", onMessage);
      try {
        ws.send(JSON.stringify({ type: "favorites-request" }));
      } catch (error) {
        cleanup();
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  /** Prefer DreamAuto WS favorites; HTML scrape only if WS fails. */
  async fetchFavoritesIdsFast() {
    try {
      return await this.fetchFavoritesViaWs();
    } catch (error) {
      console.warn(
        "[senderReads] favorites WS failed, HTML fallback:",
        error?.message || error,
      );
      return this.fetchFavoritesIds();
    }
  }

  async fetchReadPage(page, { fromDate = "" } = {}) {
    // Same as DreamAuto / browser Readers JSON. Empty fd in HTML UI ≠ these params on returnJson.
    // "Today" = filter by letter row date (message.date) in code.
    const params = new URLSearchParams({
      mode: "sent",
      page: String(Math.max(1, Number(page) || 1)),
      returnJson: "1",
      view: "read",
    });
    void fromDate;
    const url = `${READS_URL}?${params.toString()}`;
    const response = await this.dreamFetch(url);
    if (response.status === 401 || response.status === 403) {
      throw new Error("Dream session expired — re-save credentials");
    }
    if (response.status === 429) {
      const retryAfter = Number(response.headers.get("Retry-After") || 60);
      const err = new Error("Rate limit reached");
      err.retryMs = Math.max(5, retryAfter) * 1000;
      throw err;
    }
    if (!response.ok) throw new Error(`Reads page HTTP ${response.status}`);
    const text = await response.text();
    if (!String(text || "").trim() || String(text).trim() === "no data") {
      return { endOfPages: true, messages: [], currentPage: page, lastPage: page };
    }
    const data = JSON.parse(text);
    const messages = Array.isArray(data?.messages) ? data.messages : [];
    const currentPage = Number(data?.currentPage || data?.page || page) || page;
    const rawLast = data?.lastPage ?? data?.pages;
    const lastPageNum = Number(rawLast);
    const hasKnownLast = Number.isFinite(lastPageNum) && lastPageNum > 0;
    const endOfPages = !messages.length || (hasKnownLast && currentPage >= lastPageNum);
    return {
      endOfPages,
      messages,
      currentPage,
      lastPage: hasKnownLast ? lastPageNum : 0,
    };
  }

  async resolveComposeIdFromProfile(maleProfileId) {
    const pid = Number(maleProfileId) || 0;
    if (!pid) return "";
    for (const path of [`${ORIGIN}/${pid}.html`, `${ORIGIN}/z-${pid}.html`]) {
      try {
        const res = await this.dreamFetch(path);
        if (!res.ok) continue;
        const html = await res.text();
        const match = html.match(/\/members\/messaging\/compose\/(\d+)/);
        if (match?.[1]) return match[1];
      } catch (_) {}
    }
    return "";
  }

  async postComposeOnce({ memberId, plain, photoId, replyId }) {
    const url = `${ORIGIN}/members/messaging/compose/${memberId}`;
    const fields = {
      "messaging_compose[replyId]": replyId || "",
      "messaging_compose[draftId]": "",
      "messaging_compose[type]": "plain_message",
      "messaging_compose[buttonClicked]": "1",
      "messaging_compose[plainMessage]": plain || "",
      "messaging_compose[htmlMessage]": "",
      "messaging_compose[galleryId]": photoId || "",
      "messaging_compose[videoGalleryId]": "",
      "messaging_compose[video]": "",
      "messaging_compose[submit2]": "1",
      "messaging_compose[selectedPhoto]": "",
      "messaging_compose[saveIntro]": "",
      "messaging_compose[videoReply]": "1",
      "messaging_compose[intro]": "",
    };

    // Prefer urlencoded (Symfony classic). Multipart FormData as used by DreamAuto in browser.
    const encoded = new URLSearchParams();
    for (const [k, v] of Object.entries(fields)) encoded.append(k, v);

    let response = await this.dreamFetch(url, {
      method: "POST",
      body: encoded.toString(),
      headers: {
        Accept: "text/html,application/xhtml+xml",
        "Content-Type": "application/x-www-form-urlencoded",
        Origin: ORIGIN,
        Referer: url,
      },
    });

    // If urlencoded clearly bounced to form, retry multipart once.
    if (response.status === 200) {
      const peek = await response.clone().text().catch(() => "");
      if (/name=["']messaging_compose\[plainMessage\]["']/i.test(peek)) {
        const form = new FormData();
        for (const [k, v] of Object.entries(fields)) form.append(k, v);
        response = await this.dreamFetch(url, {
          method: "POST",
          body: form,
          headers: {
            Accept: "text/html,application/xhtml+xml",
            Origin: ORIGIN,
            Referer: url,
          },
        });
      } else {
        // Re-wrap: we already consumed clone; use peek as body via synthetic path below
        return this._interpretComposeResponse(response, memberId, { preloadedHtml: peek });
      }
    }

    return this._interpretComposeResponse(response, memberId);
  }

  async _interpretComposeResponse(response, memberId, { preloadedHtml = null } = {}) {
    if (response.status === 429) {
      const err = new Error("Rate limit reached");
      err.retryMs = Math.max(5, Number(response.headers.get("Retry-After") || 60)) * 1000;
      throw err;
    }

    const locationHeader = response.headers.get("Location") || "";
    if (
      /\/login(?:[/?#]|$)/i.test(locationHeader) ||
      response.status === 401 ||
      response.status === 403
    ) {
      throw new Error("Dream session expired — re-save credentials");
    }

    const interpretHtml = (html, meta = {}) => {
      const text = String(html || "");
      const lower = text.toLowerCase();
      if (
        /id=["']loginform2["']/i.test(text) ||
        (/name=["']_password["']/i.test(text) && /name=["']_username["']/i.test(text))
      ) {
        throw new Error("Dream session expired — re-save credentials");
      }

      const danger = text.match(
        /class=["'][^"']*alert-danger[^"']*["'][^>]*>([\s\S]{0,300}?)<\//i,
      );
      if (danger) {
        const msg = String(danger[1] || "")
          .replace(/<[^>]+>/g, " ")
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, 160);
        const err = new Error(`Compose rejected by Dream${msg ? ` · ${msg}` : ""}`);
        err.httpStatus = meta.status || 400;
        throw err;
      }

      const stillComposeForm =
        /name=["']messaging_compose\[plainMessage\]["']/i.test(text) ||
        /id=["']messaging_compose_plainMessage["']/i.test(text);
      const successFlash =
        /letter (has been )?sent|message (has been )?sent|successfully sent|письмо отправлено|сообщение отправлено|your message has been/i.test(
          lower,
        );

      if (stillComposeForm && !successFlash) {
        const err = new Error(
          `Compose did not send (form returned)${meta.status ? ` · HTTP ${meta.status}` : ""}`,
        );
        err.httpStatus = meta.status || 200;
        throw err;
      }

      return { ok: true, status: meta.status || 200 };
    };

    if ([301, 302, 303, 307, 308].includes(response.status)) {
      if (!locationHeader) {
        const err = new Error(`Compose HTTP ${response.status} without Location`);
        err.httpStatus = response.status;
        throw err;
      }
      const abs = new URL(locationHeader, ORIGIN).toString();
      console.log(
        `[senderReads] compose redirect ${response.status} → ${abs.slice(0, 160)}`,
      );
      if (/\/members\/messaging\/compose\//i.test(abs)) {
        const again = await this.dreamFetch(abs, { method: "GET", redirect: "follow" });
        const html = await again.text().catch(() => "");
        return interpretHtml(html, { status: response.status, location: abs });
      }
      const follow = await this.dreamFetch(abs, { method: "GET", redirect: "follow" });
      const followHtml = await follow.text().catch(() => "");
      if (
        /id=["']loginform2["']/i.test(followHtml) ||
        (/name=["']_password["']/i.test(followHtml) && /name=["']_username["']/i.test(followHtml))
      ) {
        throw new Error("Dream session expired — re-save credentials");
      }
      return { ok: true, status: response.status, location: abs };
    }

    console.log(
      `[senderReads] compose HTTP ${response.status} (no redirect) composeId=${memberId}`,
    );

    if (response.status < 200 || response.status >= 400) {
      let bodySnippet = "";
      try {
        bodySnippet = String(await response.text()).replace(/\s+/g, " ").trim().slice(0, 160);
      } catch (_) {}
      const err = new Error(
        `Compose HTTP ${response.status}${bodySnippet ? ` · ${bodySnippet}` : ""}`,
      );
      err.httpStatus = response.status;
      throw err;
    }

    const html =
      preloadedHtml != null ? preloadedHtml : await response.text().catch(() => "");
    return interpretHtml(html, { status: response.status });
  }

  async sendCompose({ linkMemberId = "", text, galleryId = "", maleProfileId = 0 }) {
    const plain = String(text || "").trim();
    if (!plain) throw new Error("Letter text is empty");
    const photoId = String(galleryId || "").trim();
    const profileId = Number(maleProfileId) || 0;
    const fromLink = String(linkMemberId || "").trim();

    // DreamAuto Online WS already gives member_id — prefer it (skip profile scrape).
    let composeId = fromLink;
    if (!composeId && profileId) composeId = await this.resolveComposeIdFromProfile(profileId);
    if (!composeId) throw new Error(`No compose id for profile ${profileId || "?"}`);

    // Favorites-style empty replyId first; then generated (DreamAuto READ).
    const attempts = [
      { replyId: "", label: "emptyReply" },
      { replyId: generateReplyId(), label: "replyId" },
    ];
    let lastError = null;
    for (const attempt of attempts) {
      try {
        const result = await this.postComposeOnce({
          memberId: composeId,
          plain,
          photoId,
          replyId: attempt.replyId,
        });
        console.log(
          `[senderReads] sent profile=${profileId} compose=${composeId} via=${attempt.label}`,
        );
        return result;
      } catch (error) {
        lastError = error;
        console.warn(
          `[senderReads] compose fail profile=${profileId} compose=${composeId} via=${attempt.label}: ${error?.message || error}`,
        );
        if (error?.httpStatus !== 500 && !/did not send|rejected|still on form/i.test(String(error?.message || ""))) {
          // retry next attempt for soft compose failures; hard auth errors bubble
          if (/session expired/i.test(String(error?.message || ""))) throw error;
        }
        if (error?.httpStatus === 429) throw error;
      }
    }
    const alt = fromLink && fromLink !== composeId ? fromLink : "";
    if (alt) {
      try {
        return await this.postComposeOnce({
          memberId: alt,
          plain,
          photoId,
          replyId: "",
        });
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError || new Error("Compose failed");
  }
  pause() {
    if (!this.state.running) return this.getState();
    this.emit({ paused: true, statusMessage: "Paused" });
    void this.persist(true);
    return this.getState();
  }

  resume() {
    if (!this.state.running) return this.getState();
    this.emit({ paused: false, statusMessage: "Resuming…" });
    void this.persist(true);
    return this.getState();
  }

  stop() {
    // Invalidate the in-flight loop immediately (including DreamGate queue / favorites fetch).
    this.runToken += 1;
    this.closeOnlineWs();
    const stopped = {
      ...this.idleState("Stopped"),
      ...this.keepRunStats(),
      stopRequested: false,
      lastError: "",
    };
    this.emit(stopped);
    void this.persist(false);
    return this.getState();
  }

  async waitWhilePaused(token) {
    while (this.state.paused && !this.state.stopRequested && token === this.runToken) {
      this.emit({ statusMessage: "Paused" });
      await new Promise((r) => setTimeout(r, 400));
    }
  }

  async start(selection = {}) {
    if (this.state.running && !this.state.stopRequested) {
      // Allow Stop+Start / restart while a previous cloud loop is still winding down.
      this.runToken += 1;
      this.closeOnlineWs();
    }

    const channel = normalizeChannel(selection.channel || selection.direction || this.channel);
    this.channel = channel;
    this.storeProfileId =
      channel === "online" ? `${this.profileId}__online` : this.profileId;

    const plain = String(selection.text || "").trim();
    if (!plain) {
      this.emit(this.idleState("Enter letter text first"));
      return { ok: false, error: "Enter letter text first", state: this.getState() };
    }

    const token = ++this.runToken;
    const filters =
      channel === "online"
        ? {
            excludeFavorites:
              typeof selection.excludeFavorites === "boolean"
                ? selection.excludeFavorites
                : true,
            checkDuplicates:
              typeof selection.checkDuplicates === "boolean"
                ? selection.checkDuplicates
                : true,
            enableCycling: true,
            onlineOnly: false,
            todayOnly: false,
          }
        : resolveFilters(selection.preset, {
            excludeFavorites:
              typeof selection.excludeFavorites === "boolean"
                ? selection.excludeFavorites
                : undefined,
            checkDuplicates:
              typeof selection.checkDuplicates === "boolean"
                ? selection.checkDuplicates
                : undefined,
          });
    const photoId = String(selection.galleryId || "").trim();
    const delayMs = Math.max(200, Number(selection.delayMs) || 1000);
    const maxPages = Math.max(0, Number(selection.maxPages) || 0);

    this._jobText = plain;
    this._jobDelayMs = delayMs;
    this._jobMaxPages = maxPages;
    this._favoritesExcludeIds = Array.isArray(selection.favoritesExcludeIds)
      ? [
          ...new Set(
            selection.favoritesExcludeIds.map(Number).filter((id) => id >= 1000),
          ),
        ]
      : [];
    this.setManualBlacklistIds(selection.manualBlacklistIds);
    // Dream fd= fixed at Start (UTC calendar day on server clock).
    const resumeFrom =
      selection.resumeFrom && typeof selection.resumeFrom === "object"
        ? selection.resumeFrom
        : null;
    const resuming = Boolean(resumeFrom);
    if (filters.todayOnly) {
      this._readsFromDate =
        (resuming && String(resumeFrom.readsFromDate || "").trim()) ||
        String(selection.readsFromDate || "").trim() ||
        formatDreamFdDate(Date.now());
    } else {
      this._readsFromDate = "";
    }

    this.seenMemberIds.clear();
    if (resuming) {
      const keys = Array.isArray(resumeFrom.seenKeys) ? resumeFrom.seenKeys : [];
      for (const key of keys) {
        const raw = String(key || "").trim();
        if (raw) this.seenMemberIds.add(raw);
      }
      for (const id of Array.isArray(resumeFrom.sentIds) ? resumeFrom.sentIds : []) {
        const n = Number(id) || 0;
        if (n) this.seenMemberIds.add(String(n));
      }
      for (const id of Array.isArray(resumeFrom.failedIds) ? resumeFrom.failedIds : []) {
        const n = Number(id) || 0;
        if (n) this.seenMemberIds.add(String(n));
      }
    }

    if (Array.isArray(selection.dupes)) {
      this.dupeList = selection.dupes.map(String).slice(-DUPES_MAX);
    }

    const startedAt =
      resuming && Number(resumeFrom.startedAt) > 0
        ? Number(resumeFrom.startedAt)
        : Date.now();

    this.emit({
      running: true,
      paused: false,
      stopRequested: false,
      page: resuming ? Math.max(0, Number(resumeFrom.page) || 0) : 0,
      cycle: resuming ? Math.max(1, Number(resumeFrom.cycle) || 1) : 1,
      sent: resuming ? Math.max(0, Number(resumeFrom.sent) || 0) : 0,
      failed: resuming ? Math.max(0, Number(resumeFrom.failed) || 0) : 0,
      skipped: resuming ? Math.max(0, Number(resumeFrom.skipped) || 0) : 0,
      remaining: 0,
      duplicates: resuming ? Math.max(0, Number(resumeFrom.duplicates) || 0) : 0,
      favoritesFetched: resuming ? Math.max(0, Number(resumeFrom.favoritesFetched) || 0) : 0,
      favoritesExcluded: resuming ? Math.max(0, Number(resumeFrom.favoritesExcluded) || 0) : 0,
      favoritesFetchedIds: resuming
        ? Array.isArray(resumeFrom.favoritesFetchedIds)
          ? resumeFrom.favoritesFetchedIds.map(Number).filter(Boolean).slice(0, 4000)
          : []
        : [],
      favoritesExcludedIds: resuming
        ? Array.isArray(resumeFrom.favoritesExcludedIds)
          ? resumeFrom.favoritesExcludedIds.map(Number).filter(Boolean)
          : []
        : [],
      startedAt,
      activeMs: resuming ? Math.max(0, Number(resumeFrom.activeMs) || 0) : 0,
      sentIds: resuming
        ? Array.isArray(resumeFrom.sentIds)
          ? resumeFrom.sentIds.map(Number).filter(Boolean)
          : []
        : [],
      failedIds: resuming
        ? Array.isArray(resumeFrom.failedIds)
          ? resumeFrom.failedIds.map(Number).filter(Boolean)
          : []
        : [],
      preset: channel === "online" ? "onlineMen" : normalizePreset(selection.preset),
      galleryId: photoId,
      channel,
      direction: channel,
      lastError: "",
      statusMessage: resuming
        ? channel === "online"
          ? "Resuming cloud Online…"
          : "Resuming cloud Reads…"
        : channel === "online"
          ? "Starting cloud Online…"
          : filters.todayOnly && this._readsFromDate
            ? `Readers from ${this._readsFromDate}…`
            : "Starting cloud Reads…",
      readsFromDate: this._readsFromDate || "",
    });
    await this.persist(true);

    const runJob = async () => {
      if (this.state.stopRequested || token !== this.runToken) {
        this.emit(this.idleState("Stopped"));
        await this.persist(false);
        return;
      }
      this.emit({ statusMessage: "Preparing Dream session…" });
      await this.persist(true);
      try {
        await this.ensureSession();
      } catch (error) {
        if (token !== this.runToken) return;
        const msg = error?.message || String(error);
        this.emit({
          ...this.idleState(msg),
          lastError: msg,
          preset: this.state.preset,
          galleryId: photoId,
          channel,
          direction: channel,
        });
        await this.persist(false);
        return;
      }
      if (this.state.stopRequested || token !== this.runToken) {
        this.emit(this.idleState("Stopped"));
        await this.persist(false);
        return;
      }
      this.emit({
        statusMessage:
          channel === "online"
            ? "Starting Online list…"
            : filters.excludeFavorites
              ? "Loading Favorites table…"
              : `Cycle ${this.state.cycle || 1} · Reads page 1…`,
      });
      await this.persist(true);

      try {
        if (channel === "online") {
          await this.runOnlineLoop(token, plain, filters, photoId, delayMs);
        } else {
          await this.runLoop(token, plain, filters, photoId, delayMs, maxPages);
        }
      } catch (error) {
        if (token !== this.runToken) return;
        const msg = error?.message || String(error);
        this.emit({
          ...this.idleState(msg || "Reads failed"),
          ...this.keepRunStats(),
          lastError: msg,
        });
        await this.persist(false);
      }
    };

    // Return immediately — session + favorites + pages run in background.
    // Old loop exits on runToken mismatch after its current fetch.
    void runJob();

    return { ok: true, state: this.getState() };
  }

  async runLoop(token, plain, filters, photoId, delayMs, maxPages) {
    try {
      if (this.state.stopRequested || token !== this.runToken) {
        this.emit(this.idleState("Stopped"));
        await this.persist(false);
        return;
      }
      // Session prepared in background runJob before runLoop.
      let favorites = new Set();
      if (filters.excludeFavorites) {
        if (this.state.stopRequested || token !== this.runToken) {
          this.emit(this.idleState("Stopped"));
          await this.persist(false);
          return;
        }
        this.emit({ statusMessage: "Loading Favorites table…" });
        // Active+Gold IDs from extension Favorites table only — never Dream ★ scrape
        // (site stars include men who are not in AutoSender Favorites / Last Man).
        favorites = new Set(
          Array.isArray(this._favoritesExcludeIds) ? this._favoritesExcludeIds : [],
        );
        if (this.state.stopRequested || token !== this.runToken) {
          this.emit(this.idleState("Stopped"));
          await this.persist(false);
          return;
        }
        this.emit({
          ...this.setFavoritesFetched(favorites),
          statusMessage: `Favorites table: ${favorites.size}`,
        });
      }

      const dupeSet = filters.checkDuplicates ? new Set(this.dupeList) : new Set();
      let page = Math.max(1, Number(this.state.page) || 1);
      let sentAtCycleStart =
        Number(this.state.sent) > 0 ? Number(this.state.sent) - 1 : 0;
      let skipOffline = 0;
      let skipFav = 0;
      let skipDupe = 0;
      let skipBad = 0;
      let skipSeen = 0;
      let skipOld = 0;
      let readsFromDate = filters.todayOnly
        ? String(this._readsFromDate || this.state.readsFromDate || "").trim()
        : "";

      const skipSummary = () =>
        `offline ${skipOffline}, fav ${skipFav}, dupe ${skipDupe}, notToday ${skipOld}, bad ${skipBad}, seen ${skipSeen}`;

      while (!this.state.stopRequested && token === this.runToken) {
        await this.waitWhilePaused(token);
        if (this.state.stopRequested || token !== this.runToken) break;
        if (filters.excludeFavorites) {
          favorites = this.favoritesExcludeSet();
        }

        this.emit({
          page,
          readsFromDate: readsFromDate || undefined,
          statusMessage: filters.enableCycling
            ? `Cycle ${this.state.cycle} · Reads page ${page}…`
            : readsFromDate
              ? `Reads page ${page} · from ${readsFromDate}…`
              : `Reads page ${page}…`,
        });

        let result;
        try {
          result = await this.fetchReadPage(page, { fromDate: readsFromDate });
        } catch (error) {
          if (error?.retryMs) {
            this.emit({
              statusMessage: `Rate limit — wait ${Math.ceil(error.retryMs / 1000)}s`,
            });
            await new Promise((r) => setTimeout(r, error.retryMs));
            continue;
          }
          if (/session expired/i.test(String(error?.message || ""))) {
            await this.ensureSession();
            continue;
          }
          throw error;
        }

        const messages = result.messages || [];
        const endOfPages = result.endOfPages || !messages.length;
        let pageOnline = 0;
        let pageFav = 0;
        let pageDupe = 0;
        this.emit({ remaining: messages.length });

        for (const message of messages) {
          if (this.state.stopRequested || token !== this.runToken) break;
          await this.waitWhilePaused(token);
          if (this.state.stopRequested || token !== this.runToken) break;

          const target = parseReadTarget(message);
          if (!target?.maleProfileId) {
            this.emit({ skipped: this.state.skipped + 1, ...this.nextRemaining() });
            skipBad += 1;
            continue;
          }
          if (this.seenMemberIds.has(String(target.maleProfileId))) {
            this.emit({ skipped: this.state.skipped + 1, ...this.nextRemaining() });
            skipSeen += 1;
            continue;
          }
          if (
            filters.excludeFavorites &&
            favorites.has(Number(target.maleProfileId) || 0)
          ) {
            this.emit({
              skipped: this.state.skipped + 1,
              ...this.rememberExcludedFav(target.maleProfileId),
              ...this.nextRemaining(),
            });
            pageFav += 1;
            skipFav += 1;
            continue;
          }
          if (this._manualBlacklistIds?.has(Number(target.maleProfileId) || 0)) {
            this.seenMemberIds.add(String(target.maleProfileId));
            this.emit({ skipped: this.state.skipped + 1, ...this.nextRemaining() });
            skipSeen += 1;
            continue;
          }
          // Today = date on the letter row (message.date), not Dream Search fd=.
          if (filters.todayOnly && readsFromDate && !isReadOnFdDay(message, readsFromDate)) {
            this.emit({ skipped: this.state.skipped + 1, ...this.nextRemaining() });
            skipOld += 1;
            continue;
          }
          if (!isReadOnlineEligible(message, filters.onlineOnly)) {
            this.emit({ skipped: this.state.skipped + 1, ...this.nextRemaining() });
            pageOnline += 1;
            skipOffline += 1;
            continue;
          }

          const hash = messageHash(target.maleProfileId, plain);
          if (filters.checkDuplicates && dupeSet.has(hash)) {
            // DreamAuto: pre-send duplicate → Failed, no Dream POST.
            pageDupe += 1;
            skipDupe += 1;
            this.seenMemberIds.add(String(target.maleProfileId));
            this.emit({
              ...this.bumpFailed(target.maleProfileId),
              duplicates: (Number(this.state.duplicates) || 0) + 1,
              statusMessage: `Duplicate → ${target.maleProfileId}`,
              lastError: "",
              ...this.nextRemaining(),
            });
            continue;
          }

          this.seenMemberIds.add(String(target.maleProfileId));
          this.emit({
            lastError: "",
            statusMessage: `Sending → ${target.maleProfileId}`,
          });

          let usedNetworkSend = false;
          const rememberDupeFromReject = async (err) => {
            if (!filters.checkDuplicates || !isComposeRejectWorthDuping(err)) return false;
            dupeSet.add(hash);
            this.dupeList = [...dupeSet].slice(-DUPES_MAX);
            return true;
          };

          try {
            usedNetworkSend = true;
            await this.sendCompose({
              linkMemberId: target.linkMemberId,
              text: plain,
              galleryId: photoId,
              maleProfileId: target.maleProfileId,
            });
            if (filters.checkDuplicates) {
              dupeSet.add(hash);
              this.dupeList = [...dupeSet].slice(-DUPES_MAX);
            }
            this.emit({
              sent: this.state.sent + 1,
              lastError: "",
              statusMessage: `Sent → ${target.maleProfileId}`,
              sentIds: this.rememberId("sent", target.maleProfileId),
              ...this.nextRemaining(),
            });
            await this.persist(true);
          } catch (error) {
            if (error?.retryMs) {
              this.emit({
                statusMessage: `Rate limit — wait ${Math.ceil(error.retryMs / 1000)}s`,
              });
              await new Promise((r) => setTimeout(r, error.retryMs));
              try {
                usedNetworkSend = true;
                await this.sendCompose({
                  linkMemberId: target.linkMemberId,
                  text: plain,
                  galleryId: photoId,
                  maleProfileId: target.maleProfileId,
                });
                if (filters.checkDuplicates) {
                  dupeSet.add(hash);
                  this.dupeList = [...dupeSet].slice(-DUPES_MAX);
                }
                this.emit({
                  sent: this.state.sent + 1,
                  lastError: "",
                  statusMessage: `Sent → ${target.maleProfileId}`,
                  sentIds: this.rememberId("sent", target.maleProfileId),
                  ...this.nextRemaining(),
                });
              } catch (retryError) {
                const duped = await rememberDupeFromReject(retryError);
                this.emit({
                  ...this.bumpFailed(target.maleProfileId),
                  duplicates: duped
                    ? (Number(this.state.duplicates) || 0) + 1
                    : this.state.duplicates,
                  lastError: retryError?.message || String(retryError),
                  statusMessage: duped
                    ? `Duplicate → ${target.maleProfileId}`
                    : this.state.statusMessage,
                  ...this.nextRemaining(),
                });
              }
            } else if (/session expired/i.test(String(error?.message || ""))) {
              await this.ensureSession();
              this.seenMemberIds.delete(String(target.maleProfileId));
              continue;
            } else {
              const duped = await rememberDupeFromReject(error);
              this.emit({
                ...this.bumpFailed(target.maleProfileId),
                duplicates: duped
                  ? (Number(this.state.duplicates) || 0) + 1
                  : this.state.duplicates,
                lastError: error?.message || String(error),
                statusMessage: duped
                  ? `Duplicate → ${target.maleProfileId}`
                  : this.state.statusMessage,
                ...this.nextRemaining(),
              });
            }
            await this.persist(true);
          }

          // Gap only after a real Dream POST (DreamAuto ~50ms floor; Default still applies).
          if (usedNetworkSend) {
            await new Promise((r) => setTimeout(r, delayMs));
          }
        }

        this.emit({ remaining: 0 });

        if (messages.length) {
          this.emit({
            statusMessage: filters.enableCycling
              ? `Cycle ${this.state.cycle} · page ${page}: skip offline ${pageOnline}, fav ${pageFav}, dupe ${pageDupe}`
              : `Page ${page}: skip offline ${pageOnline}, fav ${pageFav}, dupe ${pageDupe}`,
          });
        }

        if (this.state.stopRequested || token !== this.runToken) break;

        const restartCycle = async () => {
          const emptyCycle = this.state.sent === sentAtCycleStart;
          // Empty pass while cycling (All readers · Online, Readers today · …):
          // wait and re-scan from page 1 for newly online / new readers — same
          // as Readers today · Online. Do not stop just because this pass sent 0.
          if (emptyCycle) {
            this.emit({
              statusMessage: filters.onlineOnly
                ? `Cycle ${this.state.cycle}: waiting for new online readers… (${skipSummary()})`
                : `Cycle ${this.state.cycle}: waiting for new readers… (${skipSummary()})`,
            });
            skipOffline = 0;
            skipFav = 0;
            skipDupe = 0;
            skipBad = 0;
            skipSeen = 0;
            skipOld = 0;
            await new Promise((r) => setTimeout(r, 8000));
            if (this.state.stopRequested || token !== this.runToken) return false;
          }
          if (filters.todayOnly) {
            const nextFd = formatDreamFdDate(Date.now());
            if (nextFd && nextFd !== readsFromDate) {
              readsFromDate = nextFd;
              this._readsFromDate = nextFd;
            }
          }
          sentAtCycleStart = this.state.sent;
          this.seenMemberIds.clear();
          this.emit({
            cycle: this.state.cycle + 1,
            page: 1,
            readsFromDate: readsFromDate || undefined,
            statusMessage: `Cycle ${this.state.cycle + 1} · page 1…`,
          });
          page = 1;
          await new Promise((r) =>
            setTimeout(r, emptyCycle ? 500 : 3000),
          );
          return true;
        };

        if (maxPages > 0 && page >= maxPages) {
          if (filters.enableCycling) {
            const ok = await restartCycle();
            if (!ok) return;
            continue;
          }
          break;
        }

        // Stop paging when list reaches letters older than Start day (newest-first).
        const reachedTodayCutoff =
          filters.todayOnly &&
          readsFromDate &&
          readPageHasOlderThanFd(messages, readsFromDate);

        if (endOfPages || reachedTodayCutoff) {
          if (filters.enableCycling) {
            const ok = await restartCycle();
            if (!ok) return;
            continue;
          }
          break;
        }

        page += 1;
        await new Promise((r) => setTimeout(r, 150));
      }

      if (token === this.runToken) {
        this.emit({
          ...this.idleState(this.state.stopRequested ? "Stopped" : "Reads complete"),
          ...this.keepRunStats(),
        });
        await this.persist(false);
      }
    } catch (error) {
      if (token === this.runToken) {
        const msg = error?.message || String(error);
        this.emit({
          ...this.idleState(msg || "Reads failed"),
          ...this.keepRunStats(),
          lastError: msg,
        });
        await this.persist(false);
      }
    }
  }

  async fetchInviteJwt() {
    // DreamAuto / actionWorker: /members/jwtToken (raw token text).
    try {
      const response = await this.dreamFetch(`${ORIGIN}/members/jwtToken`, {
        headers: {
          Accept: "application/json",
          "X-Requested-With": "XMLHttpRequest",
        },
      });
      if (response.ok) {
        const token = normalizeInviteJwt(await response.text());
        if (token) return token;
      }
    } catch (_) {}

    const urls = [
      `${ORIGIN}/members/messaging/bot/send`,
      `${ORIGIN}/members/`,
    ];
    for (const url of urls) {
      try {
        const response = await this.dreamFetch(url, {
          headers: { Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8" },
        });
        if (!response.ok) continue;
        const html = await response.text();
        const match = String(html || "").match(/const\s+jwtKey\s*=\s*['"]([^'"]+)['"]/);
        const token = normalizeInviteJwt(match?.[1] || "");
        if (token) return token;
      } catch (_) {}
    }
    throw new Error("Dream JWT not found for Online WebSocket — re-save Dream login");
  }

  closeOnlineWs() {
    const ws = this._onlineWs;
    this._onlineWs = null;
    this._onlineJwt = "";
    if (!ws) return;
    try {
      ws.removeAllListeners?.();
      ws.close();
    } catch (_) {}
  }

  async ensureOnlineWs() {
    if (this._onlineWs?.readyState === WebSocket.OPEN) return this._onlineWs;
    this.closeOnlineWs();
    const jwt = await this.fetchInviteJwt();
    this._onlineJwt = jwt;

    return new Promise((resolve, reject) => {
      let settled = false;
      const ws = new WebSocket(DREAM_WS_URL, {
        headers: {
          Origin: ORIGIN,
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        },
      });
      const timer = setTimeout(() => {
        fail(new Error("Online WebSocket timeout"));
      }, 20000);
      const fail = (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try {
          ws.close();
        } catch (_) {}
        this._onlineWs = null;
        reject(err instanceof Error ? err : new Error(String(err)));
      };
      const ok = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this._onlineWs = ws;
        resolve(ws);
      };

      ws.on("open", () => {
        try {
          ws.send(
            JSON.stringify({
              type: "auth",
              connection: "invite",
              subscribe_to: ["auth-response", "men-online-response", "favorites-response"],
              payload: jwt,
            }),
          );
        } catch (error) {
          fail(error);
        }
      });
      ws.on("message", (raw) => {
        let msg;
        try {
          msg = JSON.parse(String(raw));
        } catch {
          return;
        }
        if (msg.type !== "auth-response") return;
        if (msg.success) ok();
        else fail(new Error(msg.error || msg.message || "Online WS auth failed"));
      });
      ws.on("error", () => fail(new Error("Online WebSocket connection error")));
      ws.on("close", () => {
        if (!settled) fail(new Error("Online WebSocket closed"));
        if (this._onlineWs === ws) this._onlineWs = null;
      });
    });
  }

  /**
   * DreamAuto default Online list: WS type men-online / men-online-response.
   * Returns [{ id, memberId }] — memberId is compose id when present.
   */
  async fetchOnlineUsersPageViaWs(page) {
    const ws = await this.ensureOnlineWs();
    const pageNum = Math.max(1, Number(page) || 1);
    return new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error("men-online timeout"));
      }, 25000);
      const cleanup = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try {
          ws.removeListener("message", onMessage);
        } catch (_) {}
      };
      const onMessage = (raw) => {
        let msg;
        try {
          msg = JSON.parse(String(raw));
        } catch {
          return;
        }
        if (msg.type !== "men-online-response") return;
        cleanup();
        resolve(parseMenOnlinePayload(msg.payload));
      };
      ws.on("message", onMessage);
      try {
        ws.send(JSON.stringify({ type: "men-online", sort: "login", page: pageNum }));
      } catch (error) {
        cleanup();
        this.closeOnlineWs();
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  /**
   * Online list: WebSocket men-online only (no HTML gallery fallback).
   */
  async fetchOnlineUsersPageSmart(page) {
    const rows = await this.fetchOnlineUsersPageViaWs(page);
    return { rows: Array.isArray(rows) ? rows : [], source: "ws" };
  }

  /** Build profile-id set from WS men-online (same source as Online channel). */
  async collectOnlineIdSet({ maxPages = 20 } = {}) {
    const ids = new Set();
    for (let page = 1; page <= maxPages; page += 1) {
      if (this.state.stopRequested) break;
      let rows = [];
      try {
        const fetched = await this.fetchOnlineUsersPageSmart(page);
        rows = Array.isArray(fetched?.rows) ? fetched.rows : [];
      } catch (error) {
        if (page === 1) throw error;
        break;
      }
      if (!rows.length) break;
      for (const row of rows) {
        const id = Number(row?.id) || 0;
        if (id) ids.add(id);
      }
      if (rows.length < 12) break;
    }
    return ids;
  }

  async runOnlineLoop(token, plain, filters, photoId, delayMs) {
    try {
      if (this.state.stopRequested || token !== this.runToken) {
        this.emit(this.idleState("Stopped"));
        await this.persist(false);
        return;
      }
      let favorites = new Set();
      if (filters.excludeFavorites) {
        if (this.state.stopRequested || token !== this.runToken) {
          this.emit(this.idleState("Stopped"));
          await this.persist(false);
          return;
        }
        this.emit({ statusMessage: "Loading Favorites table…" });
        // Active+Gold from extension Favorites UI only — never Dream ★ / WS favorites.
        favorites = new Set(
          Array.isArray(this._favoritesExcludeIds) ? this._favoritesExcludeIds : [],
        );
        if (this.state.stopRequested || token !== this.runToken) {
          this.emit(this.idleState("Stopped"));
          await this.persist(false);
          return;
        }
        this.emit({
          ...this.setFavoritesFetched(favorites),
          statusMessage: `Favorites table: ${favorites.size}`,
        });
      }

      const dupeSet = filters.checkDuplicates ? new Set(this.dupeList) : new Set();
      let page = Math.max(1, Number(this.state.page) || 1);
      let skipFav = 0;
      let skipDupe = 0;
      let skipSeen = 0;
      const pageSoftCap = 100;
      // Consecutive pages with nobody new to mail → wrap + wait for fresh online men.
      let barrenPages = 0;

      while (!this.state.stopRequested && token === this.runToken) {
        await this.waitWhilePaused(token);
        if (this.state.stopRequested || token !== this.runToken) break;
        if (filters.excludeFavorites) {
          favorites = this.favoritesExcludeSet();
        }

        let onlineRows = [];
        try {
          const fetched = await this.fetchOnlineUsersPageSmart(page);
          onlineRows = Array.isArray(fetched?.rows) ? fetched.rows : [];
          this.emit({
            page,
            statusMessage: `Looking online · page ${page}…`,
          });
        } catch (error) {
          if (error?.retryMs) {
            this.emit({
              statusMessage: `Rate limit — wait ${Math.ceil(error.retryMs / 1000)}s`,
            });
            await new Promise((r) => setTimeout(r, error.retryMs));
            continue;
          }
          const msg = String(error?.message || error || "");
          if (
            /timeout|web\s*socket|men-online|jwt|closed|connection|ECONN|ENOTFOUND|socket|session|expired|auth|login|credentials|captcha/i.test(
              msg,
            )
          ) {
            this.emit({
              statusMessage: `Online list reconnecting… (${msg})`,
              lastError: "",
            });
            this.closeOnlineWs();
            try {
              await this.ensureSession();
            } catch (sessionError) {
              this.emit({
                statusMessage: `Dream re-login… (${sessionError?.message || sessionError})`,
                lastError: "",
              });
            }
            await new Promise((r) => setTimeout(r, 5000));
            if (this.state.stopRequested || token !== this.runToken) break;
            continue;
          }
          throw error;
        }

        // End of list or blank page → back to page 1 and keep watching.
        if (!onlineRows.length) {
          barrenPages += 1;
          this.closeOnlineWs();
          this.seenMemberIds.clear();
          page = 1;
          this.emit({
            page: 1,
            statusMessage:
              barrenPages <= 2
                ? `No online men on list — refresh ${barrenPages}…`
                : `Waiting for new online men…`,
          });
          await new Promise((r) => setTimeout(r, barrenPages <= 2 ? 4000 : 12000));
          if (this.state.stopRequested || token !== this.runToken) break;
          continue;
        }

        this.emit({ remaining: onlineRows.length });
        let mailedThisPage = 0;

        for (const row of onlineRows) {
          if (this.state.stopRequested || token !== this.runToken) break;
          await this.waitWhilePaused(token);
          if (this.state.stopRequested || token !== this.runToken) break;

          const maleProfileId = Number(row?.id) || 0;
          const linkMemberId = String(row?.memberId || "").trim();
          if (!maleProfileId) {
            this.emit({ ...this.nextRemaining() });
            continue;
          }
          if (this.seenMemberIds.has(String(maleProfileId))) {
            skipSeen += 1;
            this.emit({ skipped: this.state.skipped + 1, ...this.nextRemaining() });
            continue;
          }
          if (filters.excludeFavorites && favorites.has(Number(maleProfileId) || 0)) {
            this.seenMemberIds.add(String(maleProfileId));
            skipFav += 1;
            this.emit({
              skipped: this.state.skipped + 1,
              ...this.rememberExcludedFav(maleProfileId),
              ...this.nextRemaining(),
            });
            continue;
          }
          if (this._manualBlacklistIds?.has(Number(maleProfileId) || 0)) {
            this.seenMemberIds.add(String(maleProfileId));
            skipSeen += 1;
            this.emit({ skipped: this.state.skipped + 1, ...this.nextRemaining() });
            continue;
          }

          const hash = messageHash(maleProfileId, plain);
          if (filters.checkDuplicates && dupeSet.has(hash)) {
            // Already mailed this letter — skip quietly on re-scan (don't inflate Failed).
            this.seenMemberIds.add(String(maleProfileId));
            skipDupe += 1;
            this.emit({ skipped: this.state.skipped + 1, ...this.nextRemaining() });
            continue;
          }

          this.seenMemberIds.add(String(maleProfileId));
          this.emit({
            lastError: "",
            statusMessage: `Sending → ${maleProfileId}`,
          });

          let usedNetworkSend = false;
          const rememberDupeFromReject = async (err) => {
            if (!filters.checkDuplicates || !isComposeRejectWorthDuping(err)) return false;
            dupeSet.add(hash);
            this.dupeList = [...dupeSet].slice(-DUPES_MAX);
            return true;
          };

          try {
            usedNetworkSend = true;
            await this.sendCompose({
              text: plain,
              galleryId: photoId,
              maleProfileId,
              linkMemberId,
            });
            mailedThisPage += 1;
            barrenPages = 0;
            this.emit({
              sent: this.state.sent + 1,
              lastError: "",
              statusMessage: `Sent → ${maleProfileId}`,
              sentIds: this.rememberId("sent", maleProfileId),
              ...this.nextRemaining(),
            });
            if (filters.checkDuplicates) {
              dupeSet.add(hash);
              this.dupeList = [...dupeSet].slice(-DUPES_MAX);
              await this.persist(true);
            }
          } catch (error) {
            if (error?.retryMs) {
              this.emit({
                statusMessage: `Rate limit — wait ${Math.ceil(error.retryMs / 1000)}s`,
              });
              await new Promise((r) => setTimeout(r, error.retryMs));
              try {
                usedNetworkSend = true;
                await this.sendCompose({
                  text: plain,
                  galleryId: photoId,
                  maleProfileId,
                  linkMemberId,
                });
                mailedThisPage += 1;
                barrenPages = 0;
                this.emit({
                  sent: this.state.sent + 1,
                  lastError: "",
                  statusMessage: `Sent → ${maleProfileId}`,
                  sentIds: this.rememberId("sent", maleProfileId),
                  ...this.nextRemaining(),
                });
                if (filters.checkDuplicates) {
                  dupeSet.add(hash);
                  this.dupeList = [...dupeSet].slice(-DUPES_MAX);
                  await this.persist(true);
                }
              } catch (retryError) {
                const duped = await rememberDupeFromReject(retryError);
                this.emit({
                  ...this.bumpFailed(maleProfileId),
                  duplicates: duped
                    ? (Number(this.state.duplicates) || 0) + 1
                    : this.state.duplicates,
                  lastError: retryError?.message || String(retryError),
                  statusMessage: duped ? `Duplicate → ${maleProfileId}` : undefined,
                  ...this.nextRemaining(),
                });
                await this.persist(true);
              }
            } else if (/session expired/i.test(String(error?.message || ""))) {
              this.emit({ statusMessage: "Dream session expired — re-login…" });
              await this.ensureSession();
              this.seenMemberIds.delete(String(maleProfileId));
              continue;
            } else {
              const duped = await rememberDupeFromReject(error);
              this.emit({
                ...this.bumpFailed(maleProfileId),
                duplicates: duped
                  ? (Number(this.state.duplicates) || 0) + 1
                  : this.state.duplicates,
                lastError: error?.message || String(error),
                statusMessage: duped ? `Duplicate → ${maleProfileId}` : undefined,
                ...this.nextRemaining(),
              });
              await this.persist(true);
            }
          }

          if (usedNetworkSend) {
            await new Promise((r) => setTimeout(r, delayMs));
          }
        }

        this.emit({ remaining: 0 });
        if (this.state.stopRequested || token !== this.runToken) break;

        if (mailedThisPage === 0) barrenPages += 1;
        else barrenPages = 0;

        // Same as DreamAuto actionWorker: next page, wrap at soft cap.
        page += 1;
        if (page > pageSoftCap || barrenPages >= 2) {
          this.seenMemberIds.clear();
          page = 1;
          this.emit({
            cycle: (Number(this.state.cycle) || 1) + 1,
            page: 1,
            statusMessage:
              barrenPages >= 2
                ? "Waiting for new online men…"
                : `Cycle ${(Number(this.state.cycle) || 1) + 1} · looking…`,
          });
          await new Promise((r) => setTimeout(r, barrenPages >= 2 ? 10000 : 2500));
          if (barrenPages >= 2) barrenPages = 0;
        } else {
          await new Promise((r) => setTimeout(r, 400));
        }
      }

      this.closeOnlineWs();
      // Online is endless until Stop — never idle as "complete" after a normal loop exit.
      if (token === this.runToken && this.state.running && !this.state.stopRequested) {
        this.emit({ statusMessage: "Online cycle ended — restarting…" });
        await this.persist(true);
        await new Promise((r) => setTimeout(r, 3000));
        if (token === this.runToken && !this.state.stopRequested) {
          return this.runOnlineLoop(token, plain, filters, photoId, delayMs);
        }
      }
      if (token === this.runToken && this.state.running) {
        this.emit({
          ...this.idleState(this.state.stopRequested ? "Stopped" : "Online complete"),
          ...this.keepRunStats(),
          statusMessage: this.state.stopRequested ? "Stopped" : "Online complete",
          channel: "online",
          direction: "online",
        });
      }
      await this.persist(false);
    } catch (error) {
      this.closeOnlineWs();
      if (token !== this.runToken) return;
      const msg = error?.message || String(error);
      if (this.state.stopRequested) {
        this.emit({
          ...this.idleState("Stopped"),
          ...this.keepRunStats(),
          statusMessage: "Stopped",
          lastError: "",
          channel: "online",
          direction: "online",
        });
        await this.persist(false);
        return;
      }
      // Survive unexpected errors (session death after cabinet logout, Render blips, …).
      this.emit({
        running: true,
        paused: false,
        statusMessage: `Online recovering… (${msg})`,
        lastError: "",
        channel: "online",
        direction: "online",
      });
      await this.persist(true);
      try {
        await this.ensureSession();
      } catch (_) {}
      await new Promise((r) => setTimeout(r, 8000));
      if (token === this.runToken && !this.state.stopRequested) {
        return this.runOnlineLoop(token, plain, filters, photoId, delayMs);
      }
    }
  }

  /** Restore after API restart. */
  async restoreFromJob(row = {}) {
    const selection = row.selection || {};
    const state = row.state || {};
    const channel = normalizeChannel(
      selection.channel || selection.direction || state.channel || this.channel,
    );
    this.channel = channel;
    this.storeProfileId =
      channel === "online" ? `${this.profileId}__online` : this.profileId;
    if (Array.isArray(row.dupes)) this.dupeList = row.dupes.map(String);
    if (row.cookie_header) this.setCookieHeader(row.cookie_header);
    if (!state.running) {
      this.emit({
        ...this.idleState(state.statusMessage || "Idle"),
        ...state,
        running: false,
        channel,
        direction: channel,
      });
      return;
    }
    // Preserve Sent/Failed/… — blind start() used to zero counters after every API reboot.
    await this.start({
      text: selection.text || "",
      preset: selection.preset || state.preset,
      galleryId: selection.galleryId || state.galleryId,
      delayMs: selection.delayMs,
      maxPages: selection.maxPages,
      channel,
      direction: channel,
      excludeFavorites: selection.excludeFavorites,
      checkDuplicates: selection.checkDuplicates,
      favoritesExcludeIds: selection.favoritesExcludeIds,
      manualBlacklistIds: selection.manualBlacklistIds,
      dupes: this.dupeList,
      resumeFrom: state,
    });
  }
}
