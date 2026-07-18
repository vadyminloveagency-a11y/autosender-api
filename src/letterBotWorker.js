import WebSocket from "ws";
import { withDreamGate } from "./dreamGate.js";
import { dreamLogin } from "./dreamLogin.js";
import { dreamDayKey } from "./dreamDay.js";
import { bumpMailingDailyLetters, setMailingDailyLettersAbsolute } from "./mailingDailyStore.js";

const ORIGIN = "https://www.dream-singles.com";
const BOT_SEND_URL = `${ORIGIN}/members/messaging/bot/send`;
const WS_URL = "wss://ws.dream-singles.com/ws";
const STALL_MS = 2 * 60_000;

const CATEGORY_KEYS = [
  "onlineOnly",
  "admirers",
  "contacts",
  "newGuys",
  "lastActive",
  "profileViewers",
  "whiteListed",
  "interestedMen",
];
const FIRST_START_KEYS = [
  "onlineOnly",
  "admirers",
  "contacts",
  "profileViewers",
  "whiteListed",
  "interestedMen",
];
const MAILING_247_KEYS = ["onlineOnly", "newGuys", "lastActive"];

const WS_FILTER_VALUE = {
  onlineOnly: "onlineOnly",
  admirers: "admirers",
  contacts: "contacts",
  newGuys: "newGuys",
  lastActive: "lastActivity",
  profileViewers: "profileViewers",
  whiteListed: "whiteListed",
  interestedMen: "interestedMen",
};

