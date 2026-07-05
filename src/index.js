import "dotenv/config";
import cors from "cors";
import express from "express";
import { initDb } from "./db.js";
import authRoutes from "./routes/auth.js";
import favoritesRoutes from "./routes/favorites.js";

const app = express();
const port = Number(process.env.PORT || 3000);

app.use(express.json({ limit: "1mb" }));
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

app.use("/auth", authRoutes);
app.use("/favorites", favoritesRoutes);

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
