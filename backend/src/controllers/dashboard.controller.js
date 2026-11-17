import { z } from "zod";
import { KPIS, METRICS, WIDGET_TYPES } from "../constants.js";
import { publishDashboardChange, publishTeamEvent } from "../realtime.js";

// Tier 2 A: list-level changes go to the whole team channel so switchers update live (#25).
const publishList = (req, teamId, kind, dashboardId) =>
  publishTeamEvent(req.auth.org_id, teamId, "dashboards:changed", {
    kind,
    dashboard_id: dashboardId,
    actor: { user_id: req.auth.user_id, name: req.auth.name },
  });
import { ApiError } from "../utils/ApiError.js";
import { ApiResponse } from "../utils/ApiResponse.js";
import { asyncHandler } from "../utils/asyncHandler.js";

// org_id / team_id are never read from the body for team sessions; RLS rejects anything
// outside the session's scope anyway.
const name = z.string().trim().min(1).max(100);
const version = z.int().positive();
const grid = {
  x: z.int().min(0).max(11),
  y: z.int().min(0).max(1000),
  w: z.int().min(1).max(12),
  h: z.int().min(1).max(12),
};
// A widget shows exactly one source: a base metric, or a built-in KPI (Tier 2 C).
const widgetFields = {
  type: z.enum(WIDGET_TYPES),
  metric: z.enum(METRICS),
  kpi: z.enum(Object.keys(KPIS)),
  title: z.string().trim().max(100),
  config: z.record(z.string(), z.unknown()),
  ...grid,
};
const oneSource = (w) => (w.metric === undefined) !== (w.kpi === undefined);
const atMostOneSource = (w) => !(w.metric && w.kpi);

const listSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
const createSchema = z.strictObject({ name, team_id: z.uuid().optional() });
const renameSchema = z.strictObject({ name, version });
const widgetSchema = z
  .strictObject({
    ...widgetFields,
    metric: widgetFields.metric.optional(),
    kpi: widgetFields.kpi.optional(),
    title: widgetFields.title.default(""),
    config: widgetFields.config.default({}),
  })
  .refine(oneSource, "Choose exactly one of metric or kpi");
const widgetUpdateSchema = z
  .strictObject(widgetFields)
  .partial()
  .extend({ version })
  .refine(atMostOneSource, "Choose metric or kpi, not both");
const layoutSchema = z.strictObject({
  items: z
    .array(z.strictObject({ id: z.uuid(), ...grid }))
    .min(1)
    .max(100)
    .refine(
      (items) => new Set(items.map((item) => item.id)).size === items.length,
      "Duplicate widget id"
    ),
});

// A versioned UPDATE matched nothing: either the row is gone/invisible (404) or someone else
// saved first (409, client should refetch).
const missingOrStale = async (db, table, id) => {
  const { rowCount } = await db.query(`SELECT 1 FROM ${table} WHERE id = $1`, [
    id,
  ]);
  return rowCount
    ? new ApiError(409, "Modified by someone else; reload and retry")
    : new ApiError(404, "Not found");
};

const listDashboards = asyncHandler(async (req, res) => {
  const { limit, offset } = listSchema.parse(req.query);
  const { rows } = await req.db((db) =>
    db.query(
      `SELECT id, team_id, name, version, created_by, created_at, updated_at
       FROM dashboards ORDER BY updated_at DESC LIMIT $1 OFFSET $2`,
      [limit, offset]
    )
  );
  res.json(new ApiResponse(200, rows));
});

const createDashboard = asyncHandler(async (req, res) => {
  const body = createSchema.parse(req.body);
  // Team sessions always use their own team; an org-wide super admin must say which team.
  const teamId = req.auth.team_id ?? body.team_id;
  if (!teamId)
    throw new ApiError(
      400,
      "team_id is required for organization-wide sessions"
    );

  const {
    rows: [dashboard],
  } = await req.db((db) =>
    db.query(
      `INSERT INTO dashboards (org_id, team_id, name, created_by) VALUES ($1, $2, $3, $4)
       RETURNING id, team_id, name, version, created_by, created_at, updated_at`,
      [req.auth.org_id, teamId, body.name, req.auth.user_id]
    )
  );
  publishList(req, dashboard.team_id, "created", dashboard.id);
  res.status(201).json(new ApiResponse(201, dashboard, "Dashboard created"));
});

const getDashboard = asyncHandler(async (req, res) => {
  const dashboard = await req.db(async (db) => {
    const {
      rows: [row],
    } = await db.query(
      "SELECT id, team_id, name, version, created_by, created_at, updated_at FROM dashboards WHERE id = $1",
      [req.params.id]
    );
    if (!row) throw new ApiError(404, "Not found");
    const { rows: widgets } = await db.query(
      `SELECT id, type, metric, kpi, title, x, y, w, h, config, version, updated_at
       FROM widgets WHERE dashboard_id = $1 ORDER BY y, x`,
      [row.id]
    );
    return { ...row, widgets };
  });
  res.json(new ApiResponse(200, dashboard));
});

