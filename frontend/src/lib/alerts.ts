"use client";

import { useSocketEvent } from "./realtime";
import type { Alert } from "./types";
import { useApi } from "./use-api";

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
