/**
 * 2captcha.com solver for Dream Singles reCAPTCHA (v2/v3).
 * Env: TWOCAPTCHA_API_KEY
 */
const IN_URL = "https://2captcha.com/in.php";
const RES_URL = "https://2captcha.com/res.php";

export function hasTwoCaptcha() {
  return Boolean(String(process.env.TWOCAPTCHA_API_KEY || "").trim());
}

function getApiKey() {
  return String(process.env.TWOCAPTCHA_API_KEY || "").trim();
}

export function extractRecaptchaMeta(html) {
  const text = String(html || "");
  const sitekey =
    (text.match(/data-sitekey=["']([^"']+)["']/i) || [])[1] ||
    (text.match(/sitekey["']\s*:\s*["']([^"']+)["']/i) || [])[1] ||
    (text.match(/grecaptcha\.execute\(\s*["']([^"']+)["']/i) || [])[1] ||
    (text.match(/recaptcha\/api\.js\?render=([^\s"'&]+)/i) || [])[1] ||
    "";
  const action =
    (text.match(/data-action=["']([^"']+)["']/i) || [])[1] ||
    (text.match(/grecaptcha\.execute\([^,]+,\s*\{\s*action\s*:\s*["']([^"']+)["']/i) || [])[1] ||
    "loginMain";
  // Button with data-callback is usually v2; execute()/render= is v3.
  const isV3 =
    /grecaptcha\.execute/i.test(text) ||
    /recaptcha\/api\.js\?render=/i.test(text) ||
    (/data-action=/i.test(text) && !/data-callback=/i.test(text));
  return { sitekey, action, isV3 };
}

async function submitTask(params) {
  const body = new URLSearchParams(params);
  const response = await fetch(IN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
    signal: AbortSignal.timeout(30000),
  });
  const text = String(await response.text()).trim();
  if (text.startsWith("OK|")) return text.slice(3);
  throw new Error(`2captcha submit failed: ${text}`);
}

async function pollResult(requestId, { timeoutMs = 180000 } = {}) {
  const key = getApiKey();
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 5000));
    const url = `${RES_URL}?key=${encodeURIComponent(key)}&action=get&id=${encodeURIComponent(requestId)}&json=0`;
    const response = await fetch(url, { signal: AbortSignal.timeout(20000) });
    const text = String(await response.text()).trim();
    if (text === "CAPCHA_NOT_READY" || text === "CAPTCHA_NOT_READY") continue;
    if (text.startsWith("OK|")) return text.slice(3);
    throw new Error(`2captcha poll failed: ${text}`);
  }
  throw new Error("2captcha timeout — captcha not solved in time");
}

/**
 * Solve Google reCAPTCHA for a page. Returns response token string.
 */
export async function solveRecaptcha({
  sitekey,
  pageurl,
  isV3 = false,
  action = "loginMain",
  minScore = 0.3,
} = {}) {
  const key = getApiKey();
  if (!key) throw new Error("TWOCAPTCHA_API_KEY is not set on the server");
  if (!sitekey) throw new Error("reCAPTCHA sitekey not found on Dream login page");

  const params = {
    key,
    method: "userrecaptcha",
    googlekey: sitekey,
    pageurl: pageurl || "https://www.dream-singles.com/login",
    json: "0",
  };
  if (isV3) {
    params.version = "v3";
    params.action = action || "loginMain";
    params.min_score = String(minScore);
  }

  const id = await submitTask(params);
  return pollResult(id);
}
