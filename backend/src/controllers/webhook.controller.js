import { randomUUID } from "node:crypto";
import { z } from "zod";
import { WEBHOOK_EVENTS } from "../constants.js";
import { ApiError } from "../utils/ApiError.js";
import { ApiResponse } from "../utils/ApiResponse.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import { audit } from "../utils/audit.js";
import { seal } from "../utils/secret-box.js";
import { checkUrl, newSecret } from "../webhooks.js";

// Tier 3 C: webhook subscriptions, managed by team Admins and the Super Admin (RLS:
// webhooks_admin). The signing secret is returned once, on create and on rotate, like the
// one-time passwords; the app role can't read it back.
const url = z
  .string()
  .trim()
  .max(2000)
  .superRefine((value, ctx) => {
    try {
      checkUrl(value);
    } catch (err) {
      ctx.addIssue({ code: "custom", message: err.message });
    }
  });
const fields = {
  url,
  events: z
    .array(z.enum(WEBHOOK_EVENTS))
    .min(1)
    .transform((list) => [...new Set(list)]),
  description: z.string().trim().max(200).default(""),
  project_id: z.uuid().nullable().default(null),
};
const createSchema = z.strictObject({
  ...fields,
  team_id: z.uuid().optional(),
});
const updateSchema = z
  .strictObject({
    url,
    events: fields.events,
    description: z.string().trim().max(200),
    project_id: z.uuid().nullable(),
    enabled: z.boolean(),
  })
  .partial();
const listSchema = z.object({ team_id: z.uuid().optional() });
const deliveriesSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(30),
});

const COLUMNS = `id, team_id, project_id, url, description, events, enabled, failure_count,
  disabled_reason, created_by, created_at`;

const listWebhooks = asyncHandler(async (req, res) => {
  const { team_id } = listSchema.parse(req.query);
  const { rows } = await req.db((db) =>
    db.query(
      `SELECT ${COLUMNS},
              (SELECT d.status FROM webhook_deliveries d WHERE d.webhook_id = w.id
               ORDER BY d.created_at DESC LIMIT 1) AS last_status
       FROM webhooks w WHERE $1::uuid IS NULL OR team_id = $1 ORDER BY created_at`,
      [team_id ?? null]
    )
  );
  res.json(new ApiResponse(200, rows));
});

const createWebhook = asyncHandler(async (req, res) => {
  const body = createSchema.parse(req.body);
  const teamId = req.auth.team_id ?? body.team_id;
  if (!teamId)
    throw new ApiError(
      400,
      "team_id is required for organization-wide sessions"
    );
  // Prompt 50: the secret is encrypted before it reaches the database, bound to this
  // webhook's id (chosen here for that reason). The plain value is returned once, below.
  const id = randomUUID();
  const secret = newSecret();
  const webhook = await req.db(async (db) => {
    const {
      rows: [row],
    } = await db.query(
      `INSERT INTO webhooks (org_id, team_id, project_id, url, description, events, secret, created_by, id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING ${COLUMNS}`,
      [
        req.auth.org_id,
        teamId,
        body.project_id,
        body.url,
        body.description,
        body.events,
        seal(secret, id),
        req.auth.user_id,
        id,
      ]
    );
    await audit(db, req, "webhook.create", {
      type: "webhook",
      id: row.id,
      teamId,
      meta: { url: row.url, events: row.events },
    });
    return row;
  });
  res
    .status(201)
    .json(
      new ApiResponse(
        201,
        { ...webhook, secret },
        "Webhook created; copy the secret now"
      )
    );
});

// Re-enabling clears the failure streak; it is the Admin saying the endpoint is fixed.
const updateWebhook = asyncHandler(async (req, res) => {
  const body = updateSchema.parse(req.body);
  const webhook = await req.db(async (db) => {
    const {
      rows: [row],
    } = await db.query(
      `UPDATE webhooks SET url = coalesce($2, url), events = coalesce($3, events),
              description = coalesce($4, description),
              project_id = CASE WHEN $5 THEN $6::uuid ELSE project_id END,
              enabled = coalesce($7, enabled),
              failure_count = CASE WHEN $7 THEN 0 ELSE failure_count END,
              disabled_reason = CASE WHEN $7 THEN NULL
                                     WHEN $7 = false THEN 'Disabled by an admin'
                                     ELSE disabled_reason END
       WHERE id = $1 RETURNING ${COLUMNS}`,
      [
        req.params.id,
        body.url ?? null,
        body.events ?? null,
        body.description ?? null,
        "project_id" in body,
        body.project_id ?? null,
        body.enabled ?? null,
      ]
    );
    if (!row) throw new ApiError(404, "Not found");
    await audit(db, req, "webhook.update", {
      type: "webhook",
      id: row.id,
      teamId: row.team_id,
      meta: body,
    });
    return row;
  });
  res.json(new ApiResponse(200, webhook, "Webhook updated"));
});

