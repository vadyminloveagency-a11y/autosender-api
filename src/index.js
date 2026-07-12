import "dotenv/config";
import cors from "cors";
import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { initDb } from "./db.js";
import authRoutes from "./routes/auth.js";
import favoritesRoutes from "./routes/favorites.js";
import inboxRoutes from "./routes/inbox.js";
import letterbotRoutes from "./routes/letterbot.js";

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
app.use("/favorites", favoritesRoutes);
app.use("/inbox", inboxRoutes);
app.use("/letterbot", letterbotRoutes);

async function start() {
  await initDb();
  app.listen(port, () => {
    console.log(`autosender-api listening on ${port}`);
  });
}

start().catch((error) => {
  console.error(error);
  process.exit(1);
});
