/**
 * Forward operator mailing routes from the admin instance to the workers instance.
 * In-memory LetterBot / Sender jobs live only on APP_ROLE=workers.
 */

function pickForwardHeaders(req) {
  const headers = {};
  const allow = [
    "authorization",
    "content-type",
    "x-profile-id",
    "accept",
    "user-agent",
  ];
  for (const key of allow) {
    const value = req.headers[key];
    if (value != null && value !== "") headers[key] = value;
  }
  return headers;
}

export function createWorkersProxy(workersBaseUrl) {
  const base = String(workersBaseUrl || "").replace(/\/+$/, "");
  if (!base) {
    throw new Error("WORKERS_API_URL is required when APP_ROLE=admin");
  }

  return async function workersProxy(req, res) {
    const target = `${base}${req.originalUrl}`;
    const method = String(req.method || "GET").toUpperCase();
    const headers = pickForwardHeaders(req);
    const init = { method, headers };

    if (method !== "GET" && method !== "HEAD") {
      if (req.body != null && Object.keys(req.body || {}).length > 0) {
        init.body = JSON.stringify(req.body);
        headers["content-type"] = headers["content-type"] || "application/json";
      } else if (typeof req.body === "string" && req.body) {
        init.body = req.body;
      }
    }

    try {
      const upstream = await fetch(target, init);
      const contentType = upstream.headers.get("content-type") || "";
      res.status(upstream.status);
      if (contentType) res.setHeader("content-type", contentType);
      const buffer = Buffer.from(await upstream.arrayBuffer());
      return res.send(buffer);
    } catch (error) {
      return res.status(502).json({
        ok: false,
        error: `Workers unreachable (${base}): ${error?.message || error}`,
      });
    }
  };
}
