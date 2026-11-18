import { Router } from "express";
import { rateLimit } from "express-rate-limit";
import { ADMINS, EDITORS, ROLES } from "../constants.js";
import * as access from "../controllers/access.controller.js";
import * as alerts from "../controllers/alert.controller.js";
import * as audit from "../controllers/audit.controller.js";
import * as auth from "../controllers/auth.controller.js";
import * as customMetrics from "../controllers/custom-metric.controller.js";
import * as dashboards from "../controllers/dashboard.controller.js";
import * as metrics from "../controllers/metric.controller.js";
import * as notifications from "../controllers/notification.controller.js";
import * as projects from "../controllers/project.controller.js";
import * as teams from "../controllers/team.controller.js";
import * as webhooks from "../controllers/webhook.controller.js";
import {
  authenticate,
  requireContext,
  requireRole,
} from "../middlewares/auth.middleware.js";
import { idempotency } from "../middlewares/idempotency.middleware.js";
import { apiLimiter, writeLimiter } from "../middlewares/limits.middleware.js";
import { ApiError } from "../utils/ApiError.js";
import { PostgresStore } from "../utils/rate-limit-store.js";

// Per client IP, shared by every instance (Postgres store, problems-log #13). Per-account
// lockout (in the DB) also covers distributed guessing. Behind Nginx, TRUST_PROXY=1 makes req.ip
// the real client (deploy item, #13).
const authLimit = Number(process.env.AUTH_RATE_LIMIT) || 10;
const authLimiter = rateLimit({
  store: new PostgresStore(`auth:${authLimit}`),
  windowMs: 15 * 60 * 1000,
  limit: authLimit,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  handler: (req, res, next) =>
    next(new ApiError(429, "Too many attempts, try again later")),
});

const router = Router();

router.post("/auth/signup", authLimiter, auth.signup);
router.post("/auth/login", authLimiter, auth.login);
// Signed-in calls are rate limited per session (E1, docs/edge-case-audit.md).
const signedIn = [authenticate, apiLimiter, writeLimiter];
router.post("/auth/context", signedIn, auth.selectContext);
router.post("/auth/password", signedIn, auth.changePassword);
router.post("/auth/logout", signedIn, auth.logout);
router.get("/auth/me", signedIn, auth.me);
// F3 + F4: your own notifications, also before a team is selected.
router.get("/notifications", signedIn, notifications.listNotifications);
router.post("/notifications/read", signedIn, notifications.markRead);

// Everything below needs a session with a changed password and a selected context.
// POSTs honour an Idempotency-Key (E20).
router.use(signedIn, requireContext, idempotency);
const editors = requireRole(EDITORS);
const admins = requireRole(ADMINS);
const superAdmin = requireRole(ROLES.SUPER_ADMIN);

router.get("/org", teams.getOrg);
router.get("/teams", teams.listTeams);
router.post("/teams", superAdmin, teams.createTeam);
router.patch("/teams/:id", superAdmin, teams.renameTeam);
router.delete("/teams/:id", superAdmin, teams.deleteTeam);
router.get("/teams/:teamId/members", teams.listMembers);
router.post("/teams/:teamId/members", admins, teams.addMember);
router.patch("/memberships/:id", admins, teams.updateMemberRole);
router.delete("/memberships/:id", admins, teams.removeMember);
router.post("/users/:id/reset-password", admins, teams.resetPassword);

router.get("/dashboards", dashboards.listDashboards);
router.post("/dashboards", editors, dashboards.createDashboard);
router.get("/dashboards/:id", dashboards.getDashboard);
router.patch("/dashboards/:id", editors, dashboards.renameDashboard);
router.delete("/dashboards/:id", admins, dashboards.deleteDashboard);
router.post("/dashboards/:id/widgets", editors, dashboards.addWidget);
router.put("/dashboards/:id/layout", editors, dashboards.saveLayout);
router.patch("/widgets/:id", editors, dashboards.updateWidget);
router.delete("/widgets/:id", editors, dashboards.deleteWidget);

router.get("/metrics/series", metrics.series);
router.get("/metrics/summary", metrics.summary);
router.get("/metrics/kpi", metrics.kpiSeries);
router.get("/metrics/custom", metrics.customSeries);
router.get("/metrics/formula", metrics.formulaPreview);
router.get("/alerts", alerts.listAlerts);

// F7: ask another team for one figure; its Admins decide; read only that figure.
router.get("/teams/directory", access.directory);
router.get("/access-requests", access.listRequests);
router.post("/access-requests", access.createRequest);
router.post("/access-requests/:id/decide", admins, access.decide);
router.post("/access-requests/:id/revoke", admins, access.revoke);
router.get("/shared/:id/series", access.sharedSeries);
router.get("/shared/:id/summary", access.sharedSummary);

// Tier 3
router.get("/projects", projects.listProjects);
router.post("/projects", admins, projects.createProject);
router.patch("/projects/:id", admins, projects.renameProject);
router.delete("/projects/:id", admins, projects.deleteProject);
router.post("/projects/:id/complete", admins, projects.completeProject);
router.post("/projects/:id/reopen", admins, projects.reopenProject);

router.get("/custom-metrics", customMetrics.listCustomMetrics);
router.post("/custom-metrics", editors, customMetrics.createCustomMetric);
router.patch("/custom-metrics/:id", editors, customMetrics.updateCustomMetric);
router.delete("/custom-metrics/:id", editors, customMetrics.deleteCustomMetric);

router.get("/audit", admins, audit.listAudit);
router.get("/audit/verify", admins, audit.verifyAudit);
router.get("/audit/storage", admins, audit.auditStorage);

router.get("/webhooks", admins, webhooks.listWebhooks);
router.post("/webhooks", admins, webhooks.createWebhook);
router.patch("/webhooks/:id", admins, webhooks.updateWebhook);
router.delete("/webhooks/:id", admins, webhooks.deleteWebhook);
router.post("/webhooks/:id/rotate-secret", admins, webhooks.rotateSecret);
router.post("/webhooks/:id/test", admins, webhooks.testWebhook);
router.get("/webhooks/:id/deliveries", admins, webhooks.listDeliveries);
router.post("/webhook-deliveries/:id/redeliver", admins, webhooks.redeliver);

export { router };
