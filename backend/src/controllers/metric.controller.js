import { z } from "zod";
import { KPIS, METRICS } from "../constants.js";
import { ApiError } from "../utils/ApiError.js";
import { ApiResponse } from "../utils/ApiResponse.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import {
  evaluateFormula,
  FormulaError,
  formulaSql,
  metricsOf,
  parseFormula,
} from "../utils/formula.js";

const BUCKETS = { "5m": 5 * 60e3, "1h": 60 * 60e3, "1d": 24 * 60 * 60e3 };
const RANGES = {
  "1h": 60 * 60e3,
  "24h": 24 * 60 * 60e3,
  "7d": 7 * 24 * 60 * 60e3,
};
const MAX_RANGE_MS = 31 * 24 * 60 * 60e3;
const MAX_POINTS = 500;

// team_id only narrows an org-wide (super admin) session; RLS already pins team sessions.
// project_id (Tier 3 A) narrows to one project; without it a team's totals span its projects.
const scope = {
  team_id: z.uuid().optional(),
  project_id: z.uuid().optional(),
};
const range = {
  from: z.coerce.date(),
  to: z.coerce.date(),
  bucket: z.enum(Object.keys(BUCKETS)).default("1h"),
  ...scope,
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
const customSchema = withRangeLimits(z.object({ id: z.uuid(), ...range }));
const formulaSchema = withRangeLimits(
  z.object({ formula: z.string().max(200), ...range })
);
const summarySchema = z.object({
  range: z.enum(Object.keys(RANGES)).default("24h"),
  ...scope,
});

// Shared WHERE for every metric read: time range plus the optional team / project narrowing.
// Parameters $1..$5 are always bucket, from, to, team_id, project_id.
const rangeParams = (q) => [
  BUCKETS[q.bucket],
  q.from,
  q.to,
  q.team_id ?? null,
  q.project_id ?? null,
];
const RANGE_WHERE = `ts >= $2 AND ts < $3
  AND ($4::uuid IS NULL OR team_id = $4) AND ($5::uuid IS NULL OR project_id = $5)`;

/** One value per bucket for a formula tree (also used for the built-in KPIs). */
const formulaSeries = (req, q, tree) => {
  const params = rangeParams(q);
  const value = formulaSql(tree, params);
  params.push(metricsOf(tree));
  return req.db((db) =>
    db.query(
      `SELECT date_bin($1 * interval '1 millisecond', ts, $2) AS t, ${value} AS value
       FROM metric_points
       WHERE metric = ANY ($${params.length}::metric_name[]) AND ${RANGE_WHERE}
       GROUP BY 1 ORDER BY 1`,
      params
    )
  );
};

const series = asyncHandler(async (req, res) => {
  const q = seriesSchema.parse(req.query);
  const { rows } = await req.db((db) =>
    db.query(
      `SELECT date_bin($1 * interval '1 millisecond', ts, $2) AS t, sum(value) AS value
       FROM metric_points
       WHERE metric = $6 AND ${RANGE_WHERE}
       GROUP BY 1 ORDER BY 1`,
      [...rangeParams(q), q.metric]
    )
  );
  res.json(
    new ApiResponse(200, { metric: q.metric, bucket: q.bucket, points: rows })
  );
});

// Tier 2 C: a KPI is the formula "numerator / denominator", so each bucket is
// sum(numerator) / NULLIF(sum(denominator), 0) and an empty denominator is a gap (null).
const kpiTree = (kpi) => ({
  op: "/",
  left: { metric: KPIS[kpi].numerator },
  right: { metric: KPIS[kpi].denominator },
});

const kpiSeries = asyncHandler(async (req, res) => {
  const q = kpiSchema.parse(req.query);
  const { rows } = await formulaSeries(req, q, kpiTree(q.kpi));
  res.json(
    new ApiResponse(200, { kpi: q.kpi, bucket: q.bucket, points: rows })
  );
});

const parseOr400 = (formula) => {
  try {
    return parseFormula(formula);
  } catch (err) {
    if (!(err instanceof FormulaError)) throw err;
    throw new ApiError(400, err.message, [
      { field: "formula", message: err.message, position: err.position },
    ]);
  }
};

// Tier 3 D: a saved custom metric over time, always on its own team's data.
const customSeries = asyncHandler(async (req, res) => {
  const q = customSchema.parse(req.query);
  const {
    rows: [metric],
  } = await req.db((db) =>
    db.query("SELECT id, team_id, formula FROM custom_metrics WHERE id = $1", [
      q.id,
    ])
  );
  if (!metric) throw new ApiError(404, "Not found");
  const { rows } = await formulaSeries(
    req,
    { ...q, team_id: metric.team_id },
    parseOr400(metric.formula)
  );
  res.json(new ApiResponse(200, { id: q.id, bucket: q.bucket, points: rows }));
});

// Tier 3 D: validate and preview an unsaved formula (the editor's live check).
const formulaPreview = asyncHandler(async (req, res) => {
  const q = formulaSchema.parse(req.query);
  const { rows } = await formulaSeries(req, q, parseOr400(q.formula));
  res.json(new ApiResponse(200, { bucket: q.bucket, points: rows }));
});

/** KPI value for one period from the metric totals: ratio of sums, null when undefined. */
const kpiTotals = (rows) => {
  const totals = (key) =>
    Object.fromEntries(rows.map((r) => [r.metric, Number(r[key])]));
  const current = totals("current");
  const previous = totals("previous");
  return Object.keys(KPIS).map((kpi) => ({
    kpi,
    current: evaluateFormula(kpiTree(kpi), current),
    previous: evaluateFormula(kpiTree(kpi), previous),
  }));
};

// Totals for the range plus the previous range of equal length (stat widgets), the KPIs
// computed from those same totals, and, when one team is in view, its custom metrics.
const summary = asyncHandler(async (req, res) => {
  const q = summarySchema.parse(req.query);
  const teamId = req.auth.team_id ?? q.team_id ?? null;
  const [{ rows }, { rows: customs }] = await req.db((db) =>
    Promise.all([
      db.query(
        `SELECT metric,
                coalesce(sum(value) FILTER (WHERE ts > now() - $1 * interval '1 millisecond'), 0) AS current,
                coalesce(sum(value) FILTER (WHERE ts <= now() - $1 * interval '1 millisecond'), 0) AS previous
         FROM metric_points
         WHERE ts > now() - 2 * $1 * interval '1 millisecond'
           AND ($2::uuid IS NULL OR team_id = $2) AND ($3::uuid IS NULL OR project_id = $3)
         GROUP BY metric ORDER BY metric`,
        [RANGES[q.range], q.team_id ?? null, q.project_id ?? null]
      ),
      db.query(
        "SELECT id, name, unit, formula FROM custom_metrics WHERE team_id = $1 ORDER BY name",
        [teamId]
      ),
    ])
  );
  const totals = (key) =>
    Object.fromEntries(rows.map((r) => [r.metric, Number(r[key])]));
  const custom = customs.map(({ formula, ...m }) => {
    const tree = parseFormula(formula);
    return {
      ...m,
      current: evaluateFormula(tree, totals("current")),
      previous: evaluateFormula(tree, totals("previous")),
    };
  });
  res.json(
    new ApiResponse(200, {
      range: q.range,
      metrics: rows,
      kpis: kpiTotals(rows),
      custom,
    })
  );
});

export { customSeries, formulaPreview, kpiSeries, kpiTotals, series, summary };
