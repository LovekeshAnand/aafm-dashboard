import { z } from "zod";
import { displayName } from "../utils/validation.js";
import { METRIC_UNITS } from "../constants.js";
import { ApiError } from "../utils/ApiError.js";
import { ApiResponse } from "../utils/ApiResponse.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import { audit } from "../utils/audit.js";
import { FormulaError, parseFormula } from "../utils/formula.js";

// Tier 3 D: custom metric definitions, per team (Prompt 48). Everyone in the team can read
// and chart them; Editors and up define them (RLS: custom_metrics_write).
const formula = z
  .string()
  .trim()
  .max(200)
  .superRefine((value, ctx) => {
    try {
      parseFormula(value);
    } catch (err) {
      if (!(err instanceof FormulaError)) throw err;
      ctx.addIssue({
        code: "custom",
        message: err.message,
        position: err.position,
      });
    }
  });
const fields = {
  name: displayName(60),
  formula,
  unit: z.enum(METRIC_UNITS).default("number"),
};
const listSchema = z.object({ team_id: z.uuid().optional() });
const createSchema = z.strictObject({
  ...fields,
  team_id: z.uuid().optional(),
});
const updateSchema = z
  .strictObject({ ...fields, unit: z.enum(METRIC_UNITS) })
  .partial()
  .extend({ version: z.int().positive() });

const COLUMNS =
  "id, team_id, name, formula, unit, created_by, created_at, updated_at, version";

const listCustomMetrics = asyncHandler(async (req, res) => {
  const { team_id } = listSchema.parse(req.query);
  const { rows } = await req.db((db) =>
    db.query(
      `SELECT ${COLUMNS} FROM custom_metrics
       WHERE $1::uuid IS NULL OR team_id = $1 ORDER BY name`,
      [team_id ?? null]
    )
  );
  res.json(new ApiResponse(200, rows));
});

const createCustomMetric = asyncHandler(async (req, res) => {
  const body = createSchema.parse(req.body);
  const teamId = req.auth.team_id ?? body.team_id;
  if (!teamId)
    throw new ApiError(
      400,
      "team_id is required for organization-wide sessions"
    );
  const metric = await req.db(async (db) => {
    const {
      rows: [row],
    } = await db.query(
      `INSERT INTO custom_metrics (org_id, team_id, name, formula, unit, created_by)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING ${COLUMNS}`,
      [
        req.auth.org_id,
        teamId,
        body.name,
        body.formula,
        body.unit,
        req.auth.user_id,
      ]
    );
    await audit(db, req, "custom_metric.create", {
      type: "custom_metric",
      id: row.id,
      teamId,
      meta: { name: row.name, formula: row.formula },
    });
    return row;
  });
  res.status(201).json(new ApiResponse(201, metric, "Custom metric created"));
});

const updateCustomMetric = asyncHandler(async (req, res) => {
  const body = updateSchema.parse(req.body);
  const metric = await req.db(async (db) => {
    const {
      rows: [row],
    } = await db.query(
      `UPDATE custom_metrics SET name = coalesce($3, name), formula = coalesce($4, formula),
              unit = coalesce($5, unit)
       WHERE id = $1 AND version = $2 RETURNING ${COLUMNS}`,
      [req.params.id, body.version, body.name, body.formula, body.unit]
    );
    if (!row) {
      const { rowCount } = await db.query(
        "SELECT 1 FROM custom_metrics WHERE id = $1",
        [req.params.id]
      );
      throw rowCount
        ? new ApiError(409, "Modified by someone else; reload and retry")
        : new ApiError(404, "Not found");
    }
    await audit(db, req, "custom_metric.update", {
      type: "custom_metric",
      id: row.id,
      teamId: row.team_id,
      meta: { name: row.name, formula: row.formula },
    });
    return row;
  });
  res.json(new ApiResponse(200, metric, "Custom metric updated"));
});

// A metric still shown by widgets can't be deleted; the 409 names where it is used.
const deleteCustomMetric = asyncHandler(async (req, res) => {
  await req.db(async (db) => {
    const { rows: used } = await db.query(
      `SELECT w.title, d.name AS dashboard FROM widgets w JOIN dashboards d ON d.id = w.dashboard_id
       WHERE w.custom_metric_id = $1 ORDER BY d.name, w.title`,
      [req.params.id]
    );
    if (used.length)
      throw new ApiError(
        409,
        `In use by ${used.length} widget(s): ${used
          .map((u) => `"${u.title || "Untitled"}" on ${u.dashboard}`)
          .join(", ")}`
      );
    const {
      rows: [row],
    } = await db.query(
      "DELETE FROM custom_metrics WHERE id = $1 RETURNING id, team_id, name",
      [req.params.id]
    );
    if (!row) throw new ApiError(404, "Not found");
    await audit(db, req, "custom_metric.delete", {
      type: "custom_metric",
      id: row.id,
      teamId: row.team_id,
      meta: { name: row.name },
    });
  });
  res.json(new ApiResponse(200, null, "Custom metric deleted"));
});

export {
  createCustomMetric,
  deleteCustomMetric,
  listCustomMetrics,
  updateCustomMetric,
};
