// Mirrors the backend's snake_case JSON.
export type Role = "super_admin" | "admin" | "editor" | "viewer";
export type Metric = "revenue" | "page_views" | "clicks" | "errors" | "users";
export type WidgetType = "line" | "bar" | "stat";

export type Membership = {
  id: string;
  role: Role;
  team_id: string | null;
  team_name: string | null;
};

export type Me = {
  user: { id: string; name: string; email: string };
  must_change_password: boolean;
  active_membership: Membership | null;
  memberships: Membership[];
};

export type LoginResult = {
  must_change_password: boolean;
  active_membership_id: string | null;
  memberships: Membership[];
};

export type Team = { id: string; name: string; created_at: string };

export type Member = {
  id: string;
  role: Role;
  user_id: string;
  name: string;
  email: string;
  created_at: string;
};

// --- Tier 3 A: Org -> Team -> Project
export type Project = {
  id: string;
  team_id: string;
  name: string;
  created_at: string;
};

export type Dashboard = {
  id: string;
  team_id: string;
  project_id: string;
  name: string;
  version: number;
  created_by: string | null;
  created_at: string;
  updated_at: string;
};

export type Widget = {
  id: string;
  type: WidgetType;
  /** Exactly one of metric / kpi / custom_metric_id is set (Tier 2 C, Tier 3 D). */
  metric: Metric | null;
  kpi: Kpi | null;
  custom_metric_id: string | null;
  title: string;
  x: number;
  y: number;
  w: number;
  h: number;
  config: Record<string, unknown>;
  version: number;
};

/** value is null for a KPI bucket whose denominator is zero (drawn as a gap). */
export type Point = { t: string; value: number | null };
export type SummaryRow = { metric: Metric; current: number; previous: number };
export type KpiRow = {
  kpi: Kpi;
  current: number | null;
  previous: number | null;
};
export type CustomRow = Pick<CustomMetric, "id" | "name" | "unit"> & {
  current: number | null;
  previous: number | null;
};
export type Summary = {
  metrics: SummaryRow[];
  kpis: KpiRow[];
  custom: CustomRow[];
};

// --- Tier 3 D: custom metric definitions (formulas over the base metrics, per team)
export type MetricUnit = "number" | "currency" | "percent";
export type CustomMetric = {
  id: string;
  team_id: string;
  name: string;
  formula: string;
  unit: MetricUnit;
  version: number;
  created_at: string;
  updated_at: string;
};
export const UNIT_LABEL: Record<MetricUnit, string> = {
  number: "Number",
  currency: "Currency ($)",
  percent: "Percent (%)",
};

// --- Tier 2 C: built-in KPIs (ratios of sums of two base metrics, computed on the server)
export type Kpi = "arpu" | "ctr" | "error_rate";
export const KPI_LABEL: Record<Kpi, string> = {
  arpu: "ARPU",
  ctr: "Click-through rate",
  error_rate: "Error rate",
};
/** The two base metrics each KPI divides (mirrors KPIS in backend/src/constants.js). */
export const KPI_METRICS: Record<Kpi, Metric[]> = {
  arpu: ["revenue", "users"],
  ctr: ["clicks", "page_views"],
  error_rate: ["errors", "page_views"],
};
export const KPI_FORMULA: Record<Kpi, string> = {
  arpu: "Revenue ÷ Active users",
  ctr: "Clicks ÷ Page views",
  error_rate: "Errors ÷ Page views",
};

/** What a widget or tile shows: a base metric, a KPI or a custom metric (Tier 3 D). */
export type Source =
  | { metric: Metric }
  | { kpi: Kpi }
  | { custom: Pick<CustomMetric, "id" | "name" | "unit"> };
export const sourceOf = (
  w: Pick<Widget, "metric" | "kpi" | "custom_metric_id">,
  customs: Pick<CustomMetric, "id" | "name" | "unit">[] = []
): Source =>
  w.custom_metric_id
    ? {
        custom: customs.find((c) => c.id === w.custom_metric_id) ?? {
          id: w.custom_metric_id,
          name: "Custom metric",
          unit: "number",
        },
      }
    : w.kpi
      ? { kpi: w.kpi }
      : { metric: w.metric as Metric };
