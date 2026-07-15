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
import senderReadsRoutes, { restoreRunningSenderReadsJobs } from "./routes/senderReads.js";
import { ensureLetterBotTables } from "./letterbotStore.js";
import { ensureSenderReadsTables } from "./senderReadsStore.js";

const app = express();
const port = Number(process.env.PORT || 3000);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

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
  res.json({ ok: true, service: "autosender-api" });
});

app.get("/admin", (_req, res) => {
  res.sendFile(path.join(__dirname, "../public/admin.html"));
});

app.use(express.static(path.join(__dirname, "../public")));

app.use("/auth", authRoutes);
app.use("/profiles", profilesRoutes);
app.use("/favorites", favoritesRoutes);
app.use("/inbox", inboxRoutes);
app.use("/letterbot", letterbotRoutes);
app.use("/sender-reads", senderReadsRoutes);

async function start() {
  await initDb();
  await ensureLetterBotTables();
  await ensureAgencyProfileTables();
  await ensureSenderReadsTables();
  app.listen(port, () => {
    console.log(`autosender-api listening on ${port}`);
  });
  // Resume cloud mailings after deploy/restart — no Chrome required.
  restoreRunningLetterBotJobs().catch((error) => {
    console.error("LetterBot restore failed:", error?.message || error);
  });
  restoreRunningSenderReadsJobs().catch((error) => {
    console.error("SenderReads restore failed:", error?.message || error);
  });
}

start().catch((error) => {
  console.error(error);
  process.exit(1);
});
