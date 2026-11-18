import { createHash } from "node:crypto";
import { rateLimit } from "express-rate-limit";
import { ApiError } from "../utils/ApiError.js";
import { PostgresStore } from "../utils/rate-limit-store.js";

// E1 (OWASP API4:2023): every signed-in API call is rate limited per session, not only sign-in.
// 600/min leaves room for a live dashboard (about 4 requests/s per viewer); writes get a
// tighter 120/min. The key is a hash of the session token, so the raw token isn't kept.
// Counters live in Postgres (problems-log #13), so every API instance shares one budget.
const sessionKey = (req) =>
  createHash("sha256").update(req.auth.token).digest("base64url");

const limiter = (name, limit, message, skip) =>
  rateLimit({
    store: new PostgresStore(`${name}:${limit}`),
    windowMs: 60_000,
    limit,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    keyGenerator: sessionKey,
    skip,
    handler: (req, res, next, options) => {
      res.set("Retry-After", String(Math.ceil(options.windowMs / 1000)));
      next(new ApiError(429, message));
    },
  });

const apiLimiter = limiter(
  "api",
  Number(process.env.API_RATE_LIMIT) || 600,
  "Too many requests; slow down and try again in a minute"
);
const writeLimiter = limiter(
  "write",
  Number(process.env.API_WRITE_RATE_LIMIT) || 120,
  "Too many changes in a short time; try again in a minute",
  (req) => ["GET", "HEAD", "OPTIONS"].includes(req.method)
);

export { apiLimiter, writeLimiter };
