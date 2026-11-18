import { z } from "zod";
import { ApiResponse } from "../utils/ApiResponse.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import { checkCheckpoints } from "../utils/audit-checkpoints.js";
import { audit } from "../utils/audit.js";

// Tier 3 B: reading the trail. RLS shows the Super Admin the whole org and an Admin their own
// team; reading the log is itself recorded (OWASP: monitor access to the logs).
// E19 (Prompt 53): entries older than AUDIT_HOT_DAYS live in compressed segments. A page is
// filled from the live rows first, then from the archive (always older), so paging is
// seamless. `next_before` is the cursor for the next page (null when nothing older matches).
const listSchema = z.object({
  actor_id: z.uuid().optional(),
  action: z
    .string()
    .regex(/^[a-z_]+(\.[a-z_]*)?$/)
    .optional(),
  team_id: z.uuid().optional(),
  result: z.enum(["allowed", "denied", "failed"]).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  before: z.coerce.number().int().positive().optional(), // keyset paging on seq
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

const COLUMNS = `seq, team_id, actor_id, actor_name, action, target_type, target_id, result,
  ip, user_agent, meta, at`;

const listAudit = asyncHandler(async (req, res) => {
  const q = listSchema.parse(req.query);
  const filters = [
    q.actor_id ?? null,
    q.action ?? null,
    q.team_id ?? null,
    q.result ?? null,
    q.from ?? null,
    q.to ?? null,
  ];
  const page = await req.db(async (db) => {
    const { rows: live } = await db.query(
      `SELECT ${COLUMNS} FROM audit_log
       WHERE ($1::uuid IS NULL OR actor_id = $1)
         AND ($2::text IS NULL OR action LIKE $2 || '%')
         AND ($3::uuid IS NULL OR team_id = $3)
         AND ($4::text IS NULL OR result = $4)
         AND ($5::timestamptz IS NULL OR at >= $5)
         AND ($6::timestamptz IS NULL OR at < $6)
         AND ($7::bigint IS NULL OR seq < $7)
       ORDER BY seq DESC LIMIT $8`,
      [...filters, q.before ?? null, q.limit]
    );
    let entries = live;
    let resume = null;
    if (live.length < q.limit) {
      const { rows } = await db.query(
        "SELECT * FROM app.audit_archive_page($1, $2, $3, $4, $5, $6, $7, $8)",
        [
          live.length ? live[live.length - 1].seq : (q.before ?? null),
          q.limit - live.length,
          ...filters,
        ]
      );
      const archived = rows.filter((r) => r.entry).map((r) => r.entry);
      resume = rows.find((r) => r.resume_before)?.resume_before ?? null;
      entries = [...live, ...archived].slice(0, q.limit);
    }
    await audit(db, req, "audit.view", { meta: { filters: q } });
    return { entries, resume };
  });

  const { entries, resume } = page;
  const next_before =
    entries.length === q.limit
      ? Number(entries[entries.length - 1].seq)
      : resume === null
        ? null
        : Number(resume);
  res.json(
    new ApiResponse(200, {
      entries: entries.map((e) => ({ ...e, seq: Number(e.seq) })),
      next_before,
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
