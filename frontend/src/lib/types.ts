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

export type Dashboard = {
  id: string;
  team_id: string;
  name: string;
  version: number;
  created_by: string | null;
  created_at: string;
  updated_at: string;
};

export type Widget = {
  id: string;
  type: WidgetType;
  /** Exactly one of metric / kpi is set (Tier 2 C). */
  metric: Metric | null;
  kpi: Kpi | null;
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
export type Summary = { metrics: SummaryRow[]; kpis: KpiRow[] };

// --- Tier 2 C: built-in KPIs (ratios of sums of two base metrics, computed on the server)
export type Kpi = "arpu" | "ctr" | "error_rate";
export const KPI_LABEL: Record<Kpi, string> = {
  arpu: "ARPU",
  ctr: "Click-through rate",
  error_rate: "Error rate",
};
export const KPI_FORMULA: Record<Kpi, string> = {
  arpu: "Revenue ÷ Active users",
  ctr: "Clicks ÷ Page views",
  error_rate: "Errors ÷ Page views",
};

/** What a widget or tile shows: a base metric or a KPI. */
export type Source = { metric: Metric } | { kpi: Kpi };
export const sourceOf = (w: Pick<Widget, "metric" | "kpi">): Source =>
  w.kpi ? { kpi: w.kpi } : { metric: w.metric as Metric };
export const sourceKey = (s: Source) => ("kpi" in s ? s.kpi : s.metric);
export const sourceLabel = (s: Source) =>
  "kpi" in s ? KPI_LABEL[s.kpi] : METRIC_LABEL[s.metric];
/** For errors and the error rate, going down is the good direction. */
export const lowerIsBetter = (s: Source) =>
  ("metric" in s && s.metric === "errors") ||
  ("kpi" in s && s.kpi === "error_rate");

// --- Tier 2 D: anomaly alerts
export type Alert = {
  id: string;
  team_id: string;
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

export const formatSource = (s: Source, value: number) =>
  "kpi" in s ? formatKpi(s.kpi, value) : formatMetric(s.metric, value);
