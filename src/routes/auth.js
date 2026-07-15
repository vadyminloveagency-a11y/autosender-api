import express from "express";
import { getPool } from "../db.js";
import {
  adminMiddleware,
  hashPassword,
  signToken,
  verifyPassword,
} from "../auth.js";
import { decryptSecret, encryptSecret } from "../cryptoUtil.js";

const router = express.Router();

function userPayload(row) {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    role: row.role || "operator",
  };
}

router.post("/bootstrap", async (req, res) => {
  try {
    const setupSecret = process.env.SETUP_SECRET;
    if (!setupSecret || req.body?.setupSecret !== setupSecret) {
      return res.status(403).json({ ok: false, error: "Invalid setup secret" });
    }

    const db = getPool();
    const existing = await db.query("SELECT COUNT(*)::int AS count FROM users");
    if (existing.rows[0].count > 0) {
      return res.status(409).json({ ok: false, error: "Admin already exists" });
    }

    const email = String(req.body?.email || "").trim().toLowerCase();
    const password = String(req.body?.password || "");
    const name = String(req.body?.name || "").trim();

    if (!email || !password || password.length < 6) {
      return res.status(400).json({ ok: false, error: "Email and password (min 6 chars) required" });
    }

    const passwordHash = await hashPassword(password);
    const result = await db.query(
      `INSERT INTO users (email, password_hash, name, role)
       VALUES ($1, $2, $3, 'admin')
       RETURNING id, email, name, role, created_at`,
      [email, passwordHash, name || email],
    );

    const user = result.rows[0];
    const token = signToken(user);
    return res.json({ ok: true, token, user: userPayload(user) });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ ok: false, error: "Bootstrap failed" });
  }
});

router.post("/operators", adminMiddleware, async (req, res) => {
  try {
    const email = String(req.body?.email || "").trim().toLowerCase();
    const password = String(req.body?.password || "");
    const name = String(req.body?.name || "").trim();

    if (!email || !password || password.length < 6) {
      return res.status(400).json({ ok: false, error: "Email and password (min 6 chars) required" });
    }

    const db = getPool();
    const passwordHash = await hashPassword(password);
    const passwordEnc = encryptSecret(password);
    const result = await db.query(
      `INSERT INTO users (email, password_hash, password_enc, name, role)
       VALUES ($1, $2, $3, $4, 'operator')
       RETURNING id, email, name, role, created_at`,
      [email, passwordHash, passwordEnc, name || email],
    );

    return res.json({
      ok: true,
      user: { ...userPayload(result.rows[0]), password },
    });
  } catch (error) {
    if (error.code === "23505") {
      return res.status(409).json({ ok: false, error: "Email already registered" });
    }
    console.error(error);
    return res.status(500).json({ ok: false, error: "Failed to create operator" });
  }
});

/** Director cabinet — list all operator accounts with recoverable passwords. */
router.get("/operators", adminMiddleware, async (req, res) => {
  try {
    const db = getPool();
    const result = await db.query(
      `SELECT id, email, name, role, password_enc, created_at
       FROM users
       WHERE role = 'operator'
       ORDER BY created_at DESC, id DESC`,
    );
    const operators = result.rows.map((row) => {
      let password = "";
      if (row.password_enc) {
        try {
          password = decryptSecret(row.password_enc);
        } catch (error) {
          password = "";
        }
      }
      return {
        id: row.id,
        email: row.email,
        name: row.name || "",
        password: password || null,
        createdAt: row.created_at,
      };
    });
    return res.json({ ok: true, operators });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ ok: false, error: "Failed to load operators", operators: [] });
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
      "SELECT id, email, name, role, password_hash FROM users WHERE email = $1",
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
      user: userPayload(user),
    });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ ok: false, error: "Login failed" });
  }
});

export default router;