export const sourceKey = (s: Source) =>
  "custom" in s ? s.custom.id : "kpi" in s ? s.kpi : s.metric;
export const sourceLabel = (s: Source) =>
  "custom" in s
    ? s.custom.name
    : "kpi" in s
      ? KPI_LABEL[s.kpi]
      : METRIC_LABEL[s.metric];
/** For errors and the error rate, going down is the good direction. */
export const lowerIsBetter = (s: Source) =>
  ("metric" in s && s.metric === "errors") ||
  ("kpi" in s && s.kpi === "error_rate");

// --- Tier 2 D: anomaly alerts
export type Alert = {
  id: string;
  team_id: string;
  project_id: string;
  metric: Metric;
  status: "open" | "resolved";
  direction: "above" | "below";
  value: number;
  mean: number;
  stddev: number;
  z: number;
  peak_z: number;
  opened_at: string;
  resolved_at: string | null;
};

export const EDITORS: Role[] = ["super_admin", "admin", "editor"];
export const ADMINS: Role[] = ["super_admin", "admin"];

export const ROLE_LABEL: Record<Role, string> = {
  super_admin: "Super Admin",
  admin: "Admin",
  editor: "Editor",
  viewer: "Viewer",
};

export const METRIC_LABEL: Record<Metric, string> = {
  revenue: "Revenue",
  page_views: "Page views",
  clicks: "Clicks",
  errors: "Errors",
  users: "Active users",
};

export const formatMetric = (metric: Metric, value: number) =>
  metric === "revenue"
    ? new Intl.NumberFormat("en-US", {
        style: "currency",
        currency: "USD",
        notation: "compact",
        maximumFractionDigits: 1,
      }).format(value)
    : new Intl.NumberFormat("en-US", {
        notation: "compact",
        maximumFractionDigits: 1,
      }).format(value);

const percent = new Intl.NumberFormat("en-US", {
  style: "percent",
  maximumFractionDigits: 2,
});
const currency = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 2,
});

export const formatKpi = (kpi: Kpi, value: number) =>
  kpi === "arpu" ? currency.format(value) : percent.format(value);

const compact = new Intl.NumberFormat("en-US", {
  notation: "compact",
  maximumFractionDigits: 2,
});

/** A custom metric's value is shown as-is in its unit ("percent" means the formula already
 * multiplied by 100). */
export const formatUnit = (unit: MetricUnit, value: number) =>
  unit === "currency"
    ? currency.format(value)
    : unit === "percent"
      ? `${compact.format(value)}%`
      : compact.format(value);

export const formatSource = (s: Source, value: number) =>
  "custom" in s
    ? formatUnit(s.custom.unit, value)
    : "kpi" in s
      ? formatKpi(s.kpi, value)
      : formatMetric(s.metric, value);

// --- Tier 3 B: audit log
export type AuditEntry = {
  seq: number;
  team_id: string | null;
  actor_id: string | null;
  actor_name: string | null;
  action: string;
  target_type: string | null;
  target_id: string | null;
  result: "allowed" | "denied" | "failed";
  ip: string | null;
  user_agent: string | null;
  meta: Record<string, unknown>;
  at: string;
};

// --- Tier 3 C: webhooks
export const WEBHOOK_EVENTS = [
  "alert.opened",
  "alert.resolved",
  "dashboard.created",
  "dashboard.updated",
  "dashboard.deleted",
  "member.added",
  "member.removed",
] as const;
export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];
export type Webhook = {
  id: string;
  team_id: string;
  project_id: string | null;
  url: string;
  description: string;
  events: WebhookEvent[];
  enabled: boolean;
  failure_count: number;
  disabled_reason: string | null;
  created_at: string;
  last_status: Delivery["status"] | null;
};
export type Delivery = {
  id: string;
  event_id: string;
  event: string;
  status: "pending" | "sending" | "delivered" | "failed";
  attempt: number;
  next_attempt_at: string;
  response_code: number | null;
  last_error: string | null;
  created_at: string;
  delivered_at: string | null;
  body: string;
};
