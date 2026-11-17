import { z } from "zod";
import { KPIS, METRICS } from "../constants.js";
import { ApiResponse } from "../utils/ApiResponse.js";
import { asyncHandler } from "../utils/asyncHandler.js";

const BUCKETS = { "5m": 5 * 60e3, "1h": 60 * 60e3, "1d": 24 * 60 * 60e3 };
const RANGES = {
  "1h": 60 * 60e3,
  "24h": 24 * 60 * 60e3,
  "7d": 7 * 24 * 60 * 60e3,
};
const MAX_RANGE_MS = 31 * 24 * 60 * 60e3;
const MAX_POINTS = 500;

// team_id only narrows an org-wide (super admin) session; RLS already pins team sessions.
const range = {
  from: z.coerce.date(),
  to: z.coerce.date(),
  bucket: z.enum(Object.keys(BUCKETS)).default("1h"),
  team_id: z.uuid().optional(),
};
const withRangeLimits = (schema) =>
  schema
    .refine(
      ({ from, to }) => from < to && to - from <= MAX_RANGE_MS,
      "Range must be positive and at most 31 days"
    )
    .refine(
      ({ from, to, bucket }) => (to - from) / BUCKETS[bucket] <= MAX_POINTS,
      `At most ${MAX_POINTS} buckets`
    );
const seriesSchema = withRangeLimits(
  z.object({ metric: z.enum(METRICS), ...range })
);
const kpiSchema = withRangeLimits(
  z.object({ kpi: z.enum(Object.keys(KPIS)), ...range })
);
const summarySchema = z.object({
  range: z.enum(Object.keys(RANGES)).default("24h"),
  team_id: z.uuid().optional(),
});

const series = asyncHandler(async (req, res) => {
  const q = seriesSchema.parse(req.query);
  const { rows } = await req.db((db) =>
    db.query(
      `SELECT date_bin($1 * interval '1 millisecond', ts, $2) AS t, sum(value) AS value
       FROM metric_points
       WHERE metric = $3 AND ts >= $2 AND ts < $4 AND ($5::uuid IS NULL OR team_id = $5)
       GROUP BY 1 ORDER BY 1`,
      [BUCKETS[q.bucket], q.from, q.metric, q.to, q.team_id ?? null]
    )
  );
  res.json(
    new ApiResponse(200, { metric: q.metric, bucket: q.bucket, points: rows })
  );
});

// Tier 2 C: a KPI over time. Both base metrics are read in one pass under RLS; each bucket
// is sum(numerator) / NULLIF(sum(denominator), 0), so an empty denominator is a gap (null).
const kpiSeries = asyncHandler(async (req, res) => {
  const q = kpiSchema.parse(req.query);
  const { numerator, denominator } = KPIS[q.kpi];
  const { rows } = await req.db((db) =>
    db.query(
      `SELECT date_bin($1 * interval '1 millisecond', ts, $2) AS t,
              sum(value) FILTER (WHERE metric = $5)
                / NULLIF(sum(value) FILTER (WHERE metric = $6), 0) AS value
       FROM metric_points
       WHERE metric IN ($5, $6) AND ts >= $2 AND ts < $3
         AND ($4::uuid IS NULL OR team_id = $4)
       GROUP BY 1 ORDER BY 1`,
      [
        BUCKETS[q.bucket],
        q.from,
        q.to,
        q.team_id ?? null,
        numerator,
        denominator,
      ]
    )
  );
  res.json(
    new ApiResponse(200, { kpi: q.kpi, bucket: q.bucket, points: rows })
  );
});

/** KPI value for one period from the metric totals: ratio of sums, null when undefined. */
const kpiTotals = (rows) => {
  const total = (metric, key) =>
    rows.find((r) => r.metric === metric)?.[key] ?? 0;
  const ratio = (num, den, key) =>
    total(den, key) ? total(num, key) / total(den, key) : null;
  return Object.entries(KPIS).map(([kpi, { numerator, denominator }]) => ({
    kpi,
    current: ratio(numerator, denominator, "current"),
    previous: ratio(numerator, denominator, "previous"),
  }));
};

// Totals for the range plus the previous range of equal length (stat widgets), and the
// KPIs computed from those same totals.
const summary = asyncHandler(async (req, res) => {
  const q = summarySchema.parse(req.query);
  const { rows } = await req.db((db) =>
    db.query(
      `SELECT metric,
              coalesce(sum(value) FILTER (WHERE ts > now() - $1 * interval '1 millisecond'), 0) AS current,
              coalesce(sum(value) FILTER (WHERE ts <= now() - $1 * interval '1 millisecond'), 0) AS previous
       FROM metric_points
       WHERE ts > now() - 2 * $1 * interval '1 millisecond' AND ($2::uuid IS NULL OR team_id = $2)
       GROUP BY metric ORDER BY metric`,
      [RANGES[q.range], q.team_id ?? null]
    )
  );
  res.json(
    new ApiResponse(200, {
      range: q.range,
      metrics: rows,
      kpis: kpiTotals(rows),
    })
  );
});

export { kpiSeries, kpiTotals, series, summary };