const deleteWebhook = asyncHandler(async (req, res) => {
  await req.db(async (db) => {
    const {
      rows: [row],
    } = await db.query(
      "DELETE FROM webhooks WHERE id = $1 RETURNING id, team_id, url",
      [req.params.id]
    );
    if (!row) throw new ApiError(404, "Not found");
    await audit(db, req, "webhook.delete", {
      type: "webhook",
      id: row.id,
      teamId: row.team_id,
      meta: { url: row.url },
    });
  });
  res.json(new ApiResponse(200, null, "Webhook deleted"));
});

// The old secret keeps signing for 24 h alongside the new one (see migration 009).
const rotateSecret = asyncHandler(async (req, res) => {
  const secret = newSecret();
  await req.db(async (db) => {
    const {
      rows: [{ ok }],
    } = await db.query("SELECT app.rotate_webhook_secret($1, $2) AS ok", [
      req.params.id,
      seal(secret, req.params.id),
    ]);
    if (!ok) throw new ApiError(404, "Not found");
    const {
      rows: [hook],
    } = await db.query("SELECT team_id FROM webhooks WHERE id = $1", [
      req.params.id,
    ]);
    await audit(db, req, "webhook.rotate_secret", {
      type: "webhook",
      id: req.params.id,
      teamId: hook.team_id,
    });
  });
  res.json(
    new ApiResponse(
      200,
      { secret },
      "Secret rotated; the previous one stays valid for 24 hours"
    )
  );
});

// Queues a "webhook.test" message for this endpoint only (RLS: Admins may insert deliveries).
const testWebhook = asyncHandler(async (req, res) => {
  const delivery = await req.db(async (db) => {
    const {
      rows: [row],
    } = await db.query(
      `INSERT INTO webhook_deliveries (org_id, team_id, webhook_id, event_id, event, body)
       SELECT org_id, team_id, id, gen_random_uuid(), 'webhook.test',
              app.webhook_body('webhook.test', jsonb_build_object('webhook_id', id,
                'message', 'Test event from AAFM Analytics'))
       FROM webhooks WHERE id = $1
       RETURNING id, team_id, event_id, status`,
      [req.params.id]
    );
    if (!row) throw new ApiError(404, "Not found");
    await audit(db, req, "webhook.test", {
      type: "webhook",
      id: req.params.id,
      teamId: row.team_id,
    });
    const { team_id, ...delivery } = row;
    return delivery;
  });
  res.status(202).json(new ApiResponse(202, delivery, "Test event queued"));
});

const listDeliveries = asyncHandler(async (req, res) => {
  const { limit } = deliveriesSchema.parse(req.query);
  const { rows } = await req.db((db) =>
    db.query(
      `SELECT id, event_id, event, status, attempt, next_attempt_at, response_code, last_error,
              created_at, delivered_at, body
       FROM webhook_deliveries WHERE webhook_id = $1 ORDER BY created_at DESC LIMIT $2`,
      [req.params.id, limit]
    )
  );
  res.json(new ApiResponse(200, rows));
});

// Sends the same message again (same webhook-id, so receivers can still dedupe).
const redeliver = asyncHandler(async (req, res) => {
  const delivery = await req.db(async (db) => {
    const {
      rows: [row],
    } = await db.query(
      `INSERT INTO webhook_deliveries (org_id, team_id, webhook_id, event_id, event, body)
       SELECT org_id, team_id, webhook_id, event_id, event, body
       FROM webhook_deliveries WHERE id = $1
       RETURNING id, team_id, webhook_id, event_id, status`,
      [req.params.id]
    );
    if (!row) throw new ApiError(404, "Not found");
    await audit(db, req, "webhook.redeliver", {
      type: "webhook",
      id: row.webhook_id,
      teamId: row.team_id,
      meta: { event_id: row.event_id },
    });
    const { team_id, ...delivery } = row;
    return delivery;
  });
  res.status(202).json(new ApiResponse(202, delivery, "Redelivery queued"));
});

export {
  createWebhook,
  deleteWebhook,
  listDeliveries,
  listWebhooks,
  redeliver,
  rotateSecret,
  testWebhook,
  updateWebhook,
};
