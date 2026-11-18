import { z } from "zod";
import { KPIS, METRICS } from "../constants.js";
import { ApiError } from "../utils/ApiError.js";
import { ApiResponse } from "../utils/ApiResponse.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import { audit } from "../utils/audit.js";
import { deliver, notify } from "../utils/notify.js";

// Feature F7 (Prompts 68-69): ask another team for one figure ("ARPU of Finance"), approve or
// decline with an expiry, and read only that figure while the grant lasts (migration 017).
const LABEL = {
  revenue: "Revenue",
  page_views: "Page views",
  clicks: "Clicks",
  errors: "Errors",
  users: "Active users",
  arpu: "ARPU",
  ctr: "Click-through rate",
  error_rate: "Error rate",
};
const DAYS = [1, 7, 30, 90];

const requestSchema = z
  .strictObject({
    team_id: z.uuid(),
    kind: z.enum(["metric", "kpi"]),
    source: z.string(),
    reason: z.string().trim().min(3).max(500),
    days: z.coerce
      .number()
      .int()
      .refine((d) => DAYS.includes(d), "1, 7, 30 or 90 days"),
  })
  .refine(
    (b) =>
      b.kind === "metric"
        ? METRICS.includes(b.source)
        : Object.keys(KPIS).includes(b.source),
    { message: "Unknown metric or KPI", path: ["source"] }
  );
const decideSchema = z.strictObject({
  approve: z.boolean(),
  days: z.coerce
    .number()
    .int()
    .refine((d) => DAYS.includes(d), "1, 7, 30 or 90 days")
    .optional(),
  note: z.string().trim().max(500).optional(),
});
const listSchema = z.object({
  box: z.enum(["mine", "incoming"]).default("mine"),
});

const COLUMNS = `id, requester_id, requester_name, target_team_id, source_kind, source, reason, days,
  status, decided_at, decision_note, expires_at, created_at`;

const directory = asyncHandler(async (req, res) => {
  const { rows } = await req.db((db) =>
    db.query("SELECT * FROM app.team_directory()")
  );
  res.json(new ApiResponse(200, rows));
});

const listRequests = asyncHandler(async (req, res) => {
  const { box } = listSchema.parse(req.query);
  const { rows } = await req.db((db) =>
    db.query(
      `SELECT ${COLUMNS}, (status = 'approved' AND expires_at > now()) AS active,
              (SELECT name FROM app.team_directory() d WHERE d.id = target_team_id) AS team_name
       FROM access_requests
       WHERE CASE WHEN $1 = 'mine' THEN requester_id = app.current_user_id()
                  ELSE requester_id <> app.current_user_id() END
       ORDER BY status = 'pending' DESC, created_at DESC
       LIMIT 100`,
      [box]
    )
  );
  res.json(new ApiResponse(200, rows));
});

const createRequest = asyncHandler(async (req, res) => {
  const body = requestSchema.parse(req.body);
  const { request, notes } = await req.db(async (db) => {
    const {
      rows: [created],
    } = await db.query("SELECT * FROM app.request_access($1, $2, $3, $4, $5)", [
      body.team_id,
      body.kind,
      body.source,
      body.reason,
      body.days,
    ]);
    await audit(db, req, "access.request", {
      type: "access_request",
      id: created.request_id,
      teamId: body.team_id,
      meta: { source: body.source, days: body.days },
    });
    const notes = await Promise.all(
      created.approver_ids.map((userId) =>
        notify(
          db,
          userId,
          "access_requested",
          `${req.auth.name} asks to see ${LABEL[body.source]} of ${created.team_name}`,
          {
            body: `For ${body.days} day${body.days > 1 ? "s" : ""}: “${body.reason}”`,
            link: "/shared",
            meta: { request_id: created.request_id },
          }
        )
      )
    );
    return { request: { id: created.request_id }, notes };
  });
  deliver(notes);
  res.status(201).json(new ApiResponse(201, request, "Request sent"));
});

