import { createHash, randomBytes } from "node:crypto";
import { SESSION } from "../constants.js";
import { pool } from "../db/pool.js";

// 256-bit CSPRNG token in the cookie; only its SHA-256 is stored (a DB leak yields no sessions).
const hashToken = (token) => createHash("sha256").update(token).digest();
const newToken = () => randomBytes(32).toString("base64url");

const setCookie = (res, token) =>
  res.cookie(SESSION.COOKIE, token, {
    ...SESSION.COOKIE_OPTIONS,
    maxAge: SESSION.ABSOLUTE_MS,
  });

const startSession = async (res, { userId, orgId, membershipId = null }) => {
  const token = newToken();
  await pool.query(
    `INSERT INTO sessions (token_hash, user_id, org_id, membership_id, expires_at)
     VALUES ($1, $2, $3, $4, now() + $5 * interval '1 millisecond')`,
    [hashToken(token), userId, orgId, membershipId, SESSION.ABSOLUTE_MS]
  );
  setCookie(res, token);
};

// New ID on every privilege change (OWASP), keeping the original absolute expiry so switching
// teams can't extend a session forever. Returns false if the old session no longer exists.
const rotateSession = async (res, oldToken, membershipId) => {
  const token = newToken();
  const { rowCount } = await pool.query(
    `WITH old AS (DELETE FROM sessions WHERE token_hash = $1 RETURNING user_id, org_id, expires_at)
     INSERT INTO sessions (token_hash, user_id, org_id, membership_id, expires_at)
     SELECT $2, user_id, org_id, $3, expires_at FROM old`,
    [hashToken(oldToken), hashToken(token), membershipId]
  );
  if (rowCount) setCookie(res, token);
  return rowCount > 0;
};

const resolveSession = async (token) => {
  const { rows } = await pool.query(
    "SELECT * FROM app.resolve_session($1, $2)",
    [hashToken(token), SESSION.IDLE]
  );
  return rows[0] ?? null;
};

const endSession = async (res, token) => {
  await pool.query("DELETE FROM sessions WHERE token_hash = $1", [
    hashToken(token),
  ]);
  res.clearCookie(SESSION.COOKIE, SESSION.COOKIE_OPTIONS);
};

export { endSession, hashToken, resolveSession, rotateSession, startSession };
