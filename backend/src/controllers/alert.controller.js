import { z } from "zod";
import { ApiResponse } from "../utils/ApiResponse.js";
import { asyncHandler } from "../utils/asyncHandler.js";

// Tier 2 D: anomaly alerts are written only by app.detect_anomalies(); the app reads them
// under RLS (a team sees its own, the Super Admin sees the whole org).
const listSchema = z.object({
  status: z.enum(["open", "all"]).default("all"),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

const listAlerts = asyncHandler(async (req, res) => {
  const { status, limit } = listSchema.parse(req.query);
  const { rows } = await req.db((db) =>
    db.query(
      `SELECT id, team_id, metric, status, direction, value, mean, stddev, z, peak_z,
              opened_at, resolved_at
       FROM alerts
       WHERE $1 = 'all' OR status = 'open'
       ORDER BY status = 'open' DESC, opened_at DESC
       LIMIT $2`,
      [status, limit]
    )
  );
  res.json(new ApiResponse(200, rows));
});

export { listAlerts };
