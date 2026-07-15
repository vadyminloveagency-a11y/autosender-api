import { dreamLogin } from "./dreamLogin.js";
import { withDreamGate } from "./dreamGate.js";
import { dreamHttp, hasDreamProxy } from "./dreamHttp.js";
import { hasTwoCaptcha } from "./twoCaptcha.js";

const ORIGIN = "https://www.dream-singles.com";
const READS_URL = `${ORIGIN}/members/messaging/inbox`;
const FAVORITES_URL = `${ORIGIN}/members/connections/myFavorites`;
const ONLINE_URL = `${ORIGIN}/gallery/results`;
const DUPES_MAX = 8000;

const PRESETS = {
  allReaders: {
    excludeFavorites: true,
    checkDuplicates: true,
    onlineOnly: false,
    enableCycling: false,
  },
  onlyOnline: {
    excludeFavorites: true,
    checkDuplicates: true,
    onlineOnly: true,
    enableCycling: true,
  },
};

function normalizePreset(value) {
  return value === "onlyOnline" ? "onlyOnline" : "allReaders";
}

function resolveFilters(preset, overrides = {}) {
  const base = { ...PRESETS[normalizePreset(preset)] };
  if (typeof overrides.excludeFavorites === "boolean") {
    base.excludeFavorites = overrides.excludeFavorites;
  }
  if (typeof overrides.checkDuplicates === "boolean") {
    base.checkDuplicates = overrides.checkDuplicates;
  }
  return base;
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

function isReadOnlineEligible(message, onlineOnly) {
  return !onlineOnly || Boolean(message?.online);
}

function normalizeChannel(value) {
  return String(value || "").toLowerCase() === "online" ? "online" : "read";
}

/** DreamAuto Online Users HTML: a.profile-link[data-profile_id] */
function parseOnlineUsersHtml(html) {
  const ids = [];
  const seen = new Set();
  const re = /<a\b[^>]*>/gi;
  let match;
  while ((match = re.exec(String(html || "")))) {
    const tag = match[0];
    if (!/\bprofile-link\b/i.test(tag)) continue;
    const idMatch = tag.match(/\bdata-profile_id=["'](\d+)["']/i);
    const hrefMatch = tag.match(/\bhref=["'](\/\d+\.html)["']/i);
    if (!idMatch || !hrefMatch) continue;
    const id = Number(idMatch[1]);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
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

    this.state = this.idleState("Idle");
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

  rememberExcludedFav(id) {
    const n = Number(id) || 0;
    const list = Array.isArray(this.state.favoritesExcludedIds)
      ? [...this.state.favoritesExcludedIds]
      : [];
    if (n && !list.includes(n)) list.push(n);
    return {
      favoritesExcluded: (Number(this.state.favoritesExcluded) || 0) + 1,
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
        ? `${ONLINE_URL}?online=men&page=1`
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

  async fetchReadPage(page) {
    const url = `${READS_URL}?mode=sent&page=${Math.max(1, page)}&returnJson=1&view=read`;
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

  async sendCompose({ linkMemberId = "", text, galleryId = "", maleProfileId = 0 }) {    const plain = String(text || "").trim();
    if (!plain) throw new Error("Letter text is empty");
    const photoId = String(galleryId || "").trim();
    const profileId = Number(maleProfileId) || 0;
    const fromLink = String(linkMemberId || "").trim();

    let composeId = "";
    if (profileId) composeId = await this.resolveComposeIdFromProfile(profileId);
    if (!composeId && fromLink) composeId = fromLink;
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
      return {
        ok: false,
        error: this.channel === "online" ? "Online already running" : "Reads already running",
        state: this.getState(),
      };
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

    const resumeFrom =
      selection.resumeFrom && typeof selection.resumeFrom === "object"
        ? selection.resumeFrom
        : null;
    const resuming = Boolean(resumeFrom);

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
          : "Starting cloud Reads…",
    });

    try {
      this.emit({ statusMessage: "Preparing Dream session…" });
      await this.ensureSession();
    } catch (error) {
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
      return { ok: false, error: msg, state: this.getState(), useLocal: true };
    }

    await this.persist(true);

    const gateKey = `${this.ownerUserId || "anon"}:${this.profileId}:${channel}`;
    if (channel === "online") {
      void withDreamGate(gateKey, () =>
        this.runOnlineLoop(token, plain, filters, photoId, delayMs),
      );
    } else {
      void withDreamGate(gateKey, () =>
        this.runLoop(token, plain, filters, photoId, delayMs, maxPages),
      );
    }

    return { ok: true, state: this.getState() };
  }

  async runLoop(token, plain, filters, photoId, delayMs, maxPages) {
    try {
      if (this.state.stopRequested || token !== this.runToken) {
        this.emit(this.idleState("Stopped"));
        await this.persist(false);
        return;
      }
      // Session already prepared in start(); refresh only if lost mid-run.
      let favorites = new Set();
      if (filters.excludeFavorites) {
        if (this.state.stopRequested || token !== this.runToken) {
          this.emit(this.idleState("Stopped"));
          await this.persist(false);
          return;
        }
        this.emit({ statusMessage: "Loading skip list…" });
        favorites = await this.fetchFavoritesIds();
        if (this.state.stopRequested || token !== this.runToken) {
          this.emit(this.idleState("Stopped"));
          await this.persist(false);
          return;
        }
        this.emit({
          ...this.setFavoritesFetched(favorites),
          statusMessage: `Skip list: ${favorites.size} (★ Favorites + already sent)`,
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

      const skipSummary = () =>
        `offline ${skipOffline}, fav ${skipFav}, dupe ${skipDupe}, bad ${skipBad}, seen ${skipSeen}`;

      while (!this.state.stopRequested && token === this.runToken) {
        await this.waitWhilePaused(token);
        if (this.state.stopRequested || token !== this.runToken) break;

        this.emit({
          page,
          statusMessage: filters.enableCycling
            ? `Cycle ${this.state.cycle} · Reads page ${page}…`
            : `Reads page ${page}…`,
        });

        let result;
        try {
          result = await this.fetchReadPage(page);
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
              failed: this.state.failed + 1,
              duplicates: (Number(this.state.duplicates) || 0) + 1,
              failedIds: this.rememberId("failed", target.maleProfileId),
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
                  failed: this.state.failed + 1,
                  duplicates: duped
                    ? (Number(this.state.duplicates) || 0) + 1
                    : this.state.duplicates,
                  lastError: retryError?.message || String(retryError),
                  failedIds: this.rememberId("failed", target.maleProfileId),
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
                failed: this.state.failed + 1,
                duplicates: duped
                  ? (Number(this.state.duplicates) || 0) + 1
                  : this.state.duplicates,
                lastError: error?.message || String(error),
                failedIds: this.rememberId("failed", target.maleProfileId),
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
          if (this.state.sent === sentAtCycleStart) {
            this.emit({
              ...this.idleState(
                `No new sends after cycle ${this.state.cycle}. Sent ${this.state.sent}, skipped ${this.state.skipped} (${skipSummary()}).`,
              ),
              ...this.keepRunStats(),
            });
            await this.persist(false);
            return false;
          }
          sentAtCycleStart = this.state.sent;
          this.seenMemberIds.clear();
          this.emit({
            cycle: this.state.cycle + 1,
            statusMessage: `Cycle ${this.state.cycle + 1} restart…`,
          });
          page = 1;
          await new Promise((r) => setTimeout(r, 3000));
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

        if (endOfPages) {
          if (filters.enableCycling) {
            const ok = await restartCycle();
            if (!ok) return;
            continue;
          }
          break;
        }

        page += 1;
        await new Promise((r) => setTimeout(r, 400));
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

  async fetchOnlineUsersPage(page) {
    const url = `${ONLINE_URL}?online=men&page=${Math.max(1, Number(page) || 1)}`;
    const response = await this.dreamFetch(url, {
      headers: {
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        Referer: `${ORIGIN}/gallery/results?online=men`,
      },
    });
    if (response.status === 401 || response.status === 403) {
      throw new Error("Dream session expired — re-save credentials");
    }
    if (response.status === 429) {
      const retryAfter = Number(response.headers.get("Retry-After") || 60);
      const err = new Error("Rate limit reached");
      err.retryMs = Math.max(5, retryAfter) * 1000;
      throw err;
    }
    if (!response.ok) throw new Error(`Online page HTTP ${response.status}`);

    // Refuse wrong targets — same guards as Chrome Online channel.
    const finalUrl = String(response.url || url);
    if (/messaging\/inbox|mode=sent|view=read|\/login/i.test(finalUrl)) {
      throw new Error(
        `Online refused redirect to ${finalUrl.slice(0, 120)} — gallery?online=men only`,
      );
    }
    if (!/gallery\/results/i.test(finalUrl) || !/online=men/i.test(finalUrl)) {
      throw new Error(
        `Online refused page ${finalUrl.slice(0, 120)} — must be gallery?online=men`,
      );
    }

    const html = await response.text();
    const raw = String(html || "");
    if (
      /"sender_pid"\s*:|"link_read"\s*:|"messages"\s*:\s*\[|mode=sent&(?:amp;)?view=read|messaging\/inbox\?mode=sent/i.test(
        raw,
      )
    ) {
      throw new Error("Online refused Reads/Inbox payload — gallery Online Users only");
    }
    if (/id=["']loginform2["']/i.test(raw) || /\/login_check/i.test(raw)) {
      throw new Error("Dream session expired — re-save credentials");
    }

    return parseOnlineUsersHtml(html);
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
        this.emit({ statusMessage: "Loading skip list…" });
        favorites = await this.fetchFavoritesIds();
        if (this.state.stopRequested || token !== this.runToken) {
          this.emit(this.idleState("Stopped"));
          await this.persist(false);
          return;
        }
        this.emit({
          ...this.setFavoritesFetched(favorites),
          statusMessage: `Skip list: ${favorites.size} (★ Favorites + already sent)`,
        });
      }

      const dupeSet = filters.checkDuplicates ? new Set(this.dupeList) : new Set();
      let page = Math.max(1, Number(this.state.page) || 1);
      // After API restore mid-cycle, avoid false "no new sends" stop on first cycle end.
      let sentAtCycleStart =
        Number(this.state.sent) > 0 ? Number(this.state.sent) - 1 : 0;
      let skipFav = 0;
      let skipDupe = 0;
      let skipSeen = 0;
      const pageSoftCap = 100;
      const gap = Math.max(200, Number(delayMs) || 1000);

      while (!this.state.stopRequested && token === this.runToken) {
        await this.waitWhilePaused(token);
        if (this.state.stopRequested || token !== this.runToken) break;

        this.emit({
          page,
          statusMessage: `Cycle ${this.state.cycle} · Online page ${page}…`,
        });

        let profileIds = [];
        try {
          profileIds = await this.fetchOnlineUsersPage(page);
        } catch (error) {
          if (error?.retryMs) {
            this.emit({
              statusMessage: `Rate limit — wait ${Math.ceil(error.retryMs / 1000)}s`,
            });
            await new Promise((r) => setTimeout(r, error.retryMs));
            continue;
          }
          throw error;
        }

        this.emit({ remaining: profileIds.length });

        for (const maleProfileId of profileIds) {
          if (this.state.stopRequested || token !== this.runToken) break;
          await this.waitWhilePaused(token);
          if (this.state.stopRequested || token !== this.runToken) break;

          if (!maleProfileId) {
            this.emit({ ...this.nextRemaining() });
            continue;
          }
          if (this.seenMemberIds.has(String(maleProfileId))) {
            this.emit({ skipped: this.state.skipped + 1, ...this.nextRemaining() });
            skipSeen += 1;
            continue;
          }
          if (filters.excludeFavorites && favorites.has(Number(maleProfileId) || 0)) {
            this.emit({
              skipped: this.state.skipped + 1,
              ...this.rememberExcludedFav(maleProfileId),
              ...this.nextRemaining(),
            });
            skipFav += 1;
            continue;
          }

          const hash = messageHash(maleProfileId, plain);
          if (filters.checkDuplicates && dupeSet.has(hash)) {
            skipDupe += 1;
            this.seenMemberIds.add(String(maleProfileId));
            this.emit({
              failed: this.state.failed + 1,
              duplicates: (Number(this.state.duplicates) || 0) + 1,
              failedIds: this.rememberId("failed", maleProfileId),
              statusMessage: `Duplicate → ${maleProfileId}`,
              lastError: "",
              ...this.nextRemaining(),
            });
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
            });
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
                });
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
                  failed: this.state.failed + 1,
                  duplicates: duped
                    ? (Number(this.state.duplicates) || 0) + 1
                    : this.state.duplicates,
                  lastError: retryError?.message || String(retryError),
                  failedIds: this.rememberId("failed", maleProfileId),
                  statusMessage: duped ? `Duplicate → ${maleProfileId}` : undefined,
                  ...this.nextRemaining(),
                });
                await this.persist(true);
              }
            } else {
              const duped = await rememberDupeFromReject(error);
              this.emit({
                failed: this.state.failed + 1,
                duplicates: duped
                  ? (Number(this.state.duplicates) || 0) + 1
                  : this.state.duplicates,
                lastError: error?.message || String(error),
                failedIds: this.rememberId("failed", maleProfileId),
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

        const restartCycle = async () => {
          if (this.state.sent === sentAtCycleStart) {
            this.emit({
              ...this.idleState(
                `No new sends after cycle ${this.state.cycle}. Sent ${this.state.sent}, skipped ${this.state.skipped} (fav ${skipFav}, dupe ${skipDupe}, seen ${skipSeen}).`,
              ),
              ...this.keepRunStats(),
              channel: "online",
              direction: "online",
            });
            return false;
          }
          sentAtCycleStart = this.state.sent;
          this.seenMemberIds.clear();
          this.emit({
            cycle: this.state.cycle + 1,
            statusMessage: `Cycle ${this.state.cycle + 1} restart…`,
          });
          page = 1;
          await new Promise((r) => setTimeout(r, 3000));
          return true;
        };

        if (!profileIds.length) {
          page += 1;
          await new Promise((r) => setTimeout(r, gap));
          if (page > pageSoftCap) {
            const ok = await restartCycle();
            if (!ok) break;
          }
          continue;
        }

        page += 1;
        await new Promise((r) => setTimeout(r, 400));
        if (page > pageSoftCap) {
          const ok = await restartCycle();
          if (!ok) break;
        }
      }

      if (token === this.runToken && this.state.running) {
        this.emit({
          ...this.idleState(this.state.stopRequested ? "Stopped" : "Online complete"),
          ...this.keepRunStats(),
          channel: "online",
          direction: "online",
        });
      }
      await this.persist(false);
    } catch (error) {
      if (token === this.runToken) {
        const msg = error?.message || String(error);
        this.emit({
          ...this.idleState(msg || "Online failed"),
          ...this.keepRunStats(),
          lastError: msg,
          channel: "online",
          direction: "online",
        });
        await this.persist(false);
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
      dupes: this.dupeList,
      resumeFrom: state,
    });
  }
}
