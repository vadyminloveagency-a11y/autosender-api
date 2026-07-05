import express from "express";
import { getPool } from "../db.js";
import { hashPassword, signToken, verifyPassword } from "../auth.js";

const router = express.Router();

router.post("/register", async (req, res) => {
  try {
    const setupSecret = process.env.SETUP_SECRET;
    if (!setupSecret || req.body?.setupSecret !== setupSecret) {
      return res.status(403).json({ ok: false, error: "Invalid setup secret" });
    }

    const email = String(req.body?.email || "").trim().toLowerCase();
    const password = String(req.body?.password || "");
    const name = String(req.body?.name || "").trim();

    if (!email || !password || password.length < 6) {
      return res.status(400).json({ ok: false, error: "Email and password (min 6 chars) required" });
    }

    const db = getPool();
    const passwordHash = await hashPassword(password);
    const result = await db.query(
      `INSERT INTO users (email, password_hash, name)
       VALUES ($1, $2, $3)
       RETURNING id, email, name, created_at`,
      [email, passwordHash, name || email],
    );

    const user = result.rows[0];
    const token = signToken(user);
    return res.json({ ok: true, token, user: { id: user.id, email: user.email, name: user.name } });
  } catch (error) {
    if (error.code === "23505") {
      return res.status(409).json({ ok: false, error: "Email already registered" });
    }
    console.error(error);
    return res.status(500).json({ ok: false, error: "Registration failed" });
  }
});

router.post("/login", async (req, res) => {
  try {
    const email = String(req.body?.email || "").trim().toLowerCase();
    const password = String(req.body?.password || "");
    if (!email || !password) {
      return res.status(400).json({ ok: false, error: "Email and password required" });
    }

    const db = getPool();
    const result = await db.query(
      "SELECT id, email, name, password_hash FROM users WHERE email = $1",
      [email],
    );
    const user = result.rows[0];
    if (!user || !(await verifyPassword(password, user.password_hash))) {
      return res.status(401).json({ ok: false, error: "Invalid email or password" });
    }

    const token = signToken(user);
    return res.json({
      ok: true,
      token,
      user: { id: user.id, email: user.email, name: user.name },
    });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ ok: false, error: "Login failed" });
  }
});

export default router;
