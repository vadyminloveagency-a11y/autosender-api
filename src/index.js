import "dotenv/config";
import cors from "cors";
import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { initDb } from "./db.js";
import authRoutes from "./routes/auth.js";
import profilesRoutes from "./routes/profiles.js";
import { ensureAgencyProfileTables } from "./agencyProfileStore.js";
import favoritesRoutes from "./routes/favorites.js";
import inboxRoutes from "./routes/inbox.js";
import letterbotRoutes, { restoreRunningLetterBotJobs } from "./routes/letterbot.js";
import agencyFinanceRoutes from "./routes/agencyFinance.js";
import senderReadsRoutes, { restoreRunningSenderReadsJobs } from "./routes/senderReads.js";
import operatorDashboardRoutes from "./routes/operatorDashboard.js";
import { ensureLetterBotTables } from "./letterbotStore.js";
import { ensureSenderReadsTables } from "./senderReadsStore.js";
import { ensureMailingDailyTables } from "./mailingDailyStore.js";
import { ensureAgencyFinanceTables } from "./agencyFinanceStore.js";
import { ensureAgencyFinanceActionTables } from "./agencyFinanceActionsStore.js";
import { refreshCurrentFinanceActionsCache } from "./agencyFinanceActionsCache.js";
import { createWorkersProxy } from "./workersProxy.js";

const app = express();
const port = Number(process.env.PORT || 3000);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** @type {"all" | "workers" | "admin"} */
const appRole = (() => {
  const raw = String(process.env.APP_ROLE || "all").trim().toLowerCase();
  if (raw === "workers" || raw === "worker" || raw === "operators") return "workers";
  if (raw === "admin" || raw === "director") return "admin";
  return "all";
})();

const runWorkers = appRole === "all" || appRole === "workers";
const runAdminJobs = appRole === "all" || appRole === "admin";
const workersApiUrl = String(process.env.WORKERS_API_URL || "").trim();

app.use(express.json({ limit: "2mb" }));
app.use(
  cors({
    origin(origin, callback) {
      if (!origin) return callback(null, true);
      if (origin.startsWith("chrome-extension://")) return callback(null, true);
      callback(null, true);
    },
  }),
);

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    service: "autosender-api",
    role: appRole,
    workers: runWorkers,
    adminJobs: runAdminJobs,
  });
});

app.get("/admin", (_req, res) => {
  res.sendFile(path.join(__dirname, "../public/admin.html"));
});

app.use(express.static(path.join(__dirname, "../public")));

app.use("/auth", authRoutes);
app.use("/profiles", profilesRoutes);
app.use("/operator-dashboard", operatorDashboardRoutes);
app.use("/favorites", favoritesRoutes);
app.use("/inbox", inboxRoutes);
if (runAdminJobs) {
  app.use("/agency-finance", agencyFinanceRoutes);
}

// LetterBot / Sender live only on the workers instance. Admin proxies there.
if (appRole === "admin") {
  if (workersApiUrl) {
    const proxy = createWorkersProxy(workersApiUrl);
    app.use("/letterbot", proxy);
    app.use("/sender-reads", proxy);
  } else {
    console.warn(
      "APP_ROLE=admin without WORKERS_API_URL — /letterbot and /sender-reads return 503",
    );
    const missing = (_req, res) =>
      res.status(503).json({
        ok: false,
        error: "WORKERS_API_URL is not configured on the admin service",
      });
    app.use("/letterbot", missing);
    app.use("/sender-reads", missing);
  }
} else {
  app.use("/letterbot", letterbotRoutes);
  app.use("/sender-reads", senderReadsRoutes);
}

async function start() {
  await initDb();
  await ensureLetterBotTables();
  await ensureAgencyProfileTables();
  await ensureSenderReadsTables();
  await ensureMailingDailyTables();
  if (runAdminJobs) {
    await ensureAgencyFinanceTables();
    await ensureAgencyFinanceActionTables();
  }
  app.listen(port, () => {
    console.log(`autosender-api listening on ${port} (APP_ROLE=${appRole})`);
  });

  if (runWorkers) {
    // Resume cloud mailings after deploy/restart — no Chrome required.
    restoreRunningLetterBotJobs().catch((error) => {
      console.error("LetterBot restore failed:", error?.message || error);
    });
    restoreRunningSenderReadsJobs().catch((error) => {
      console.error("SenderReads restore failed:", error?.message || error);
    });
  } else {
    console.log("Skipping mailing workers restore (APP_ROLE=admin)");
  }

  // Finance Dream scrape on admin (or all) so workers stay focused on mailings.
  if (runAdminJobs) {
    const financeRefresh = () =>
      refreshCurrentFinanceActionsCache().catch((error) => {
        console.error("Agency finance cache refresh failed:", error?.message || error);
      });
    setTimeout(financeRefresh, 15_000);
    const financeTimer = setInterval(financeRefresh, 5 * 60_000);
    financeTimer.unref?.();
  }
}

start().catch((error) => {
  console.error(error);
  process.exit(1);
});
