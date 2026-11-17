// Mirrors the backend's snake_case JSON.
export type Role = "super_admin" | "admin" | "editor" | "viewer";
export type Metric = "revenue" | "page_views" | "clicks" | "errors";
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
  metric: Metric;
  title: string;
  x: number;
  y: number;
  w: number;
  h: number;
  config: Record<string, unknown>;
  version: number;
};

export type Point = { t: string; value: number };
export type SummaryRow = { metric: Metric; current: number; previous: number };

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
