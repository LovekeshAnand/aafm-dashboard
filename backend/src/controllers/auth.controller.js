import { z } from "zod";
import { displayName } from "../utils/validation.js";
import { pool, withContext } from "../db/pool.js";
import { ApiError } from "../utils/ApiError.js";
import { ApiResponse } from "../utils/ApiResponse.js";
import { closeSockets } from "../realtime.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import { audit } from "../utils/audit.js";
import { hashPassword, verifyPassword } from "../utils/password.js";
import {
  endSession,
  hashToken,
  rotateSession,
  startSession,
} from "../utils/session.js";

// OWASP Authentication Cheat Sheet: length is what matters (12+), no composition rules.
export const password = z.string().min(12).max(128);
const email = z
  .email()
  .max(254)
  .transform((value) => value.trim().toLowerCase());
const slug = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/);
const name = displayName(100);

const signupSchema = z.strictObject({
  org_name: name,
  slug,
  name,
  email,
  password,
});
const loginSchema = z.strictObject({
  org: z.string().max(40),
  email: z.string().max(254),
  password: z.string().max(128),
});
const contextSchema = z.strictObject({ membership_id: z.uuid() });
const passwordSchema = z.strictObject({
  current_password: z.string().max(128),
  new_password: password,
});

// One message for every failure (unknown org, unknown email, wrong password, locked) so the
// response never reveals which part was wrong.
const INVALID_LOGIN = "Invalid organization, email or password";
// Unknown accounts still pay for one scrypt verification, so timing doesn't reveal them either.
const dummyHash = hashPassword("timing-equalizer");

// Tier 3 B: sign-in events happen before (or across) a team context, so they are written
// with an explicit org/user context of their own.
const auditAs = (req, { userId, orgId }, action, options) =>
  withContext({ userId, orgId }, (db) => audit(db, req, action, options));

const myMemberships = async (userId, orgId) =>
  (
    await withContext({ userId, orgId }, (db) =>
      db.query("SELECT * FROM app.my_memberships()")
    )
  ).rows;

const signup = asyncHandler(async (req, res) => {
  const body = signupSchema.parse(req.body);
  const {
    rows: [account],
  } = await pool.query("SELECT * FROM app.signup($1, $2, $3, $4, $5)", [
    body.slug,
    body.org_name,
    body.email,
    body.name,
    await hashPassword(body.password),
  ]);
  await startSession(res, {
    userId: account.user_id,
    orgId: account.org_id,
    membershipId: account.membership_id,
  });
  await auditAs(
    req,
    { userId: account.user_id, orgId: account.org_id },
    "org.create",
    { type: "organization", id: account.org_id, meta: { slug: body.slug } }
  );
  res
    .status(201)
    .json(
      new ApiResponse(
        201,
        { org_id: account.org_id, slug: body.slug },
        "Organization created"
      )
    );
});

const login = asyncHandler(async (req, res) => {
  const { org, email, password } = loginSchema.parse(req.body);
  const {
    rows: [account],
  } = await pool.query("SELECT * FROM app.login_lookup($1, $2)", [org, email]);
  const valid = await verifyPassword(
    password,
    account?.password_hash ?? (await dummyHash)
  );

  // Failures are audited only for a real account (an unknown org has no trail to write to).
  // Not awaited, so the extra write doesn't make known accounts measurably slower to refuse.
  if (!account || account.locked || !valid) {
    if (account && !account.locked)
      await pool.query("SELECT app.record_login($1, false)", [account.user_id]);
    if (account)
      auditAs(
        req,
        { userId: account.user_id, orgId: account.org_id },
        "auth.login_failed",
        {
          type: "user",
          id: account.user_id,
          result: "failed",
          meta: { reason: account.locked ? "locked" : "password" },
        }
      ).catch((err) => console.error("audit failed:", err.message));
    throw new ApiError(401, INVALID_LOGIN);
  }
  await pool.query("SELECT app.record_login($1, true)", [account.user_id]);
  await auditAs(
    req,
    { userId: account.user_id, orgId: account.org_id },
    "auth.login",
    { type: "user", id: account.user_id }
  );

  const memberships = await myMemberships(account.user_id, account.org_id);
  const autoSelect =
    !account.must_change_password && memberships.length === 1
      ? memberships[0].id
      : null;
  await startSession(res, {
    userId: account.user_id,
    orgId: account.org_id,
    membershipId: autoSelect,
  });

  res.json(
    new ApiResponse(
      200,
      {
        must_change_password: account.must_change_password,
        active_membership_id: autoSelect,
        memberships,
      },
      "Signed in"
    )
  );
});

const selectContext = asyncHandler(async (req, res) => {
  const { membership_id } = contextSchema.parse(req.body);
  if (req.auth.must_change_password)
    throw new ApiError(403, "Password change required");

  const memberships = await myMemberships(req.auth.user_id, req.auth.org_id);
  const membership = memberships.find((m) => m.id === membership_id);
  if (!membership) throw new ApiError(404, "Membership not found");
  if (!(await rotateSession(res, req.auth.token, membership.id)))
    throw new ApiError(401, "Not signed in");
  closeSockets({ token: req.auth.token }); // the old session id is dead
  await auditAs(
    req,
    { userId: req.auth.user_id, orgId: req.auth.org_id },
    "auth.context_switch",
    {
      type: "membership",
      id: membership.id,
      teamId: membership.team_id,
      meta: { role: membership.role, team: membership.team_name },
    }
  );

  res.json(
    new ApiResponse(200, { active_membership: membership }, "Context selected")
  );
});

const me = asyncHandler(async (req, res) => {
  const { user_id, org_id, membership_id, must_change_password } = req.auth;
  const [
    {
      rows: [user],
    },
    memberships,
  ] = await Promise.all([
    req.db((db) =>
      db.query("SELECT id, name, email FROM users WHERE id = $1", [user_id])
    ),
    myMemberships(user_id, org_id),
  ]);
  const active_membership =
    memberships.find((m) => m.id === membership_id) ?? null;
  res.json(
    new ApiResponse(200, {
      user,
      must_change_password,
      active_membership,
      memberships,
    })
  );
});

// Changing the password ends every other session of this user (a thief's copy dies too).
const changePassword = asyncHandler(async (req, res) => {
  const { current_password, new_password } = passwordSchema.parse(req.body);
  const { user_id, token } = req.auth;
  const newHash = await hashPassword(new_password);

  await req.db(async (db) => {
    const {
      rows: [user],
    } = await db.query("SELECT password_hash FROM users WHERE id = $1", [
      user_id,
    ]);
    if (!(await verifyPassword(current_password, user.password_hash))) {
      throw new ApiError(400, "Current password is incorrect");
    }
    await db.query(
      "UPDATE users SET password_hash = $2, must_change_password = false WHERE id = $1",
      [user_id, newHash]
    );
    await audit(db, req, "auth.password_change", { type: "user", id: user_id });
  });
  await pool.query(
    "DELETE FROM sessions WHERE user_id = $1 AND token_hash <> $2",
    [user_id, hashToken(token)]
  );
  closeSockets({ userId: user_id, exceptToken: token });
  res.json(new ApiResponse(200, null, "Password changed"));
});

const logout = asyncHandler(async (req, res) => {
  await req.db((db) =>
    audit(db, req, "auth.logout", { type: "user", id: req.auth.user_id })
  );
  await endSession(res, req.auth.token);
  closeSockets({ token: req.auth.token });
  res.json(new ApiResponse(200, null, "Signed out"));
});

export { changePassword, login, logout, me, selectContext, signup };
