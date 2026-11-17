import { randomBytes } from "node:crypto";
import { z } from "zod";
import { ROLES } from "../constants.js";
import { ApiError } from "../utils/ApiError.js";
import { ApiResponse } from "../utils/ApiResponse.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import { hashPassword } from "../utils/password.js";

const name = z.string().trim().min(1).max(100);
const teamRole = z.enum([ROLES.ADMIN, ROLES.EDITOR, ROLES.VIEWER]);
const teamSchema = z.strictObject({ name });
const memberSchema = z.strictObject({
  email: z
    .email()
    .max(254)
    .transform((value) => value.trim().toLowerCase()),
  name,
  role: teamRole,
});
const roleSchema = z.strictObject({ role: teamRole });

// AWS IAM-style one-time password: 120 bits from the CSPRNG, shown once, hash stored.
const oneTimePassword = () => randomBytes(15).toString("base64url");

const getOrg = asyncHandler(async (req, res) => {
  const {
    rows: [org],
  } = await req.db((db) =>
    db.query("SELECT id, slug, name, created_at FROM organizations")
  );
  res.json(new ApiResponse(200, org));
});

const listTeams = asyncHandler(async (req, res) => {
  const { rows } = await req.db((db) =>
    db.query("SELECT id, name, created_at FROM teams ORDER BY name")
  );
  res.json(new ApiResponse(200, rows));
});

const createTeam = asyncHandler(async (req, res) => {
  const { name } = teamSchema.parse(req.body);
  const {
    rows: [team],
  } = await req.db((db) =>
    db.query(
      "INSERT INTO teams (org_id, name) VALUES ($1, $2) RETURNING id, name, created_at",
      [req.auth.org_id, name]
    )
  );
  res.status(201).json(new ApiResponse(201, team, "Team created"));
});

const renameTeam = asyncHandler(async (req, res) => {
  const { name } = teamSchema.parse(req.body);
  const {
    rows: [team],
  } = await req.db((db) =>
    db.query(
      "UPDATE teams SET name = $2 WHERE id = $1 RETURNING id, name, created_at",
      [req.params.id, name]
    )
  );
  if (!team) throw new ApiError(404, "Not found");
  res.json(new ApiResponse(200, team, "Team renamed"));
});

const deleteTeam = asyncHandler(async (req, res) => {
  const { rowCount } = await req.db((db) =>
    db.query("DELETE FROM teams WHERE id = $1", [req.params.id])
  );
  if (!rowCount) throw new ApiError(404, "Not found");
  res.json(new ApiResponse(200, null, "Team deleted"));
});

const listMembers = asyncHandler(async (req, res) => {
  const { rows } = await req.db((db) =>
    db.query(
      `SELECT m.id, m.role, m.user_id, u.name, u.email, m.created_at
       FROM memberships m JOIN users u ON u.id = m.user_id
       WHERE m.team_id = $1 ORDER BY u.name`,
      [req.params.teamId]
    )
  );
  res.json(new ApiResponse(200, rows));
});

// Creates the account if the email is new to this org (one-time password returned once),
// otherwise just adds the membership. Accounts are org-scoped, so this reveals nothing
// beyond the caller's own org (plan section 10).
const addMember = asyncHandler(async (req, res) => {
  const body = memberSchema.parse(req.body);
  const password = oneTimePassword();
  const {
    rows: [result],
  } = await req.db(async (db) =>
    db.query("SELECT * FROM app.add_member($1, $2, $3, $4, $5)", [
      req.params.teamId,
      body.email,
      body.name,
      body.role,
      await hashPassword(password),
    ])
  );
  const data = {
    membership_id: result.membership_id,
    user_id: result.user_id,
    account_created: result.created,
  };
  if (result.created) data.one_time_password = password;
  res
    .status(201)
    .json(
      new ApiResponse(
        201,
        data,
        result.created ? "User created" : "Membership added"
      )
    );
});

// A team must keep at least one admin; demoting or removing the last one is refused.
const guardLastAdmin = async (db, change) => {
  if (change?.old_role !== ROLES.ADMIN) return;
  const { rowCount } = await db.query(
    "SELECT 1 FROM memberships WHERE team_id = $1 AND role = 'admin'",
    [change.team_id]
  );
  if (!rowCount) throw new ApiError(409, "A team must keep at least one admin");
};

const updateMemberRole = asyncHandler(async (req, res) => {
  const { role } = roleSchema.parse(req.body);
  await req.db(async (db) => {
    const {
      rows: [change],
    } = await db.query(
      `UPDATE memberships m SET role = $2 FROM memberships old
       WHERE m.id = $1 AND old.id = m.id AND m.team_id IS NOT NULL
       RETURNING m.team_id, old.role AS old_role`,
      [req.params.id, role]
    );
    if (!change) throw new ApiError(404, "Not found");
    await guardLastAdmin(db, change);
  });
  res.json(new ApiResponse(200, { id: req.params.id, role }, "Role updated"));
});

const removeMember = asyncHandler(async (req, res) => {
  await req.db(async (db) => {
    const {
      rows: [change],
    } = await db.query(
      "DELETE FROM memberships WHERE id = $1 AND team_id IS NOT NULL RETURNING team_id, role AS old_role",
      [req.params.id]
    );
    if (!change) throw new ApiError(404, "Not found");
    await guardLastAdmin(db, change);
  });
  res.json(new ApiResponse(200, null, "Member removed"));
});

// Escalation guard lives in app.reset_password(); a refusal is a 404 so nothing is revealed.
const resetPassword = asyncHandler(async (req, res) => {
  const password = oneTimePassword();
  const passwordHash = await hashPassword(password);
  const {
    rows: [{ ok }],
  } = await req.db((db) =>
    db.query("SELECT app.reset_password($1, $2) AS ok", [
      req.params.id,
      passwordHash,
    ])
  );
  if (!ok) throw new ApiError(404, "Not found");
  res.json(
    new ApiResponse(
      200,
      { one_time_password: password },
      "Password reset; user must change it at next sign-in"
    )
  );
});

export {
  addMember,
  createTeam,
  deleteTeam,
  getOrg,
  listMembers,
  listTeams,
  removeMember,
  renameTeam,
  resetPassword,
  updateMemberRole,
};