const decide = asyncHandler(async (req, res) => {
  const body = decideSchema.parse(req.body);
  const { row, note } = await req.db(async (db) => {
    const {
      rows: [row],
    } = await db.query(
      `UPDATE access_requests
       SET status = CASE WHEN $2 THEN 'approved' ELSE 'declined' END,
           expires_at = CASE WHEN $2 THEN now() + coalesce($3, days) * interval '1 day' END,
           decided_by = app.current_user_id(), decided_at = now(), decision_note = $4
       WHERE id = $1 AND status = 'pending'
       RETURNING ${COLUMNS}`,
      [req.params.id, body.approve, body.days ?? null, body.note || null]
    );
    if (!row) throw new ApiError(404, "No pending request found");
    if (row.requester_id === req.auth.user_id)
      throw new ApiError(403, "You can't decide your own request");
    await audit(db, req, body.approve ? "access.approve" : "access.decline", {
      type: "access_request",
      id: row.id,
      teamId: row.target_team_id,
      meta: {
        requester: row.requester_name,
        source: row.source,
        until: row.expires_at,
      },
    });
    const team = (
      await db.query("SELECT name FROM app.team_directory() WHERE id = $1", [
        row.target_team_id,
      ])
    ).rows[0]?.name;
    const note = await notify(
      db,
      row.requester_id,
      body.approve ? "access_approved" : "access_declined",
      body.approve
        ? `You can now see ${LABEL[row.source]} of ${team}`
        : `Your request to see ${LABEL[row.source]} of ${team} was declined`,
      {
        body: body.approve
          ? `Until ${new Date(row.expires_at).toUTCString().slice(0, 16)}.${body.note ? ` “${body.note}”` : ""}`
          : body.note
            ? `“${body.note}”`
            : "",
        link: "/shared",
        meta: { request_id: row.id },
      }
    );
    return { row, note };
  });
  deliver([note]);
  res.json(new ApiResponse(200, row, body.approve ? "Approved" : "Declined"));
});

const revoke = asyncHandler(async (req, res) => {
  const { row, note } = await req.db(async (db) => {
    const {
      rows: [row],
    } = await db.query(
      `UPDATE access_requests SET status = 'revoked', expires_at = NULL,
              decided_by = app.current_user_id(), decided_at = now()
       WHERE id = $1 AND status = 'approved'
       RETURNING ${COLUMNS}`,
      [req.params.id]
    );
    if (!row) throw new ApiError(404, "No active grant found");
    await audit(db, req, "access.revoke", {
      type: "access_request",
      id: row.id,
      teamId: row.target_team_id,
      meta: { requester: row.requester_name, source: row.source },
    });
    const note = await notify(
      db,
      row.requester_id,
      "access_declined",
      `Your access to ${LABEL[row.source]} was ended`,
      {
        body: "An admin of that team ended it.",
        link: "/shared",
        meta: { request_id: row.id },
      }
    );
    return { row, note };
  });
  deliver([note]);
  res.json(new ApiResponse(200, row, "Access ended"));
});

// Reading a shared figure (named read, audited). The functions check the grant on every call.
const BUCKETS = { "5m": 5 * 60e3, "1h": 60 * 60e3, "1d": 24 * 60 * 60e3 };
const RANGES = {
  "1h": 60 * 60e3,
  "24h": 24 * 60 * 60e3,
  "7d": 7 * 24 * 60 * 60e3,
};
const seriesSchema = z
  .object({
    from: z.coerce.date(),
    to: z.coerce.date(),
    bucket: z.enum(Object.keys(BUCKETS)).default("1h"),
  })
  .refine(
    ({ from, to, bucket }) => from < to && (to - from) / BUCKETS[bucket] <= 500,
    "Range must be positive and at most 500 buckets"
  );
const summarySchema = z.object({
  range: z.enum(Object.keys(RANGES)).default("24h"),
});

const sharedSeries = asyncHandler(async (req, res) => {
  const q = seriesSchema.parse(req.query);
  const { rows } = await req.db(async (db) => {
    const result = await db.query(
      "SELECT * FROM app.shared_series($1, $2, $3, $4)",
      [req.params.id, q.from, q.to, BUCKETS[q.bucket]]
    );
    await audit(db, req, "shared.view", {
      type: "access_request",
      id: req.params.id,
    });
    return result;
  });
  res.json(new ApiResponse(200, { points: rows }));
});

const sharedSummary = asyncHandler(async (req, res) => {
  const { range } = summarySchema.parse(req.query);
  const {
    rows: [row],
  } = await req.db((db) =>
    db.query("SELECT * FROM app.shared_summary($1, $2)", [
      req.params.id,
      RANGES[range],
    ])
  );
  res.json(new ApiResponse(200, { range, ...row }));
});

export {
  createRequest,
  decide,
  directory,
  listRequests,
  revoke,
  sharedSeries,
  sharedSummary,
};
