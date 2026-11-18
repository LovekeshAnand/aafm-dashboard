// Tier 3 B: append one audit entry inside the caller's transaction, so it commits or rolls
// back together with the change it describes. Actor and org come from the request context in
// the database (app.audit), never from arguments. `teamId` names the affected team when the
// caller is an org-wide Super Admin, so that team's Admins see the entry too.
const audit = (
  db,
  req,
  action,
  { type = null, id = null, result = "allowed", meta = {}, teamId = null } = {}
) =>
  db.query("SELECT app.audit($1, $2, $3, $4, $5, $6, $7, $8)", [
    action,
    type,
    id === null ? null : String(id),
    result,
    req.id ? { ...meta, request_id: req.id } : meta,
    req.ip,
    req.get("user-agent") ?? null,
    teamId,
  ]);

// Tier 3 C: queue a webhook event in the same transaction as the change (outbox).
const emitWebhook = (db, teamId, projectId, event, data) =>
  db.query("SELECT app.emit_webhook_event($1, $2, $3, $4)", [
    teamId,
    projectId,
    event,
    data,
  ]);

const actorOf = (req) => ({ id: req.auth.user_id, name: req.auth.name });

export { actorOf, audit, emitWebhook };
