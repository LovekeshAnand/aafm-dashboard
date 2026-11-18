import { ZodError } from "zod";
import { ApiError } from "../utils/ApiError.js";
import { audit } from "../utils/audit.js";

// Postgres SQLSTATE -> HTTP. Raw database messages never reach the client.
const PG_ERRORS = {
  23505: [409, "Already exists"],
  23503: [400, "Referenced record does not exist"],
  23514: [400, "Value not allowed"],
  "22P02": [400, "Invalid identifier or value"],
  42501: [403, "Not allowed"],
  // E9: time limits and contention are temporary: tell the client to retry (503 + Retry-After).
  57014: [503, "The request took too long; try again"], // statement_timeout
  "55P03": [503, "The data is busy; try again"], // lock_timeout
  "40P01": [503, "The data is busy; try again"], // deadlock (one side was rolled back)
  40001: [503, "The data is busy; try again"], // serialization failure
};

const toApiError = (err) => {
  if (err instanceof ApiError) return err;
  if (err instanceof ZodError) {
    const issues = err.issues.map(({ path, message }) => ({
      field: path.join("."),
      message,
    }));
    return new ApiError(400, "Validation failed", issues);
  }
  // E2-E4: our own cap trigger; its message is written for users ("Limit reached: ...").
  if (err.code === "LIM01") return new ApiError(409, err.message);
  if (PG_ERRORS[err.code]) return new ApiError(...PG_ERRORS[err.code]);
  // E8: no free database connection within DB_CONNECT_TIMEOUT_MS.
  if (/timeout exceeded when trying to connect/i.test(err.message ?? ""))
    return new ApiError(503, "The service is busy; try again");
  if (err.status >= 400 && err.status < 500)
    return new ApiError(err.status, err.expose ? err.message : "Bad request");

  console.error(`[${err.requestId ?? "-"}]`, err);
  return new ApiError(500, "Internal server error");
};

// Tier 3 B: a signed-in request refused with 403, or 404 on a tenant resource (RLS makes
// "someone else's" and "missing" look the same), is an authorization failure (OWASP). It is
// recorded in its own transaction, because the request's transaction has rolled back. Not
// awaited: the response never waits for, or fails because of, the audit write.
// E5: repeats of the same refusal (same user, path and status) within a minute are counted
// and written once with the next entry, so a flood of bad requests can't flood the audit log.
const DENIAL_WINDOW_MS = 60_000;
const recentDenials = new Map(); // key -> { at, repeats }

const auditDenial = (req, statusCode, message) => {
  if (!req.db || ![403, 404].includes(statusCode)) return;
  const path = req.baseUrl + req.path;
  const key = `${req.auth.user_id}|${req.method}|${path}|${statusCode}`;
  const now = Date.now();
  const last = recentDenials.get(key);
  if (last && now - last.at < DENIAL_WINDOW_MS) {
    last.repeats += 1;
    return;
  }
  recentDenials.set(key, { at: now, repeats: 0 });
  if (recentDenials.size > 10_000)
    for (const [k, v] of recentDenials)
      if (now - v.at >= DENIAL_WINDOW_MS) recentDenials.delete(k);
  req
    .db((db) =>
      audit(db, req, "access.denied", {
        result: "denied",
        meta: {
          method: req.method,
          path,
          status: statusCode,
          reason: message,
          ...(last?.repeats && { repeats_in_previous_minute: last.repeats }),
        },
      })
    )
    .catch((err) => console.error("audit failed:", err.message));
};

// eslint-disable-next-line no-unused-vars -- Express identifies error handlers by arity
const errorHandler = (err, req, res, next) => {
  err.requestId = req.id;
  const { statusCode, message, errors } = toApiError(err);
  auditDenial(req, statusCode, message);
  if (statusCode === 503) res.set("Retry-After", "5");
  res.status(statusCode).json({ statusCode, success: false, message, errors });
};

export { errorHandler };
