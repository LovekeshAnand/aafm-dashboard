import { Router } from "express";
import { rateLimit } from "express-rate-limit";
import { ADMINS, EDITORS, ROLES } from "../constants.js";
import * as auth from "../controllers/auth.controller.js";
import * as dashboards from "../controllers/dashboard.controller.js";
import * as metrics from "../controllers/metric.controller.js";
import * as teams from "../controllers/team.controller.js";
import {
  authenticate,
  requireContext,
  requireRole,
} from "../middlewares/auth.middleware.js";
import { ApiError } from "../utils/ApiError.js";

// ponytail: in-memory store is per process; move to a shared store (Redis/Postgres) when the
// API runs on more than one instance. Per-account lockout (in the DB) covers distributed guessing.
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: Number(process.env.AUTH_RATE_LIMIT) || 10,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  handler: (req, res, next) =>
    next(new ApiError(429, "Too many attempts, try again later")),
});

const router = Router();

router.post("/auth/signup", authLimiter, auth.signup);
router.post("/auth/login", authLimiter, auth.login);
router.post("/auth/context", authenticate, auth.selectContext);
router.post("/auth/password", authenticate, auth.changePassword);
router.post("/auth/logout", authenticate, auth.logout);
router.get("/auth/me", authenticate, auth.me);

// Everything below needs a session with a changed password and a selected context.
router.use(authenticate, requireContext);
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

export { router };