const renameDashboard = asyncHandler(async (req, res) => {
  const body = renameSchema.parse(req.body);
  const dashboard = await req.db(async (db) => {
    const {
      rows: [row],
    } = await db.query(
      `UPDATE dashboards SET name = $3 WHERE id = $1 AND version = $2
       RETURNING id, team_id, name, version, updated_at`,
      [req.params.id, body.version, body.name]
    );
    if (!row) throw await missingOrStale(db, "dashboards", req.params.id);
    return row;
  });
  publishDashboardChange(
    dashboard.id,
    { kind: "renamed", name: dashboard.name },
    { req }
  );
  publishList(req, dashboard.team_id, "renamed", dashboard.id);
  res.json(new ApiResponse(200, dashboard, "Dashboard updated"));
});

const deleteDashboard = asyncHandler(async (req, res) => {
  const {
    rows: [deleted],
  } = await req.db((db) =>
    db.query("DELETE FROM dashboards WHERE id = $1 RETURNING team_id", [
      req.params.id,
    ])
  );
  if (!deleted) throw new ApiError(404, "Not found");
  publishDashboardChange(req.params.id, { kind: "deleted" }, { req });
  publishList(req, deleted.team_id, "deleted", req.params.id);
  res.json(new ApiResponse(200, null, "Dashboard deleted"));
});

const addWidget = asyncHandler(async (req, res) => {
  const w = widgetSchema.parse(req.body);
  // Ownership columns are copied from the dashboard, so a widget can't be planted in another team.
  const {
    rows: [widget],
  } = await req.db((db) =>
    db.query(
      `INSERT INTO widgets (dashboard_id, org_id, team_id, type, metric, kpi, title, x, y, w, h, config)
       SELECT id, org_id, team_id, $2, $3, $10, $4, $5, $6, $7, $8, $9 FROM dashboards WHERE id = $1
       RETURNING id, dashboard_id, type, metric, kpi, title, x, y, w, h, config, version, updated_at`,
      [
        req.params.id,
        w.type,
        w.metric ?? null,
        w.title,
        w.x,
        w.y,
        w.w,
        w.h,
        w.config,
        w.kpi ?? null,
      ]
    )
  );
  if (!widget) throw new ApiError(404, "Dashboard not found");
  publishDashboardChange(
    widget.dashboard_id,
    { kind: "widget_added", widget_ids: [widget.id] },
    { req }
  );
  res.status(201).json(new ApiResponse(201, widget, "Widget added"));
});

const updateWidget = asyncHandler(async (req, res) => {
  const w = widgetUpdateSchema.parse(req.body);
  const widget = await req.db(async (db) => {
    const {
      rows: [row],
    } = await db.query(
      `UPDATE widgets SET type = coalesce($3, type),
              -- switching source clears the other one, keeping exactly one (widgets_one_source)
              metric = CASE WHEN $11::text IS NOT NULL THEN NULL ELSE coalesce($4, metric) END,
              kpi = CASE WHEN $4::metric_name IS NOT NULL THEN NULL ELSE coalesce($11, kpi) END,
              title = coalesce($5, title),
              x = coalesce($6, x), y = coalesce($7, y), w = coalesce($8, w), h = coalesce($9, h),
              config = coalesce($10, config)
       WHERE id = $1 AND version = $2
       RETURNING id, dashboard_id, type, metric, kpi, title, x, y, w, h, config, version, updated_at`,
      [
        req.params.id,
        w.version,
        w.type,
        w.metric,
        w.title,
        w.x,
        w.y,
        w.w,
        w.h,
        w.config,
        w.kpi,
      ]
    );
    if (!row) throw await missingOrStale(db, "widgets", req.params.id);
    return row;
  });
  publishDashboardChange(
    widget.dashboard_id,
    { kind: "widget_updated", widget_ids: [widget.id] },
    { req }
  );
  res.json(new ApiResponse(200, widget, "Widget updated"));
});

const deleteWidget = asyncHandler(async (req, res) => {
  const {
    rows: [deleted],
  } = await req.db((db) =>
    db.query("DELETE FROM widgets WHERE id = $1 RETURNING dashboard_id", [
      req.params.id,
    ])
  );
  if (!deleted) throw new ApiError(404, "Not found");
  publishDashboardChange(
    deleted.dashboard_id,
    { kind: "widget_removed", widget_ids: [req.params.id] },
    { req }
  );
  res.json(new ApiResponse(200, null, "Widget deleted"));
});

// One request after a drag/resize: all positions applied atomically, or none.
// Positions are last-write-wins (no version check); content edits go through updateWidget.
const saveLayout = asyncHandler(async (req, res) => {
  const { items } = layoutSchema.parse(req.body);
  const widgets = await req.db(async (db) => {
    const { rows } = await db.query(
      `UPDATE widgets w SET x = i.x, y = i.y, w = i.w, h = i.h
       FROM jsonb_to_recordset($2) AS i(id uuid, x int, y int, w int, h int)
       WHERE w.id = i.id AND w.dashboard_id = $1
       RETURNING w.id, w.x, w.y, w.w, w.h, w.version`,
      [req.params.id, JSON.stringify(items)]
    );
    if (rows.length !== items.length) {
      throw new ApiError(
        404,
        "One or more widgets not found on this dashboard"
      );
    }
    return rows;
  });
  publishDashboardChange(
    req.params.id,
    { kind: "layout", widget_ids: widgets.map((w) => w.id) },
    { req }
  );
  res.json(new ApiResponse(200, widgets, "Layout saved"));
});

export {
  addWidget,
  createDashboard,
  deleteDashboard,
  deleteWidget,
  getDashboard,
  listDashboards,
  renameDashboard,
  saveLayout,
  updateWidget,
};
