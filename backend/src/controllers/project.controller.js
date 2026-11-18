import { z } from "zod";
import { displayName } from "../utils/validation.js";
import { publishTeamEvent } from "../realtime.js";
import { ApiError } from "../utils/ApiError.js";
import { ApiResponse } from "../utils/ApiResponse.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import { audit } from "../utils/audit.js";

// Tier 3 A: Org -> Team -> Project. Projects are reached through the team (Prompt 48), so RLS
// shows a team's projects to all of its members; only Admins and the Super Admin change them.
const name = displayName(100);
const listSchema = z.object({ team_id: z.uuid().optional() });
const createSchema = z.strictObject({ name, team_id: z.uuid().optional() });
const renameSchema = z.strictObject({ name });

const COLUMNS = "id, team_id, name, created_at";
const publish = (req, teamId, kind, projectId) =>
  publishTeamEvent(req.auth.org_id, teamId, "projects:changed", {
    kind,
    project_id: projectId,
  });

const listProjects = asyncHandler(async (req, res) => {
  const { team_id } = listSchema.parse(req.query);
  const { rows } = await req.db((db) =>
    db.query(
      `SELECT ${COLUMNS} FROM projects
       WHERE $1::uuid IS NULL OR team_id = $1 ORDER BY created_at, name`,
      [team_id ?? null]
    )
  );
  res.json(new ApiResponse(200, rows));
});

const createProject = asyncHandler(async (req, res) => {
  const body = createSchema.parse(req.body);
  const teamId = req.auth.team_id ?? body.team_id;
  if (!teamId)
    throw new ApiError(
      400,
      "team_id is required for organization-wide sessions"
    );
  const project = await req.db(async (db) => {
    const {
      rows: [row],
    } = await db.query(
      `INSERT INTO projects (org_id, team_id, name) VALUES ($1, $2, $3) RETURNING ${COLUMNS}`,
      [req.auth.org_id, teamId, body.name]
    );
    await audit(db, req, "project.create", {
      type: "project",
      id: row.id,
      teamId,
      meta: { name: row.name },
    });
    return row;
  });
  publish(req, teamId, "created", project.id);
  res.status(201).json(new ApiResponse(201, project, "Project created"));
});

const renameProject = asyncHandler(async (req, res) => {
  const body = renameSchema.parse(req.body);
  const project = await req.db(async (db) => {
    const {
      rows: [row],
    } = await db.query(
      `UPDATE projects SET name = $2 WHERE id = $1 RETURNING ${COLUMNS}`,
      [req.params.id, body.name]
    );
    if (!row) throw new ApiError(404, "Not found");
    await audit(db, req, "project.rename", {
      type: "project",
      id: row.id,
      teamId: row.team_id,
      meta: { name: row.name },
    });
    return row;
  });
  publish(req, project.team_id, "renamed", project.id);
  res.json(new ApiResponse(200, project, "Project renamed"));
});

// Deleting a project deletes its dashboards, data and alerts (FK cascade); a team always keeps
// at least one project.
const deleteProject = asyncHandler(async (req, res) => {
  const project = await req.db(async (db) => {
    const {
      rows: [row],
    } = await db.query(
      "DELETE FROM projects WHERE id = $1 RETURNING id, team_id, name",
      [req.params.id]
    );
    if (!row) throw new ApiError(404, "Not found");
    const { rowCount } = await db.query(
      "SELECT 1 FROM projects WHERE team_id = $1",
      [row.team_id]
    );
    if (!rowCount)
      throw new ApiError(409, "A team must keep at least one project");
    await audit(db, req, "project.delete", {
      type: "project",
      id: row.id,
      teamId: row.team_id,
      meta: { name: row.name },
    });
    return row;
  });
  publish(req, project.team_id, "deleted", project.id);
  res.json(new ApiResponse(200, null, "Project deleted"));
});

export { createProject, deleteProject, listProjects, renameProject };
