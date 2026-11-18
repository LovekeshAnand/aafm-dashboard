// Mirrors the enums in src/db/migrations/001_tenancy.sql.
export const ROLES = Object.freeze({
  SUPER_ADMIN: "super_admin",
  ADMIN: "admin",
  EDITOR: "editor",
  VIEWER: "viewer",
});
export const EDITORS = [ROLES.SUPER_ADMIN, ROLES.ADMIN, ROLES.EDITOR];
export const ADMINS = [ROLES.SUPER_ADMIN, ROLES.ADMIN];

export const METRICS = Object.freeze([
  "revenue",
  "page_views",
  "clicks",
  "errors",
  "users",
]);
export const WIDGET_TYPES = Object.freeze(["line", "bar", "stat"]);

const isProduction = process.env.NODE_ENV === "production";

// OWASP Session Management: 30 min idle / 8 h absolute, enforced server-side.
// __Host- prefix requires Secure, so it is only used in production (HTTPS).
export const SESSION = Object.freeze({
  COOKIE: isProduction ? "__Host-session" : "session",
  IDLE: "30 minutes",
  ABSOLUTE_MS: 8 * 60 * 60 * 1000,
  COOKIE_OPTIONS: {
    httpOnly: true,
    secure: isProduction,
    sameSite: "strict",
    path: "/",
  },
});

// Tier 2 C: built-in KPIs, each a ratio of two base metrics, computed on read as
// sum(numerator) / sum(denominator) over the same bucket (a ratio of sums, never an
// average of per-point ratios). Zero denominator -> null, never Infinity.
export const KPIS = Object.freeze({
  arpu: { numerator: "revenue", denominator: "users" },
  ctr: { numerator: "clicks", denominator: "page_views" },
  error_rate: { numerator: "errors", denominator: "page_views" },
});

// Tier 3 C: events a webhook can subscribe to (mirrors the CHECK in migration 009).
export const WEBHOOK_EVENTS = Object.freeze([
  "alert.opened",
  "alert.resolved",
  "dashboard.created",
  "dashboard.updated",
  "dashboard.deleted",
  "member.added",
  "member.removed",
]);

// Tier 3 D: how a custom metric's value is displayed.
export const METRIC_UNITS = Object.freeze(["number", "currency", "percent"]);
