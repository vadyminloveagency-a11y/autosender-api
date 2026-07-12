const ORIGIN = "https://www.dream-singles.com";
const LOGIN_URL = `${ORIGIN}/login`;
const LOGIN_CHECK_URL = `${ORIGIN}/login_check`;
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

function mergeCookieJar(jar, setCookieList) {
  for (const raw of setCookieList || []) {
    const first = String(raw || "").split(";")[0] || "";
    const idx = first.indexOf("=");
    if (idx <= 0) continue;
    const name = first.slice(0, idx).trim();
    const value = first.slice(idx + 1).trim();
    if (!name) continue;
    if (value === "" || /deleted/i.test(value)) {
      jar.delete(name);
      continue;
    }
    jar.set(name, value);
  }
}

function jarToHeader(jar) {
  return [...jar.entries()].map(([n, v]) => `${n}=${v}`).join("; ");
}

function extractCsrfToken(html) {
  const match =
    String(html || "").match(/name=["']_token["'][^>]*value=["']([^"']+)["']/i) ||
    String(html || "").match(/value=["']([^"']+)["'][^>]*name=["']_token["']/i);
  return match?.[1] || "";
}

function looksLikeLoginPage(html, finalUrl) {
  const url = String(finalUrl || "").toLowerCase();
  if (/\/login(?:[/?#]|$)/i.test(url) || /\/login_check/i.test(url)) return true;
  const lower = String(html || "").toLowerCase();
  return (
    lower.includes('id="loginform2"') ||
    (lower.includes("name=\"_password\"") && lower.includes("name=\"_username\""))
  );
}

/**
 * Log in to Dream Singles with username/password.
 * Returns a Cookie header string usable for members pages / Letter Bot JWT.
 */
export async function dreamLogin(username, password) {
  const user = String(username || "").trim();
  const pass = String(password || "");
  if (!user || !pass) {
    throw new Error("Dream username and password are required");
  }

  const jar = new Map();

  const loginPage = await fetch(LOGIN_URL, {
    method: "GET",
    redirect: "follow",
    headers: {
      Accept: "text/html,application/xhtml+xml",
      "User-Agent": UA,
    },
  });
  mergeCookieJar(jar, parseSetCookieHeader(loginPage));
  const loginHtml = await loginPage.text();
  const token = extractCsrfToken(loginHtml);
  if (!token) {
    throw new Error("Could not load Dream login form (CSRF token missing)");
  }

  const body = new URLSearchParams({
    _username: user,
    _password: pass,
    _remember_me: "1",
    _token: token,
  });

  let response = await fetch(LOGIN_CHECK_URL, {
    method: "POST",
    redirect: "manual",
    headers: {
      Accept: "text/html,application/xhtml+xml",
      "Content-Type": "application/x-www-form-urlencoded",
      Cookie: jarToHeader(jar),
      Origin: ORIGIN,
      Referer: LOGIN_URL,
      "User-Agent": UA,
    },
    body: body.toString(),
  });
  mergeCookieJar(jar, parseSetCookieHeader(response));

  // Follow redirects manually so Set-Cookie jars accumulate.
  let hops = 0;
  while (
    hops < 8 &&
    [301, 302, 303, 307, 308].includes(response.status) &&
    response.headers.get("location")
  ) {
    hops += 1;
    const location = response.headers.get("location");
    const nextUrl = new URL(location, ORIGIN).toString();
    response = await fetch(nextUrl, {
      method: "GET",
      redirect: "manual",
      headers: {
        Accept: "text/html,application/xhtml+xml",
        Cookie: jarToHeader(jar),
        Referer: LOGIN_CHECK_URL,
        "User-Agent": UA,
      },
    });
    mergeCookieJar(jar, parseSetCookieHeader(response));
  }

  if ([301, 302, 303, 307, 308].includes(response.status) && response.headers.get("location")) {
    // Last hop: follow once with redirect:follow to land on members.
    const location = new URL(response.headers.get("location"), ORIGIN).toString();
    response = await fetch(location, {
      method: "GET",
      redirect: "follow",
      headers: {
        Accept: "text/html,application/xhtml+xml",
        Cookie: jarToHeader(jar),
        "User-Agent": UA,
      },
    });
    mergeCookieJar(jar, parseSetCookieHeader(response));
  }

  const finalUrl = String(response.url || "");
  const html = await response.text().catch(() => "");
  const cookieHeader = jarToHeader(jar);

  if (!cookieHeader) {
    throw new Error("Dream login failed — no session cookies returned");
  }

  if (looksLikeLoginPage(html, finalUrl) || response.status === 401 || response.status === 403) {
    throw new Error("Dream login failed — check username/password");
  }

  // Soft check: members area usually has PHPSESSID + remember_me / auth cookies.
  const hasSession =
    jar.has("PHPSESSID") ||
    [...jar.keys()].some((name) => /remember|auth|sess/i.test(name));
  if (!hasSession && /sign\s*in|invalid|incorrect|bad credentials/i.test(html)) {
    throw new Error("Dream login failed — check username/password");
  }

  return { cookieHeader, cookies: Object.fromEntries(jar) };
}
