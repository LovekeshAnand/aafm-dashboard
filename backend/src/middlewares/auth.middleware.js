import { SESSION } from "../constants.js";
import { withContext } from "../db/pool.js";
import { ApiError } from "../utils/ApiError.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import { resolveSession } from "../utils/session.js";

// Resolves the session cookie into req.auth and gives the request a tenant-scoped db handle.
const authenticate = asyncHandler(async (req, res, next) => {
  const token = req.cookies[SESSION.COOKIE];
  const session = token && (await resolveSession(token));
  if (!session) throw new ApiError(401, "Not signed in");

  req.auth = { ...session, token };
  req.db = (work) =>
    withContext(
      {
        userId: session.user_id,
        orgId: session.org_id,
        teamId: session.team_id,
      },
      work
    );
  next();
});

// Everything except the auth routes needs a changed password and a selected team/org context.
const requireContext = (req, res, next) => {
  if (req.auth.must_change_password)
    return next(new ApiError(403, "Password change required"));
  if (!req.auth.role) return next(new ApiError(403, "Select a team first"));
  next();
};

const requireRole =
  (...roles) =>
  (req, res, next) =>
    roles.flat().includes(req.auth.role)
      ? next()
      : next(new ApiError(403, "Insufficient role"));

export { authenticate, requireContext, requireRole };