const DEFAULT_CRITERIA = {
  age_from: "0",
  age_to: "0",
  block: "on",
  country_id: "0",
  education: "0",
  eyes: "0",
  hair: "0",
  height_from: "0",
  height_to: "0",
  ignore: "on",
  kids: "-1",
  last_activity: "0",
  marital_status: "0",
  religion: "0",
  smoking: "0",
  weight_from: "0",
  weight_to: "0",
};

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function decodeJwtExpMs(token) {
  try {
    const part = String(token || "").split(".")[1];
    if (!part) return 0;
    const json = Buffer.from(part.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
    const payload = JSON.parse(json);
    return Number(payload.exp) > 0 ? Number(payload.exp) * 1000 : 0;
  } catch {
    return 0;
  }
}

class LetterBotWorker {
  constructor(profileId, { onStateChange, onPersist, ownerUserId, credentialsProvider } = {}) {
    this.profileId = String(profileId || "default");
    this.ownerUserId = ownerUserId != null ? Number(ownerUserId) : null;
    this.onStateChange = onStateChange || null;
    this.onPersist = onPersist || null;
    this.credentialsProvider = credentialsProvider || null;
    this.reloginInFlight = null;
    this.cookieHeader = "";
    this.socket = null;
    this.connectPromise = null;
    this.jwtCache = { token: "", expMs: 0 };
    this.heartbeatTimer = null;
    this.keepAliveTimer = null;
    this.cycleTimer = null;
    this.reconnectTimer = null;
    this.closingIntentionally = false;
    this.senderRunning = false;
    this.senderPaused = false;
    this.categoryIndex = 0;
    this.firstStartIndex = 0;
    this.mailing247Index = 0;
    this.onlineStage = "online";
    this.userSelection = {};
    this.lastProgressAt = 0;
    this.lastSendStartedAt = 0;
    this.recoveringStall = false;
    this.initWaiters = [];
    this.state = {
      connected: false,
      authenticating: false,
      sending: false,
      buttonLabel: "Start",
      filter: "onlineOnly",
      progress: null,
      previewHtml: "",
      previewText: "",
      previewPhoto: "",
      previewVideo: "",
      previewVideoPoster: "",
      error: "",
      statusMessage: "LetterBot closed",
      sessionActive: false,
      isPaused: false,
      updatedAt: 0,
      profileId: this.profileId,
      daySent: 0,
      sendDayKey: "",
      dailyTotal: null,
      dailyTotalAt: 0,
      dailyTotalDayKey: "",
    };
  }

  getState() {
    return { ...this.state };
  }

  normalizeDailyTotalValue(value) {
    const match = String(value || "").replace(/\s+/g, "").match(/([\d,]+)/);
    return match ? match[1] : "";
  }

  extractDailyTotalFromBotHtml(html) {
    const raw = String(html || "");
    if (!raw) return null;
    const patterns = [
      /Daily\s*Total\s*<\/t[hd]>\s*<t[hd][^>]*>\s*([\d,\s]+)/i,
      /Daily\s*Total\s*:?\s*(?:<[^>]+>\s*){0,8}([\d]{1,3}(?:,\d{3})+|\d+)/i,
      /Total\s*Day\s*:?\s*(?:<[^>]+>\s*){0,8}([\d]{1,3}(?:,\d{3})+|\d+)/i,
      /TOTAL\s*DAY\s*:?\s*(?:<[^>]+>\s*){0,8}([\d]{1,3}(?:,\d{3})+|\d+)/i,
      /id=["']dailyTotal["'][^>]*>\s*([\d,\s]+)/i,
      /["']dailyTotal["']\s*[:=]\s*["']?([\d,]+)/i,
      /Daily\s*Total\s*:?\s*([\d,\s]+)/i,
      /Today's\s*Total\s*:?\s*([\d,\s]+)/i,
    ];
    const found = [];
    for (const pattern of patterns) {
      const match = raw.match(pattern);
      if (match?.[1]) {
        const normalized = this.normalizeDailyTotalValue(match[1]);
        if (normalized) found.push(normalized);
      }
    }
    const plain = raw
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/gi, " ")
      .replace(/\s+/g, " ");
    const plainMatch = plain.match(
      /(?:Daily\s*Total|Total\s*Day|TOTAL\s*DAY|Today's\s*Total)\s*:?\s*([\d,]+)/i,
    );
    if (plainMatch?.[1]) {
      const normalized = this.normalizeDailyTotalValue(plainMatch[1]);
      if (normalized) found.push(normalized);
    }
    // Prefer the largest plausible Dream day total (ignore tiny false matches).
    let best = null;
    let bestNum = -1;
    for (const value of found) {
      const num = Number(String(value).replace(/,/g, ""));
      if (!Number.isFinite(num) || num < 0) continue;
      if (num >= bestNum) {
        bestNum = num;
        best = value;
      }
    }
    return best;
  }

  async scrapeDailyTotalFromDreamPages() {
    if (!this.cookieHeader) return null;
    const urls = [
      `${ORIGIN}/members/messaging/bot/send`,
      `${ORIGIN}/members/messaging/bot/`,
      `${ORIGIN}/members/`,
    ];
    let best = null;
    let bestNum = -1;
    for (const url of urls) {
      try {
        const response = await fetch(url, {
          method: "GET",
          redirect: "follow",
          signal: AbortSignal.timeout(20000),
          headers: {
            Accept: "text/html,application/xhtml+xml",
            Cookie: this.cookieHeader,
            Referer: BOT_SEND_URL,
            "User-Agent":
              "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
          },
        });
        this.mergeSetCookies(response);
        if (!response.ok) continue;
        const value = this.extractDailyTotalFromBotHtml(await response.text());
        const num = Number(String(value || "").replace(/,/g, ""));
        if (!Number.isFinite(num) || num < 0) continue;
        if (num >= bestNum) {
          bestNum = num;
          best = value;
        }
      } catch (_) {}
    }
    return best;
  }

  applyDailyTotal(raw) {
    const normalized = this.normalizeDailyTotalValue(raw);
    if (!normalized) return false;
    const num = Number(normalized.replace(/,/g, ""));
    // Never persist 0 — a failed scrape must not wipe a real TOTAL DAY.
    if (!Number.isFinite(num) || num <= 0) return false;
    const day = this.kyivDayKey();
    if (this.state.dailyTotalDayKey !== day) {
      this.state.dailyTotalDayKey = day;
    } else {
      const prev = Number(this.state.dailyTotal);
      // Mid-day Dream total should not drop; ignore small parse regressions.
      if (Number.isFinite(prev) && num < prev && prev - num < 200) return false;
    }
    const changed = this.state.dailyTotal !== num;
    this.state.dailyTotal = num;
    this.state.dailyTotalAt = Date.now();
    // Persist Dream TOTAL DAY so director LetterBot / Letters today match Dream.
    void setMailingDailyLettersAbsolute({
      dayKey: day,
      profileId: this.profileId,
      product: "letterbot",
      userId: this.ownerUserId,
      letters: num,
    }).catch(() => {});
    return changed;
  }

  kyivDayKey(date = new Date()) {
    return dreamDayKey(date);
  }

  bumpDaySent(prevSent, nextSent) {
    const day = this.kyivDayKey();
    if (this.state.sendDayKey !== day) {
      this.state.sendDayKey = day;
      this.state.daySent = 0;
    }
    const prev = Number(prevSent);
    const next = Number(nextSent);
    if (!Number.isFinite(next) || next < 0) return;
    let delta = 0;
    // Only count positive deltas of real bot sends — never re-add full counters on reconnect.
    if (Number.isFinite(prev) && next > prev) {
      delta = next - prev;
    } else if (!Number.isFinite(prev) && next > 0 && next <= 5) {
      // First tick of a new run (no previous progress): count only a small initial step.
      delta = next;
    }
    if (delta <= 0) return;
    this.state.daySent = (Number(this.state.daySent) || 0) + delta;
    // Keep AutoSender day count as fallback; Dream TOTAL DAY overwrites when available (GREATEST).
    void bumpMailingDailyLetters({
      dayKey: day,
      profileId: this.profileId,
      product: "letterbot",
      userId: this.ownerUserId,
      delta,
    }).catch(() => {});
  }

  setCookieHeader(cookieHeader) {
    this.cookieHeader = String(cookieHeader || "").trim();
    // Keep existing JWT if cookies refresh without wiping a good token.
  }

  setDreamJwt(token) {
    const value = String(token || "").trim();
    if (!value) return;
    this.jwtCache = {
      token: value,
      expMs: decodeJwtExpMs(value) || Date.now() + 8 * 60 * 1000,
    };
  }

  setCredentialsProvider(fn) {
    this.credentialsProvider = typeof fn === "function" ? fn : null;
  }

  async reloginFromCredentials() {
    if (this.reloginInFlight) return this.reloginInFlight;
    this.reloginInFlight = (async () => {
      if (typeof this.credentialsProvider !== "function") {
        throw new Error(
          "Dream session expired — save Dream login/password in AutoSender LetterBot",
        );
      }
      const creds = await this.credentialsProvider();
      if (!creds?.username || !creds?.password) {
        throw new Error(
          "Dream session expired — save Dream login/password in AutoSender LetterBot",
        );
      }
      this.state.statusMessage = "Re-login to Dream...";
      this.emitState();
      const { cookieHeader } = await dreamLogin(creds.username, creds.password);
      this.setCookieHeader(cookieHeader);
      this.jwtCache = { token: "", expMs: 0 };
      this.state.error = "";
      this.state.statusMessage = this.state.sessionActive
        ? this.state.statusMessage || "Dream session restored"
        : "Dream session restored";
      this.emitState();
      return cookieHeader;
    })();
    try {
      return await this.reloginInFlight;
    } finally {
      this.reloginInFlight = null;
    }
  }

  emitState() {
    this.state.updatedAt = Date.now();
    this.state.profileId = this.profileId;
    if (typeof this.onStateChange === "function") {
      this.onStateChange(this.getState());
    }
    if (typeof this.onPersist === "function") {
      void this.onPersist({
        userId: this.ownerUserId,
        profileId: this.profileId,
        cookieHeader: this.cookieHeader,
        selection: this.userSelection,
        state: this.getState(),
        isRunning: Boolean(this.senderRunning && this.state.sessionActive),
      }).catch(() => {});
    }
  }

  setError(message) {
    this.state.error = String(message || "");
    this.emitState();
  }

  buildCriteria(categoryKey) {
    const group = WS_FILTER_VALUE[categoryKey] || categoryKey || "onlineOnly";
    return {
      ...DEFAULT_CRITERIA,
      gentlemenGroup: group,
      last_activity: group === "lastActivity" ? "Within the last week" : "0",
    };
  }

  applyPreviewFromInit(preview) {
    if (!preview || typeof preview !== "object") return;
    if (preview.message) {
      this.state.previewHtml = String(preview.message || "");
      this.state.previewText = this.state.previewHtml.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    }
    this.state.previewPhoto = String(preview.attachment || "");
    this.state.previewVideo = String(preview.video_attachment || "");
    this.state.previewVideoPoster = String(preview.video_attachment_preview || "");
  }

  mergeSetCookies(response) {
    try {
      const list =
        typeof response.headers.getSetCookie === "function"
          ? response.headers.getSetCookie()
          : [];
      if (!list?.length) return;
      const map = new Map();
      for (const part of String(this.cookieHeader || "").split(";")) {
        const idx = part.indexOf("=");
        if (idx <= 0) continue;
        const name = part.slice(0, idx).trim();
        const value = part.slice(idx + 1).trim();
        if (name) map.set(name, value);
      }
      for (const raw of list) {
        const first = String(raw || "").split(";")[0] || "";
        const idx = first.indexOf("=");
        if (idx <= 0) continue;
        const name = first.slice(0, idx).trim();
        const value = first.slice(idx + 1).trim();
        if (name) map.set(name, value);
      }
      this.cookieHeader = [...map.entries()].map(([n, v]) => `${n}=${v}`).join("; ");
    } catch (_) {}
  }

  async fetchLetterBotJwt(force = false, { allowRelogin = true } = {}) {
    const now = Date.now();
    if (!force && this.jwtCache.token && this.jwtCache.expMs - 45_000 > now) {
      return this.jwtCache.token;
    }
    if (!this.cookieHeader) {
      if (this.jwtCache.token && this.jwtCache.expMs > now) return this.jwtCache.token;
      if (allowRelogin && this.credentialsProvider) {
        await this.reloginFromCredentials();
        return this.fetchLetterBotJwt(true, { allowRelogin: false });
      }
      throw new Error(
        "Dream session missing — save Dream login in AutoSender, or open dream-singles.com logged in",
      );
    }

    const gateKey = `${this.ownerUserId || "anon"}:${this.profileId || "default"}`;
    return withDreamGate(gateKey, () => this.fetchLetterBotJwtUngated(force, { allowRelogin }));
  }

  async fetchLetterBotJwtUngated(force = false, { allowRelogin = true } = {}) {
    const now = Date.now();
    if (!force && this.jwtCache.token && this.jwtCache.expMs - 45_000 > now) {
      return this.jwtCache.token;
    }
    if (!this.cookieHeader) {
      if (this.jwtCache.token && this.jwtCache.expMs > now) return this.jwtCache.token;
      if (allowRelogin && this.credentialsProvider) {
        await this.reloginFromCredentials();
        return this.fetchLetterBotJwtUngated(true, { allowRelogin: false });
      }
      throw new Error(
        "Dream session missing — save Dream login in AutoSender, or open dream-singles.com logged in",
      );
    }

    const response = await fetch(BOT_SEND_URL, {
      method: "GET",
      redirect: "follow",
      signal: AbortSignal.timeout(20000),
      headers: {
        Accept: "text/html,application/xhtml+xml",
        Cookie: this.cookieHeader,
        Referer: `${ORIGIN}/members/messaging/bot/send`,
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      },
    });
    this.mergeSetCookies(response);
    if (response.status === 401 || response.status === 403) {
      if (allowRelogin && this.credentialsProvider) {
        await this.reloginFromCredentials();
        return this.fetchLetterBotJwtUngated(true, { allowRelogin: false });
      }
      throw new Error(
        "Dream session expired — update Dream password in AutoSender LetterBot",
      );
    }
    if (!response.ok) throw new Error(`Could not load Letter Bot page (${response.status})`);
    const html = await response.text();
    let dailyFromPage = this.extractDailyTotalFromBotHtml(html);
    if (!dailyFromPage) {
      dailyFromPage = await this.scrapeDailyTotalFromDreamPages();
    }
    if (this.applyDailyTotal(dailyFromPage)) {
      this.emitState();
    }
    const match =
      html.match(/const\s+jwtKey\s*=\s*['"]([^'"]+)['"]/) ||
      html.match(/jwtKey\s*=\s*['"]([^'"]+)['"]/) ||
      html.match(/"jwt"\s*:\s*"([^"]+)"/);
    if (!match?.[1]) {
      if (this.jwtCache.token && this.jwtCache.expMs > now) return this.jwtCache.token;
      if (allowRelogin && this.credentialsProvider) {
        await this.reloginFromCredentials();
        return this.fetchLetterBotJwtUngated(true, { allowRelogin: false });
      }
      throw new Error(
        "Letter Bot JWT not found — update Dream password in AutoSender LetterBot",
      );
    }
    const token = match[1];
    this.jwtCache = { token, expMs: decodeJwtExpMs(token) || now + 8 * 60 * 1000 };
    return token;
  }

  clearKeepAlive() {
    if (this.keepAliveTimer) {
      clearInterval(this.keepAliveTimer);
      this.keepAliveTimer = null;
    }
  }

  startKeepAlive() {
    this.clearKeepAlive();
    // Refresh JWT from cookies; on failure re-login with stored Dream credentials.
    this.keepAliveTimer = setInterval(() => {
      if (!this.senderRunning && !this.state.sessionActive) return;
      void this.fetchLetterBotJwt(true, { allowRelogin: true })
        .then(() => {
          if (this.state.error && /session|jwt|password|login/i.test(this.state.error)) {
            this.state.error = "";
            this.emitState();
          }
        })
        .catch((error) => {
          this.state.error = error?.message || String(error);
          this.state.statusMessage = "Dream session refresh failed — update password in AutoSender";
          this.emitState();
        });
    }, 2 * 60_000);
  }

  clearHeartbeat() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  startHeartbeat() {
    this.clearHeartbeat();
    this.startKeepAlive();
    this.heartbeatTimer = setInterval(() => {
      if (this.socket?.readyState === WebSocket.OPEN) {
        try {
          this.socket.send(JSON.stringify({ type: "botHeartbeat" }));
        } catch (_) {}
      } else if (this.senderRunning || this.state.sessionActive) {
        this.scheduleReconnect("heartbeat: socket down");
      }
      if (this.jwtCache.token && this.jwtCache.expMs - 60_000 < Date.now()) {
        void this.fetchLetterBotJwt(true).catch(() => {});
      }
    }, 60_000);
  }

  handleSocketMessage(raw) {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    switch (msg.type) {
      case "auth-response":
        this.state.authenticating = false;
        if (msg.success) {
          this.state.connected = true;
          this.state.error = "";
          if (!this.state.sessionActive) this.state.statusMessage = "Connected";
          this.startHeartbeat();
          try {
            this.socket.send(JSON.stringify({ type: "bot-start-init" }));
          } catch (_) {}
        } else {
          this.state.connected = false;
          this.state.error = msg.error || msg.message || "WebSocket auth failed";
          this.state.statusMessage = "Auth failed";
        }
        this.emitState();
        break;

      case "bot-start-init-response": {
        this.applyPreviewFromInit(msg.preview);
        this.state.sending = msg.isSending === 1 || msg.isSending === true || Boolean(msg.isSending);
        this.state.buttonLabel = this.state.sending ? "Stop" : "Start";
        if (msg.error === 1) {
          this.state.error = msg.message || "Letter Bot init error";
          if (!this.state.sessionActive) this.state.statusMessage = msg.message || "Init error";
        } else {
          this.state.error = "";
          if (!this.state.sessionActive) this.state.statusMessage = msg.message || "Ready";
        }
        const waiters = this.initWaiters.splice(0, this.initWaiters.length);
        waiters.forEach((resolve) => resolve(msg));
        this.emitState();
        break;
      }

      case "bot-send-response": {
        if (msg.error === 1) {
          this.state.sending = false;
          this.state.buttonLabel = "Start";
          this.state.progress = null;
          this.state.error = msg.message || "Send failed";
          this.state.statusMessage = msg.message || "Send failed";
          this.lastProgressAt = Date.now();
          this.emitState();
          break;
        }
        this.state.error = "";
        this.state.sending = msg.isSending === 1 || msg.isSending === true || Boolean(msg.isSending);
        const prev = this.state.progress || {};
        const percentRaw = msg.percent ?? msg.completePercent ?? msg.progress;
        const percentNum = Number(percentRaw);
        const nextSent = msg.sent ?? prev.sent ?? null;
        this.bumpDaySent(prev.sent, nextSent);
        this.applyDailyTotal(
          msg.dailyTotal ?? msg.daily_total ?? msg.totalDay ?? msg.total_day ?? null,
        );
        this.state.progress = {
          to: msg.to ?? prev.to ?? null,
          total: msg.total ?? prev.total ?? null,
          filter: msg.filter ?? prev.filter ?? null,
          percent: Number.isFinite(percentNum) ? percentNum : Number(prev.percent) || 0,
          sent: nextSent,
          complete: Boolean(msg.complete),
          recipients: Array.isArray(msg.recipients) ? msg.recipients : prev.recipients || [],
        };
        this.lastProgressAt = Date.now();
        this.state.buttonLabel = this.state.progress.complete
          ? "Start"
          : this.state.sending
            ? "Stop"
            : "Start";
        if (msg.filter) this.state.filter = String(msg.filter);
        if (this.state.sessionActive && !this.state.isPaused) {
          this.state.statusMessage = "";
        }
        if (this.state.progress.complete) this.state.sending = false;
        this.emitState();
        break;
      }

      case "bot-restarted":
        try {
          this.socket.send(JSON.stringify({ type: "bot-start-init" }));
        } catch (_) {}
        break;

      default:
        break;
    }
  }

  closeSocket() {
    this.clearHeartbeat();
    const ws = this.socket;
    this.socket = null;
    this.connectPromise = null;
    this.state.connected = false;
    this.state.authenticating = false;
    if (!ws) {
      this.closingIntentionally = false;
      return;
    }
    this.closingIntentionally = true;
    try {
      ws.close();
    } catch (_) {}
    setTimeout(() => {
      this.closingIntentionally = false;
    }, 50);
  }

  scheduleReconnect(reason = "socket closed") {
    if (this.reconnectTimer) return;
    if (!this.senderRunning && !this.state.sessionActive) return;
    this.state.connected = false;
    this.state.statusMessage = `Reconnecting... ${reason}`;
    this.emitState();
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.ensureConnected(true)
        .then(() => {
          if (this.socket?.readyState === WebSocket.OPEN) {
            this.socket.send(JSON.stringify({ type: "bot-start-init" }));
          }
          this.ensureCycleTimer();
        })
        .catch((error) => this.scheduleReconnect(error?.message || "retry"));
    }, 2000);
  }

  async ensureConnected(forceJwt = false) {
    if (this.socket?.readyState === WebSocket.OPEN && this.state.connected) return true;
    if (this.connectPromise) return this.connectPromise;

    this.connectPromise = (async () => {
      this.closeSocket();
      this.state.authenticating = true;
      this.state.statusMessage = this.state.sessionActive ? this.state.statusMessage : "Connecting...";
      this.state.error = "";
      this.emitState();

      const token = await this.fetchLetterBotJwt(forceJwt);

      await new Promise((resolve, reject) => {
        let settled = false;
        const ws = new WebSocket(WS_URL, {
          headers: {
            Origin: ORIGIN,
            "User-Agent":
              "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
          },
        });
        this.socket = ws;
        const fail = (err) => {
          if (settled) return;
          settled = true;
          this.closeSocket();
          reject(err instanceof Error ? err : new Error(String(err || "WebSocket failed")));
        };
        const ok = () => {
          if (settled) return;
          settled = true;
          resolve();
        };
        const timer = setTimeout(() => fail(new Error("WebSocket timeout")), 15000);

        ws.on("open", () => {
          ws.send(
            JSON.stringify({
              type: "auth",
              connection: "letterBot",
              subscribe_to: [
                "auth-response",
                "bot-send-response",
                "bot-start-init-response",
                "bot-restarted",
              ],
              payload: token,
            }),
          );
        });

        ws.on("message", (data) => {
          const text = Buffer.isBuffer(data) ? data.toString("utf8") : String(data);
          this.handleSocketMessage(text);
          try {
            const msg = JSON.parse(text);
            if (msg.type === "auth-response") {
              clearTimeout(timer);
              if (msg.success) ok();
              else fail(new Error(msg.error || msg.message || "Auth failed"));
            }
          } catch (_) {}
        });

        ws.on("error", () => fail(new Error("WebSocket connection error")));
        ws.on("close", () => {
          this.state.connected = false;
          if (!settled) {
            fail(new Error("WebSocket closed"));
            return;
          }
          this.emitState();
          if (!this.closingIntentionally && (this.senderRunning || this.state.sessionActive)) {
            this.scheduleReconnect("socket closed");
          }
        });
      });

      return true;
    })();

    try {
      return await this.connectPromise;
    } finally {
      this.connectPromise = null;
    }
  }

  getSelectedCategories(selection) {
    return CATEGORY_KEYS.filter((key) => Boolean(selection?.[key]));
  }

  clearCycleTimer() {
    if (this.cycleTimer) {
      clearInterval(this.cycleTimer);
      this.cycleTimer = null;
    }
  }

  ensureCycleTimer() {
    if (!this.senderRunning || this.senderPaused) return;
    if (!this.cycleTimer) {
      this.cycleTimer = setInterval(() => {
        void this.runWatchdog();
      }, 10000);
    }
  }

  requestBotInit(timeoutMs = 8000) {
    return new Promise((resolve, reject) => {
      if (this.socket?.readyState !== WebSocket.OPEN) {
        reject(new Error("Not connected"));
        return;
      }
      const timer = setTimeout(() => {
        this.initWaiters = this.initWaiters.filter((item) => item !== onInit);
        reject(new Error("bot-start-init timeout"));
      }, timeoutMs);
      const onInit = (msg) => {
        clearTimeout(timer);
        resolve(msg);
      };
      this.initWaiters.push(onInit);
      try {
        this.socket.send(JSON.stringify({ type: "bot-start-init" }));
      } catch (error) {
        clearTimeout(timer);
        this.initWaiters = this.initWaiters.filter((item) => item !== onInit);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  currentFilterKey() {
    const selection = this.userSelection || {};
    if (selection.firstStart) {
      return FIRST_START_KEYS[this.firstStartIndex] || this.state.filter || "onlineOnly";
    }
    if (selection.totalOnline) {
      return this.onlineStage === "lastActive" ? "lastActive" : "onlineOnly";
    }
    if (selection.mailing247) {
      const idx = Math.max(0, this.mailing247Index - 1);
      return MAILING_247_KEYS[idx % MAILING_247_KEYS.length] || this.state.filter || "onlineOnly";
    }
    const selected = this.getSelectedCategories(selection);
    if (selected.length) {
      const idx = Math.max(0, this.categoryIndex - 1);
      return selected[idx % selected.length] || this.state.filter || "onlineOnly";
    }
    return this.state.filter || "onlineOnly";
  }

  async wsStartFilter(categoryKey) {
    await this.ensureConnected(false);
    if (this.socket?.readyState !== WebSocket.OPEN) throw new Error("Not connected");

    if (this.state.sending) {
      this.socket.send(JSON.stringify({ type: "bot-stop-send" }));
      await delay(250);
    }

    this.state.filter = categoryKey;
    this.state.buttonLabel = "Searching";
    this.state.statusMessage = "";
    this.state.error = "";
    this.state.sending = true;
    this.state.progress = null;
    this.lastSendStartedAt = Date.now();
    this.lastProgressAt = Date.now();
    this.emitState();

    this.socket.send(
      JSON.stringify({
        type: "bot-start-send",
        criteria: this.buildCriteria(categoryKey),
      }),
    );
  }

  async wsStopSend() {
    if (this.socket?.readyState === WebSocket.OPEN) {
      try {
        this.socket.send(JSON.stringify({ type: "bot-stop-send" }));
      } catch (_) {}
    }
    this.state.sending = false;
    this.state.buttonLabel = "Start";
    this.emitState();
  }

  async recoverIfStalled(reason = "no progress") {
    if (!this.senderRunning || this.senderPaused || this.recoveringStall) return false;
    const anchor = Math.max(this.lastProgressAt || 0, this.lastSendStartedAt || 0);
    if (!anchor || Date.now() - anchor < STALL_MS) return false;

    this.recoveringStall = true;
    this.state.statusMessage = `Recovering... (${reason})`;
    this.state.error = "";
    this.emitState();

    try {
      await this.ensureConnected(true);
      let initMsg = null;
      try {
        initMsg = await this.requestBotInit();
      } catch {
        initMsg = null;
      }
      const serverSending = Boolean(
        initMsg
          ? initMsg.isSending === 1 || initMsg.isSending === true || Boolean(initMsg.isSending)
          : this.state.sending,
      );
      const filter = this.currentFilterKey();
      if (serverSending || this.state.sending || (this.state.progress && !this.state.progress.complete)) {
        this.state.sending = false;
        this.state.statusMessage = `Restarting ${filter}...`;
        this.emitState();
        await this.wsStartFilter(filter);
        this.lastProgressAt = Date.now();
        this.lastSendStartedAt = Date.now();
        return true;
      }
      this.state.sending = false;
      if (this.state.progress && !this.state.progress.complete) {
        this.state.progress = { ...this.state.progress, complete: true };
      }
      this.lastProgressAt = Date.now();
      this.emitState();
      await this.runSenderCycle();
      return true;
    } catch (error) {
      this.setError(error?.message || String(error));
      this.scheduleReconnect(error?.message || "stall recovery failed");
      return false;
    } finally {
      this.recoveringStall = false;
    }
  }

  async runSenderCycle() {
    if (!this.senderRunning || this.senderPaused) return;
    const selection = this.userSelection || {};

    const resumeOrStart = async (startNext) => {
      if (this.state.sending) return;
      // Dream often stops mid-filter without complete=true — that used to deadlock the cycle.
      if (this.state.progress && !this.state.progress.complete) {
        const filter = this.state.filter || this.currentFilterKey();
        await this.wsStartFilter(filter);
        return;
      }
      await startNext();
    };

    try {
      if (selection.firstStart) {
        if (this.firstStartIndex >= FIRST_START_KEYS.length) {
          await this.stop({ complete: true });
          return;
        }
        await resumeOrStart(async () => {
          if (this.state.progress?.complete) {
            this.firstStartIndex += 1;
            this.state.progress = null;
            if (this.firstStartIndex >= FIRST_START_KEYS.length) {
              await this.stop({ complete: true });
              return;
            }
          }
          await this.wsStartFilter(FIRST_START_KEYS[this.firstStartIndex]);
        });
        return;
      }

      if (selection.totalOnline) {
        await resumeOrStart(async () => {
          if (this.onlineStage === "online") {
            await this.wsStartFilter("onlineOnly");
            this.onlineStage = "lastActive";
          } else {
            await this.wsStartFilter("lastActive");
            this.onlineStage = "online";
          }
        });
        return;
      }

      if (selection.mailing247) {
        await resumeOrStart(async () => {
          const key = MAILING_247_KEYS[this.mailing247Index % MAILING_247_KEYS.length];
          this.mailing247Index += 1;
          await this.wsStartFilter(key);
        });
        return;
      }

      const selected = this.getSelectedCategories(selection);
      if (!selected.length) return;
      await resumeOrStart(async () => {
        const key = selected[this.categoryIndex % selected.length];
        this.categoryIndex += 1;
        await this.wsStartFilter(key);
      });
    } catch (error) {
      this.setError(error?.message || String(error));
    }
  }

  async runWatchdog() {
    if (!this.senderRunning || this.senderPaused) return;
    if (this.socket?.readyState !== WebSocket.OPEN) {
      this.scheduleReconnect("watchdog: socket down");
      return;
    }
    const recovered = await this.recoverIfStalled("progress stalled");
    if (!recovered) await this.runSenderCycle();
  }

  async start(selection) {
    this.userSelection = selection || {};
    const hasMode =
      Boolean(this.userSelection.firstStart) ||
      Boolean(this.userSelection.totalOnline) ||
      Boolean(this.userSelection.mailing247) ||
      this.getSelectedCategories(this.userSelection).length > 0;
    if (!hasMode) {
      throw new Error("Select First Start, Online+Last Active, 24/7, or at least one filter");
    }

    this.senderRunning = true;
    this.senderPaused = false;
    this.categoryIndex = 0;
    this.firstStartIndex = 0;
    this.mailing247Index = 0;
    this.onlineStage = "online";
    this.state.sessionActive = true;
    this.state.isPaused = false;
    this.state.sending = false;
    this.state.progress = null;
    this.state.filter = "onlineOnly";
    this.state.buttonLabel = "Start";
    this.state.statusMessage = "Starting...";
    this.state.error = "";
    this.lastProgressAt = Date.now();
    this.lastSendStartedAt = Date.now();
    this.emitState();
    await this.ensureConnected(true);
    await this.runSenderCycle();
    this.clearCycleTimer();
    this.ensureCycleTimer();
    return this.getState();
  }

  async pause() {
    if (!this.senderRunning || this.senderPaused) return this.getState();
    this.senderPaused = true;
    this.state.isPaused = true;
    this.state.statusMessage = "Paused";
    this.clearCycleTimer();
    await this.wsStopSend();
    this.emitState();
    return this.getState();
  }

  async resume() {
    if (!this.senderRunning || !this.senderPaused) return this.getState();
    this.senderPaused = false;
    this.state.isPaused = false;
    this.state.statusMessage = "";
    this.lastProgressAt = Date.now();
    this.emitState();
    this.clearCycleTimer();
    this.ensureCycleTimer();
    await this.runSenderCycle();
    return this.getState();
  }

  async stop({ complete = false } = {}) {
    this.senderRunning = false;
    this.senderPaused = false;
    this.clearCycleTimer();
    this.clearKeepAlive();
    await this.wsStopSend();
    this.state.sessionActive = false;
    this.state.isPaused = false;
    this.state.sending = false;
    this.state.progress = null;
    this.state.statusMessage = complete ? "First Start complete" : "Stopped";
    this.state.buttonLabel = "Start";
    this.emitState();
    return this.getState();
  }

  stopSync() {
    this.senderRunning = false;
    this.senderPaused = false;
    this.clearCycleTimer();
    if (this.socket?.readyState === WebSocket.OPEN) {
      try {
        this.socket.send(JSON.stringify({ type: "bot-stop-send" }));
      } catch (_) {}
    }
    this.state.sending = false;
    this.state.sessionActive = false;
    this.state.isPaused = false;
    this.state.statusMessage = "Stopped";
    this.emitState();
  }

  applyPreview(preview) {
    this.applyPreviewFromInit(preview);
    this.emitState();
  }

  async connect() {
    await this.ensureConnected(true);
    return this.getState();
  }
}

export { LetterBotWorker };




