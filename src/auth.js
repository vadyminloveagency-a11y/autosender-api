import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";

export function signToken(user) {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error("JWT_SECRET is not set");
  return jwt.sign({ sub: user.id, email: user.email }, secret, { expiresIn: "30d" });
}

export function authMiddleware(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!token) {
    return res.status(401).json({ ok: false, error: "Authorization required" });
  }
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    req.user = { id: payload.sub, email: payload.email };
    return next();
  } catch {
    return res.status(401).json({ ok: false, error: "Invalid or expired token" });
  }
}

export async function hashPassword(password) {
  return bcrypt.hash(password, 10);
}

export async function verifyPassword(password, hash) {
  return bcrypt.compare(password, hash);
}
