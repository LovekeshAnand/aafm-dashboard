import { randomBytes } from "node:crypto";
import { z } from "zod";
import { displayName } from "../utils/validation.js";
import { ROLES } from "../constants.js";
import { closeSockets, publishTeamEvent } from "../realtime.js";
import { ApiError } from "../utils/ApiError.js";
import { ApiResponse } from "../utils/ApiResponse.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import { actorOf, audit, emitWebhook } from "../utils/audit.js";
import { deliver, notify, ROLE_NAME, teamName } from "../utils/notify.js";
import { hashPassword } from "../utils/password.js";

const name = displayName(100);
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
  const team = await req.db(async (db) => {
    const {
      rows: [row],
    } = await db.query(
      "INSERT INTO teams (org_id, name) VALUES ($1, $2) RETURNING id, name, created_at",
      [req.auth.org_id, name]
    );
    await audit(db, req, "team.create", {
      type: "team",
      id: row.id,
      teamId: row.id,
      meta: { name },
    });
    return row;
  });
  publishTeamEvent(req.auth.org_id, team.id, "teams:changed", {
    kind: "created",
  });
  res.status(201).json(new ApiResponse(201, team, "Team created"));
});

const renameTeam = asyncHandler(async (req, res) => {
  const { name } = teamSchema.parse(req.body);
  const team = await req.db(async (db) => {
    const {
      rows: [row],
    } = await db.query(
      "UPDATE teams SET name = $2 WHERE id = $1 RETURNING id, name, created_at",
      [req.params.id, name]
    );
    if (!row) throw new ApiError(404, "Not found");
    await audit(db, req, "team.rename", {
      type: "team",
      id: row.id,
      teamId: row.id,
      meta: { name },
    });
    return row;
  });
  publishTeamEvent(req.auth.org_id, team.id, "teams:changed", {
    kind: "renamed",
  });
  res.json(new ApiResponse(200, team, "Team renamed"));
});

const deleteTeam = asyncHandler(async (req, res) => {
  const { users, notes } = await req.db(async (db) => {
    // Read before the delete: the memberships (and their sessions) cascade away with the team.
    const { rows: users } = await db.query(
      "SELECT DISTINCT user_id FROM memberships WHERE team_id = $1",
      [req.params.id]
    );
    const {
      rows: [row],
    } = await db.query("DELETE FROM teams WHERE id = $1 RETURNING id, name", [
      req.params.id,
    ]);
    if (!row) throw new ApiError(404, "Not found");
    // F3: tell everyone who was in it.
    const notes = await Promise.all(
      users.map(({ user_id }) =>
        notify(
          db,
          user_id,
          "team_deleted",
          `The team ${row.name} was deleted`,
          {
            body: `${req.auth.name} deleted it, so you no longer have access to its dashboards.`,
          }
        )
      )
    );
    await audit(db, req, "team.delete", {
      type: "team",
      id: row.id,
      teamId: row.id,
      meta: { name: row.name },
    });
    return { users, notes };
  });
  // E12: their sessions in this team are gone; close live connections now instead of at the
  // next 60 s recheck. Sessions in other teams reconnect on their own (client retry, #42).
  deliver(notes);
  for (const { user_id } of users) closeSockets({ userId: user_id });
  publishTeamEvent(req.auth.org_id, req.params.id, "teams:changed", {
    kind: "deleted",
  });
  res.json(new ApiResponse(200, null, "Team deleted"));
});

const listMembers = asyncHandler(async (req, res) => {
  // Viewing a team's members is a "named read" (Prompt 48), so it is audited.
  const { rows } = await req.db(async (db) => {
    const result = await db.query(
      `SELECT m.id, m.role, m.user_id, u.name, u.email, m.created_at
       FROM memberships m JOIN users u ON u.id = m.user_id
       WHERE m.team_id = $1 ORDER BY u.name`,
      [req.params.teamId]
    );
    await audit(db, req, "members.view", {
      type: "team",
      id: req.params.teamId,
      teamId: req.params.teamId,
    });
    return result;
  });
  res.json(new ApiResponse(200, rows));
});

