import { ProxyAgent, fetch as undiciFetch } from "undici";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

let proxyAgent = null;
let proxyUrlCached = null;

function getProxyUrl() {
  return String(
    process.env.DREAM_PROXY_URL ||
      process.env.HTTPS_PROXY ||
      process.env.HTTP_PROXY ||
      "",
  ).trim();
}

function getDispatcher() {
  const url = getProxyUrl();
  if (!url) return undefined;
  if (url !== proxyUrlCached) {
    proxyUrlCached = url;
    proxyAgent = new ProxyAgent(url);
  }
  return proxyAgent;
}

export function hasDreamProxy() {
  return Boolean(getProxyUrl());
}

/**
 * Fetch Dream Singles through optional residential proxy (DREAM_PROXY_URL).
 * Datacenter IPs (Hetzner) hit reCAPTCHA on login — proxy fixes cloud Reads/LetterBot re-login.
 */
export async function dreamHttp(url, options = {}) {
  const headers = {
    "User-Agent": UA,
    ...(options.headers || {}),
  };
  const init = {
    method: options.method || "GET",
    headers,
    body: options.body,
    redirect: options.redirect || "follow",
    signal: options.signal || AbortSignal.timeout(options.timeoutMs || 45000),
  };
  const dispatcher = getDispatcher();
  if (dispatcher) init.dispatcher = dispatcher;
  return undiciFetch(url, init);
}
