import { createHash } from "node:crypto";
import { ApiError } from "../utils/ApiError.js";
import { asyncHandler } from "../utils/asyncHandler.js";

// E20: Idempotency-Key on POST (IETF draft-ietf-httpapi-idempotency-key-header). A client that
// times out can resend the same request with the same key and get the original response
// instead of creating a duplicate.
//   same key, same request, finished  -> the stored response again (Idempotent-Replayed: true)
//   same key, same request, running   -> 409
//   same key, different request       -> 422
// Keys are per user and kept 24 h (housekeeping). Only successful responses are stored; a
// failed request can simply be retried. A key left "running" by a crash is released after 60 s
// (longer than any request can run: 30 s server timeout).
// Responses that carry a secret shown only once (one-time passwords, webhook signing secrets)
// are never stored, so on those endpoints the header is ignored; a repeat there is either
// refused by a unique constraint or harmless (a newer password or secret replaces the old).
const SECRET_BEARING =
  /^\/(teams\/[^/]+\/members|users\/[^/]+\/reset-password|webhooks(\/[^/]+\/rotate-secret)?)$/;
const KEY = /^[\x21-\x7e]{1,255}$/; // visible ASCII
const STALE_SECONDS = 60;

const idempotency = asyncHandler(async (req, res, next) => {
  const key = req.get("Idempotency-Key");
  if (
    req.method !== "POST" ||
    key === undefined ||
    SECRET_BEARING.test(req.path)
  )
    return next();
  if (!KEY.test(key)) throw new ApiError(400, "Invalid Idempotency-Key header");

  const fingerprint = createHash("sha256")
    .update(`${req.method} ${req.path} ${JSON.stringify(req.body ?? null)}`)
    .digest("base64url");

  const claim = () =>
    req.db((db) =>
      db.query(
        `INSERT INTO idempotency_keys (user_id, key, request_hash)
         VALUES (app.current_user_id(), $1, $2) ON CONFLICT DO NOTHING`,
        [key, fingerprint]
      )
    );

  let { rowCount } = await claim();
  if (!rowCount) {
    const {
      rows: [seen],
    } = await req.db((db) =>
      db.query(
        `SELECT request_hash, status_code, response,
                status_code IS NULL AND created_at < now() - $2 * interval '1 second' AS stale
         FROM idempotency_keys WHERE key = $1`,
        [key, STALE_SECONDS]
      )
    );
    if (seen?.request_hash && seen.request_hash !== fingerprint)
      throw new ApiError(
        422,
        "This Idempotency-Key was already used for a different request"
      );
    if (seen?.status_code) {
      res.set("Idempotent-Replayed", "true");
      return res.status(seen.status_code).json(seen.response);
    }
    if (!seen?.stale)
      throw new ApiError(
        409,
        "A request with this Idempotency-Key is still in progress"
      );
    // Abandoned by a crash: release it and run the request now.
    await req.db((db) =>
      db.query(
        "DELETE FROM idempotency_keys WHERE key = $1 AND status_code IS NULL",
        [key]
      )
    );
    ({ rowCount } = await claim());
    if (!rowCount)
      throw new ApiError(
        409,
        "A request with this Idempotency-Key is still in progress"
      );
  }

  // Record the outcome before the response leaves (keep a success, release the key otherwise),
  // so a client that retries the moment it gets an answer finds the stored result, not a 409.
  // If recording fails, the response is still sent; the key is then released after 60 s.
  const json = res.json.bind(res);
  res.json = (body) => {
    const ok = res.statusCode >= 200 && res.statusCode < 300;
    req
      .db((db) =>
        ok
          ? db.query(
              "UPDATE idempotency_keys SET status_code = $2, response = $3 WHERE key = $1",
              [key, res.statusCode, body]
            )
          : db.query("DELETE FROM idempotency_keys WHERE key = $1", [key])
      )
      .catch((err) => console.error("idempotency record failed:", err.message))
      .finally(() => json(body));
    return res;
  };
  next();
});

export { idempotency };
