"use client";

import { useSocketEvent } from "./realtime";
import { type Alert, METRIC_LABEL } from "./types";
import { useApi } from "./use-api";

/**
 * Plain words instead of the statistic (Prompt 68): "Errors unusually high · 3.1× usual".
 * The rule behind it is unchanged (2σ against the last hour); people just don't need the σ.
 */
export const describeAlert = (
  a: Pick<Alert, "metric" | "direction" | "value" | "mean">
) => {
  const ratio = a.mean > 0 ? a.value / a.mean : null;
  const size =
    ratio === null
      ? ""
      : a.direction === "above"
        ? ` · ${ratio.toFixed(1)}× usual`
        : ` · ${Math.round(ratio * 100)}% of usual`;
  return `${METRIC_LABEL[a.metric]} unusually ${a.direction === "above" ? "high" : "low"}${size}`;
};

const clock = (iso: string) =>
  new Date(iso).toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });

/** "Alert: Errors unusually high · 3.1× usual, 13:05–13:20 (resolved)" for chart hover text. */
export const alertSummary = (a: Alert) =>
  `Alert: ${describeAlert(a)}, ${clock(a.opened_at)}–${a.resolved_at ? `${clock(a.resolved_at)} (resolved)` : "now (still open)"}`;

export type AlertEvent = {
  team_id: string;
  action: "opened" | "resolved";
  alert: Alert;
};

/**
 * Tier 2 D: this session's anomaly alerts (RLS-scoped on the server: a team sees its own,
 * the Super Admin the whole org), refreshed live whenever one opens or resolves.
 */
export function useAlerts() {
  const { data, reload } = useApi<Alert[]>("/alerts?status=all&limit=50");
  useSocketEvent<AlertEvent>("alerts:changed", () => reload());
  const alerts = data ?? [];
  return { alerts, open: alerts.filter((a) => a.status === "open") };
}
