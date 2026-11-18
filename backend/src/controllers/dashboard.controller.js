import { z } from "zod";
import { displayName } from "../utils/validation.js";
import { KPIS, METRICS, WIDGET_TYPES } from "../constants.js";
import { publishDashboardChange, publishTeamEvent } from "../realtime.js";
import { ApiError } from "../utils/ApiError.js";
import { ApiResponse } from "../utils/ApiResponse.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import { actorOf, audit, emitWebhook } from "../utils/audit.js";

// Tier 2 A: list-level changes go to the whole team channel so switchers update live (#25).
const publishList = (req, teamId, kind, dashboardId) =>
  publishTeamEvent(req.auth.org_id, teamId, "dashboards:changed", {
    kind,
    dashboard_id: dashboardId,
    actor: { user_id: req.auth.user_id, name: req.auth.name },
  });

// org_id / team_id are never read from the body for team sessions; RLS rejects anything
// outside the session's scope anyway.
const name = displayName(100);
const version = z.int().positive();
const grid = {
  x: z.int().min(0).max(11),
  y: z.int().min(0).max(1000),
  w: z.int().min(1).max(12),
  h: z.int().min(1).max(12),
};
// A widget shows exactly one source: a base metric, a built-in KPI (Tier 2 C) or a custom
// metric of its team (Tier 3 D).
const SOURCES = ["metric", "kpi", "custom_metric_id"];
const widgetFields = {
  type: z.enum(WIDGET_TYPES),
  metric: z.enum(METRICS),
  kpi: z.enum(Object.keys(KPIS)),
  custom_metric_id: z.uuid(),
  title: z.string().trim().max(100),
  config: z.record(z.string(), z.unknown()),
  ...grid,
};
const sourceCount = (w) => SOURCES.filter((s) => w[s] !== undefined).length;

const listSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
  project_id: z.uuid().optional(),
});
// Tier 3 A: a dashboard lives in a project. Without project_id it goes to the team's first
// project (team_id names the team for org-wide sessions, as in Tier 1).
const createSchema = z.strictObject({
  name,
  team_id: z.uuid().optional(),
  project_id: z.uuid().optional(),
});
const renameSchema = z.strictObject({ name, version });
const widgetSchema = z
  .strictObject({
    ...widgetFields,
    metric: widgetFields.metric.optional(),
    kpi: widgetFields.kpi.optional(),
    custom_metric_id: widgetFields.custom_metric_id.optional(),
    title: widgetFields.title.default(""),
    config: widgetFields.config.default({}),
  })
  .refine(
    (w) => sourceCount(w) === 1,
    "Choose exactly one of metric, kpi or custom_metric_id"
  );
const widgetUpdateSchema = z
  .strictObject(widgetFields)
  .partial()
  .extend({ version })
  .refine(
    (w) => sourceCount(w) <= 1,
    "Choose one of metric, kpi or custom_metric_id"
  );
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

const DASHBOARD_COLUMNS =
  "id, team_id, project_id, name, version, created_by, created_at, updated_at";
const WIDGET_COLUMNS =
  "id, dashboard_id, type, metric, kpi, custom_metric_id, title, x, y, w, h, config, version, updated_at";

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

// Tier 3 B + C: every dashboard change is audited and queued for "dashboard.*" webhooks in
// the same transaction. Layout drags are audited but not sent (too chatty for subscribers).
const recordChange = async (db, req, dashboardId, action, meta = {}) => {
  const {
    rows: [d],
  } = await db.query(
    "SELECT id, name, team_id, project_id FROM dashboards WHERE id = $1",
    [dashboardId]
  );
  if (!d) return;
  await audit(db, req, action, {
    type: "dashboard",
    id: d.id,
    teamId: d.team_id,
    meta,
  });
  if (action !== "layout.save")
    await emitWebhook(db, d.team_id, d.project_id, "dashboard.updated", {
      dashboard: d,
      change: action,
      actor: actorOf(req),
    });
};

const listDashboards = asyncHandler(async (req, res) => {
  const { limit, offset, project_id } = listSchema.parse(req.query);
  const { rows } = await req.db((db) =>
    db.query(
      `SELECT ${DASHBOARD_COLUMNS} FROM dashboards
       WHERE $3::uuid IS NULL OR project_id = $3
       ORDER BY updated_at DESC LIMIT $1 OFFSET $2`,
      [limit, offset, project_id ?? null]
    )
  );
  res.json(new ApiResponse(200, rows));
});

const createDashboard = asyncHandler(async (req, res) => {
  const body = createSchema.parse(req.body);
  const teamId = req.auth.team_id ?? body.team_id;
  if (!teamId && !body.project_id)
    throw new ApiError(
      400,
      "team_id or project_id is required for organization-wide sessions"
    );

  const dashboard = await req.db(async (db) => {
    // The project is read under RLS, so it must belong to a team the caller can see; the
    // dashboard takes its team from the project.
    const {
      rows: [row],
    } = await db.query(
      `INSERT INTO dashboards (org_id, team_id, project_id, name, created_by)
       SELECT p.org_id, p.team_id, p.id, $3, $4 FROM projects p
       WHERE ($1::uuid IS NULL OR p.team_id = $1) AND ($2::uuid IS NULL OR p.id = $2)
       ORDER BY p.created_at LIMIT 1
       RETURNING ${DASHBOARD_COLUMNS}`,
      [teamId ?? null, body.project_id ?? null, body.name, req.auth.user_id]
    );
    if (!row) throw new ApiError(404, "Project not found");
    await audit(db, req, "dashboard.create", {
      type: "dashboard",
      id: row.id,
      teamId: row.team_id,
      meta: { name: row.name },
    });
    await emitWebhook(db, row.team_id, row.project_id, "dashboard.created", {
      dashboard: {
        id: row.id,
        name: row.name,
        team_id: row.team_id,
        project_id: row.project_id,
      },
      actor: actorOf(req),
    });
    return row;
  });
  publishList(req, dashboard.team_id, "created", dashboard.id);
  res.status(201).json(new ApiResponse(201, dashboard, "Dashboard created"));
});

