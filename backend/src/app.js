import { randomUUID } from "node:crypto";
import cookieParser from "cookie-parser";
import cors from "cors";
import express from "express";
import helmet from "helmet";
import { pool } from "./db/pool.js";
import { errorHandler } from "./middlewares/error.middleware.js";
import { router } from "./routes/index.js";
import { ApiError } from "./utils/ApiError.js";
import { ApiResponse } from "./utils/ApiResponse.js";
import { asyncHandler } from "./utils/asyncHandler.js";

const app = express();

app.disable("x-powered-by");
// Exact hop count of trusted proxies (1 = Nginx on EC2). Never `true`: clients could spoof their IP.
app.set("trust proxy", Number(process.env.TRUST_PROXY) || 0);

// E22: one id per request, in the response header, error logs and audit entries, so a user's
// report, the server log and the audit trail can be matched. A well-formed id from the proxy
// (Nginx $request_id) is kept; anything else is replaced.
app.use((req, res, next) => {
  const incoming = req.get("X-Request-Id");
  req.id = /^[A-Za-z0-9-]{8,64}$/.test(incoming ?? "")
    ? incoming
    : randomUUID();
  res.set("X-Request-Id", req.id);
  next();
});
app.use(helmet());
// Only the configured frontend origin may send credentialed requests; unset = no CORS at all.
app.use(
  cors({
    origin: process.env.CORS_ORIGIN?.split(",") ?? false,
    credentials: true,
  })
);
app.use(express.json({ limit: "100kb" }));
app.use(cookieParser());

// CSRF (OWASP, custom request header): a cross-site page can't set this header without a CORS
// preflight, which the allowlist above refuses. Defense in depth with SameSite=Strict cookies.
app.use((req, res, next) =>
  ["GET", "HEAD", "OPTIONS"].includes(req.method) || req.get("X-Requested-With")
    ? next()
    : next(new ApiError(403, "Missing X-Requested-With header"))
);

app.get("/health", (req, res) =>
  res.json(new ApiResponse(200, { status: "ok" }))
);
app.get(
  "/ready",
  asyncHandler(async (req, res) => {
    await pool.query("SELECT 1");
    res.json(new ApiResponse(200, { status: "ready" }));
  })
);

app.use("/api/v1", router);
app.use((req, res, next) => next(new ApiError(404, "Route not found")));
app.use(errorHandler);

export { app };