// Creates the account if the email is new to this org (one-time password returned once),
// otherwise just adds the membership. Accounts are org-scoped, so this reveals nothing
// beyond the caller's own org (plan section 10).
const addMember = asyncHandler(async (req, res) => {
  const body = memberSchema.parse(req.body);
  const password = oneTimePassword();
  const outcome = await req.db(async (db) => {
    const result = await db.query(
      "SELECT * FROM app.add_member($1, $2, $3, $4, $5)",
      [
        req.params.teamId,
        body.email,
        body.name,
        body.role,
        await hashPassword(password),
      ]
    );
    const [added] = result.rows;
    const member = {
      user_id: added.user_id,
      name: body.name,
      email: body.email,
      role: body.role,
    };
    await audit(db, req, "member.add", {
      type: "user",
      id: added.user_id,
      teamId: req.params.teamId,
      meta: {
        email: body.email,
        role: body.role,
        account_created: added.created,
      },
    });
    await emitWebhook(db, req.params.teamId, null, "member.added", {
      team_id: req.params.teamId,
      member,
      actor: actorOf(req),
    });
    // F4: "You've been added to <team>" (new accounts see it at their first sign-in).
    result.note = await notify(
      db,
      added.user_id,
      "team_added",
      `You've been added to ${await teamName(db, req.params.teamId)}`,
      {
        body: `${req.auth.name} added you as ${ROLE_NAME[body.role]}. Switch to it from your workspace menu.`,
        link: "/select-team",
        meta: { team_id: req.params.teamId, role: body.role },
      }
    );
    return result;
  });
  deliver([outcome.note]);
  const [result] = outcome.rows;
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
  const note = await req.db(async (db) => {
    const {
      rows: [change],
    } = await db.query(
      `UPDATE memberships m SET role = $2 FROM memberships old
       WHERE m.id = $1 AND old.id = m.id AND m.team_id IS NOT NULL
       RETURNING m.team_id, m.user_id, old.role AS old_role`,
      [req.params.id, role]
    );
    if (!change) throw new ApiError(404, "Not found");
    await guardLastAdmin(db, change);
    await audit(db, req, "member.role_change", {
      type: "user",
      id: change.user_id,
      teamId: change.team_id,
      meta: { from: change.old_role, to: role },
    });
    if (change.old_role === role) return null;
    // F3: "Your role in Finance is now Editor".
    return notify(
      db,
      change.user_id,
      "role_changed",
      `Your role in ${await teamName(db, change.team_id)} is now ${ROLE_NAME[role]}`,
      {
        body: `${req.auth.name} changed it from ${ROLE_NAME[change.old_role]} to ${ROLE_NAME[role]}.`,
        meta: { team_id: change.team_id, from: change.old_role, to: role },
      }
    );
  });
  deliver([note]);
  res.json(new ApiResponse(200, { id: req.params.id, role }, "Role updated"));
});

const removeMember = asyncHandler(async (req, res) => {
  const removed = await req.db(async (db) => {
    const {
      rows: [change],
    } = await db.query(
      "DELETE FROM memberships WHERE id = $1 AND team_id IS NOT NULL RETURNING team_id, user_id, role AS old_role",
      [req.params.id]
    );
    if (!change) throw new ApiError(404, "Not found");
    await guardLastAdmin(db, change);
    await audit(db, req, "member.remove", {
      type: "user",
      id: change.user_id,
      teamId: change.team_id,
      meta: { role: change.old_role },
    });
    await emitWebhook(db, change.team_id, null, "member.removed", {
      team_id: change.team_id,
      member: { user_id: change.user_id, role: change.old_role },
      actor: actorOf(req),
    });
    // F3: "You were removed from Finance".
    change.note = await notify(
      db,
      change.user_id,
      "team_removed",
      `You were removed from ${await teamName(db, change.team_id)}`,
      {
        body: `${req.auth.name} removed your ${ROLE_NAME[change.old_role]} access to this team.`,
        meta: { team_id: change.team_id },
      }
    );
    return change;
  });
  deliver([removed.note]);
  // E12: the removed membership's sessions are gone (FK cascade); close live connections now.
  closeSockets({ userId: removed.user_id });
  res.json(new ApiResponse(200, null, "Member removed"));
});

// Escalation guard lives in app.reset_password(); a refusal is a 404 so nothing is revealed.
const resetPassword = asyncHandler(async (req, res) => {
  const password = oneTimePassword();
  const passwordHash = await hashPassword(password);
  const {
    rows: [{ ok }],
  } = await req.db(async (db) => {
    const result = await db.query("SELECT app.reset_password($1, $2) AS ok", [
      req.params.id,
      passwordHash,
    ]);
    if (result.rows[0].ok) {
      await audit(db, req, "user.password_reset", {
        type: "user",
        id: req.params.id,
      });
      // F3: the user learns why their sessions ended (shown at the next sign-in).
      await notify(
        db,
        req.params.id,
        "password_reset",
        "Your password was reset",
        {
          body: `${req.auth.name} reset it. Sign in with the one-time password they give you, then choose a new one.`,
        }
      );
    }
    return result;
  });
  if (!ok) throw new ApiError(404, "Not found");
  closeSockets({ userId: req.params.id }); // every session of that user was revoked
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
