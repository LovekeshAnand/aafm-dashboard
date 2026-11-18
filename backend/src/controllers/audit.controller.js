import { z } from "zod";
import { ApiResponse } from "../utils/ApiResponse.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import { checkCheckpoints } from "../utils/audit-checkpoints.js";
import { audit } from "../utils/audit.js";

// Tier 3 B: reading the trail. RLS shows the Super Admin the whole org and an Admin their own
// team; reading the log is itself recorded (OWASP: monitor access to the logs).
// E19 (Prompt 53): entries older than AUDIT_HOT_DAYS live in compressed segments; the search
// reads both, so every entry stays findable.
const ISSUES = ["denied", "failed"];
const listSchema = z.object({
  q: z.string().trim().max(100).optional(), // free-text search (F6)
  actor_id: z.uuid().optional(),
  action: z
    .string()
    .regex(/^[a-z_]+(\.[a-z_]*)?$/)
    .optional(),
  team_id: z.uuid().optional(),
  // "issues" = refused or failed (F6: filter by issues)
  result: z.enum(["allowed", "denied", "failed", "issues"]).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  sort: z.enum(["newest", "oldest", "issues"]).default("newest"),
  page: z.coerce.number().int().min(1).max(100_000).default(1),
  size: z.coerce.number().int().min(10).max(200).default(50),
  // Stable pages: pass back the `as_of` from page 1 (entries written later can't shift them).
  as_of: z.coerce.number().int().positive().optional(),
});

// F6 (Prompt 68): search, filters, sorting and numbered pages over live and archived entries
// (app.audit_search, migration 015, which applies the same visibility as the RLS policy).
const listAudit = asyncHandler(async (req, res) => {
  const q = listSchema.parse(req.query);
  const results = q.result === "issues" ? ISSUES : q.result ? [q.result] : null;
  const { rows } = await req.db(async (db) => {
    const found = await db.query(
      "SELECT * FROM app.audit_search($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)",
      [
        q.q || null,
        q.actor_id ?? null,
        q.action ?? null,
        q.team_id ?? null,
        results,
        q.from ?? null,
        q.to ?? null,
        q.sort,
        q.size,
        (q.page - 1) * q.size,
        q.as_of ?? null,
      ]
    );
    await audit(db, req, "audit.view", { meta: { filters: q } });
    return found;
  });
  const total = rows.length ? Number(rows[0].total) : 0;
  res.json(
    new ApiResponse(200, {
      entries: rows.map(({ entry }) => ({ ...entry, seq: Number(entry.seq) })),
      total,
      page: q.page,
      size: q.size,
      pages: Math.max(1, Math.ceil(total / q.size)),
      as_of: rows.length ? Number(rows[0].as_of) : (q.as_of ?? null),
    })
  );
});

// Two checks: the hash chain (archive + live) in the database, which catches edited or
// removed entries in the middle, and the signed checkpoints (problems-log #39), which catch
// deleted newest entries and forged checkpoints. The signature check runs here because the key
// is outside the database. first_broken is null when both pass.
const verifyAudit = asyncHandler(async (req, res) => {
  const { chain, checkpoints } = await req.db(async (db) => {
    const {
      rows: [chain],
    } = await db.query("SELECT * FROM app.audit_verify()");
    const { rows: checkpoints } = await db.query(
      "SELECT * FROM app.audit_checkpoint_status()"
    );
    return { chain, checkpoints };
  });
  const problem = checkCheckpoints(req.auth.org_id, checkpoints);
  const firstBroken =
    chain.first_broken !== null
      ? Number(chain.first_broken)
      : (problem?.seq ?? null);
  await req.db((db) =>
    audit(db, req, "audit.verify", { meta: { intact: firstBroken === null } })
  );
  res.json(
    new ApiResponse(200, {
      checked: Number(chain.checked),
      intact: firstBroken === null,
      first_broken: firstBroken,
      reason:
        chain.first_broken !== null
          ? "this entry doesn't match the hash chain (edited or removed)"
          : (problem?.reason ?? null),
      checkpoints: {
        checked: checkpoints.length,
        latest_seq: checkpoints[0] ? Number(checkpoints[0].seq) : null,
        latest_at: checkpoints[0]?.created_at ?? null,
      },
    })
  );
});

// How the trail is stored: live rows, archived entries and the archive's compression.
const auditStorage = asyncHandler(async (req, res) => {
  const {
    rows: [s],
  } = await req.db((db) => db.query("SELECT * FROM app.audit_storage()"));
  const raw = Number(s.archive_raw_bytes);
  const stored = Number(s.archive_stored_bytes);
  res.json(
    new ApiResponse(200, {
      live_entries: Number(s.live_entries),
      archived_entries: Number(s.archived_entries),
      segments: Number(s.segments),
      archive_raw_bytes: raw,
      archive_stored_bytes: stored,
      compression_ratio: stored ? Number((raw / stored).toFixed(1)) : null,
    })
  );
});

export { auditStorage, listAudit, verifyAudit };