// Opening a dashboard is a "named read" (Prompt 48), so it is audited.
const getDashboard = asyncHandler(async (req, res) => {
  const dashboard = await req.db(async (db) => {
    const {
      rows: [row],
    } = await db.query(
      `SELECT ${DASHBOARD_COLUMNS},
              (SELECT completed_at FROM projects p WHERE p.id = dashboards.project_id) AS project_completed_at
       FROM dashboards WHERE id = $1`,
      [req.params.id]
    );
    if (!row) throw new ApiError(404, "Not found");
    const { rows: widgets } = await db.query(
      `SELECT ${WIDGET_COLUMNS} FROM widgets WHERE dashboard_id = $1 ORDER BY y, x`,
      [row.id]
    );
    await audit(db, req, "dashboard.view", {
      type: "dashboard",
      id: row.id,
      teamId: row.team_id,
    });
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
       RETURNING id, team_id, project_id, name, version, updated_at`,
      [req.params.id, body.version, body.name]
    );
    if (!row) throw await missingOrStale(db, "dashboards", req.params.id);
    await recordChange(db, req, row.id, "dashboard.rename", { name: row.name });
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
  const deleted = await req.db(async (db) => {
    const {
      rows: [row],
    } = await db.query(
      "DELETE FROM dashboards WHERE id = $1 RETURNING id, name, team_id, project_id",
      [req.params.id]
    );
    if (!row) throw new ApiError(404, "Not found");
    await audit(db, req, "dashboard.delete", {
      type: "dashboard",
      id: row.id,
      teamId: row.team_id,
      meta: { name: row.name },
    });
    await emitWebhook(db, row.team_id, row.project_id, "dashboard.deleted", {
      dashboard: row,
      actor: actorOf(req),
    });
    return row;
  });
  publishDashboardChange(req.params.id, { kind: "deleted" }, { req });
  publishList(req, deleted.team_id, "deleted", req.params.id);
  res.json(new ApiResponse(200, null, "Dashboard deleted"));
});

const addWidget = asyncHandler(async (req, res) => {
  const w = widgetSchema.parse(req.body);
  // Ownership columns are copied from the dashboard, so a widget can't be planted in another
  // team; the custom-metric FK also pins its metric to that same team.
  const widget = await req.db(async (db) => {
    const {
      rows: [row],
    } = await db.query(
      `INSERT INTO widgets (dashboard_id, org_id, team_id, type, metric, kpi, custom_metric_id,
                            title, x, y, w, h, config)
       SELECT id, org_id, team_id, $2, $3, $10, $11, $4, $5, $6, $7, $8, $9
       FROM dashboards WHERE id = $1
       RETURNING ${WIDGET_COLUMNS}`,
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
        w.custom_metric_id ?? null,
      ]
    );
    if (!row) throw new ApiError(404, "Dashboard not found");
    await recordChange(db, req, row.dashboard_id, "widget.add", {
      widget_id: row.id,
      title: row.title,
    });
    return row;
  });
  publishDashboardChange(
    widget.dashboard_id,
    { kind: "widget_added", widget_ids: [widget.id] },
    { req }
  );
  res.status(201).json(new ApiResponse(201, widget, "Widget added"));
});

const updateWidget = asyncHandler(async (req, res) => {
  const w = widgetUpdateSchema.parse(req.body);
  const switchSource = sourceCount(w) === 1;
  const widget = await req.db(async (db) => {
    const {
      rows: [row],
    } = await db.query(
      `UPDATE widgets SET type = coalesce($3, type),
              -- a new source replaces the old one, keeping exactly one (widgets_one_source)
              metric = CASE WHEN $12 THEN $4::metric_name ELSE metric END,
              kpi = CASE WHEN $12 THEN $11::text ELSE kpi END,
              custom_metric_id = CASE WHEN $12 THEN $13::uuid ELSE custom_metric_id END,
              title = coalesce($5, title),
              x = coalesce($6, x), y = coalesce($7, y), w = coalesce($8, w), h = coalesce($9, h),
              config = coalesce($10, config)
       WHERE id = $1 AND version = $2
       RETURNING ${WIDGET_COLUMNS}`,
      [
        req.params.id,
        w.version,
        w.type,
        w.metric ?? null,
        w.title,
        w.x,
        w.y,
        w.w,
        w.h,
        w.config,
        w.kpi ?? null,
        switchSource,
        w.custom_metric_id ?? null,
      ]
    );
    if (!row) throw await missingOrStale(db, "widgets", req.params.id);
    await recordChange(db, req, row.dashboard_id, "widget.update", {
      widget_id: row.id,
      title: row.title,
    });
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
  const deleted = await req.db(async (db) => {
    const {
      rows: [row],
    } = await db.query(
      "DELETE FROM widgets WHERE id = $1 RETURNING dashboard_id, title",
      [req.params.id]
    );
    if (!row) throw new ApiError(404, "Not found");
    await recordChange(db, req, row.dashboard_id, "widget.delete", {
      widget_id: req.params.id,
      title: row.title,
    });
    return row;
  });
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
    await recordChange(db, req, req.params.id, "layout.save", {
      widgets: rows.length,
    });
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
