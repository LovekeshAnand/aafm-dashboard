"use client";

import { Bell, ChevronDown, TrendingDown, TrendingUp, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { type AlertEvent, useAlerts } from "@/lib/alerts";
import { useSocketEvent } from "@/lib/realtime";
import { type Alert, METRIC_LABEL, type Team } from "@/lib/types";
import { useApi } from "@/lib/use-api";
import { cx, IconButton } from "./ui";

const ago = (iso: string) => {
  const min = Math.round((Date.now() - new Date(iso).getTime()) / 60e3);
  return min < 1
    ? "just now"
    : min < 60
      ? `${min} min ago`
      : `${Math.round(min / 60)} h ago`;
};

/** "Errors 4.2σ above normal" */
const describe = (a: Pick<Alert, "metric" | "direction" | "z">) =>
  `${METRIC_LABEL[a.metric]} ${Math.abs(a.z).toFixed(1)}σ ${a.direction} normal`;

function AlertRow({ alert, teamName }: { alert: Alert; teamName?: string }) {
  const open = alert.status === "open";
  const Icon = alert.direction === "above" ? TrendingUp : TrendingDown;
  return (
    <li className="flex gap-3 rounded-lg px-2 py-2">
      <span
        className={cx(
          "mt-0.5 grid size-7 shrink-0 place-items-center rounded-lg",
          open ? "bg-danger/15 text-danger" : "bg-white/5 text-ink-3"
        )}
      >
        <Icon size={14} />
      </span>
      <span className="min-w-0 flex-1 text-xs leading-snug">
        <span
          className={cx("block font-medium", open ? "text-ink" : "text-ink-2")}
        >
          {describe(alert)}
        </span>
        <span className="text-ink-3">
          {teamName && `${teamName} · `}
          {open
            ? `open · ${ago(alert.opened_at)}`
            : `resolved · ${ago(alert.resolved_at!)}`}
        </span>
      </span>
    </li>
  );
}

/**
 * Tier 2 D, in-dashboard only (Prompt 38): a bell with the open-alert count and a list of
 * recent anomalies, live via the team channel.
 */
export function AlertsPanel({ orgWide }: { orgWide: boolean }) {
  const { alerts, open } = useAlerts();
  const teams = useApi<Team[]>(orgWide ? "/teams" : null);
  const [expanded, setExpanded] = useState(false);
  const teamName = (id: string) =>
    orgWide ? teams.data?.find((t) => t.id === id)?.name : undefined;

  return (
    <section className="mt-6">
      <button
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        className="flex w-full items-center gap-3 rounded-xl px-4 py-2.5 text-sm text-ink-2 transition hover:bg-glass-strong hover:text-ink"
      >
        <span className="relative">
          <Bell size={18} />
          {open.length > 0 && (
            <span className="absolute -top-1.5 -right-1.5 grid min-w-4 place-items-center rounded-full bg-danger px-1 text-[10px] font-semibold text-black">
              {open.length}
            </span>
          )}
        </span>
        <span className="flex-1 text-left">Alerts</span>
        <ChevronDown
          size={16}
          className={cx("transition", expanded && "rotate-180")}
        />
      </button>
      {expanded && (
        <div className="mt-1 max-h-72 overflow-y-auto rounded-xl border border-white/10 bg-black/60 p-1">
          {alerts.length ? (
            <ul aria-label="Anomaly alerts">
              {alerts.slice(0, 20).map((a) => (
                <AlertRow key={a.id} alert={a} teamName={teamName(a.team_id)} />
              ))}
            </ul>
          ) : (
            <p className="px-3 py-4 text-xs text-ink-3">
              No anomalies. Every metric is checked every 30 s against its last
              hour (2σ rule).
            </p>
          )}
        </div>
      )}
    </section>
  );
}

/** A toast in the corner whenever an anomaly opens; dismissable, gone after 8 s. */
export function AlertToaster() {
  const [toasts, setToasts] = useState<Alert[]>([]);
  const timers = useRef(new Map<string, number>());
  useEffect(() => {
    const pending = timers.current;
    return () => pending.forEach((t) => window.clearTimeout(t));
  }, []);

  const dismiss = (id: string) =>
    setToasts((all) => all.filter((t) => t.id !== id));
  useSocketEvent<AlertEvent>("alerts:changed", ({ action, alert }) => {
    if (action !== "opened") return;
    setToasts((all) => [alert, ...all].slice(0, 3));
    timers.current.set(
      alert.id,
      window.setTimeout(() => dismiss(alert.id), 8000)
    );
  });

  return (
    <div
      className="pointer-events-none fixed right-4 bottom-4 z-50 grid w-80 gap-2"
      aria-live="polite"
    >
      {toasts.map((t) => (
        <div
          key={t.id}
          role="alert"
          className="pointer-events-auto flex items-start gap-3 rounded-xl border border-danger/40 bg-black px-4 py-3 shadow-[0_20px_50px_-20px_rgb(0_0_0/0.8)]"
        >
          <span className="mt-0.5 size-2 shrink-0 animate-pulse rounded-full bg-danger" />
          <span className="min-w-0 flex-1 text-sm">
            <span className="block font-semibold">Anomaly detected</span>
            <span className="text-ink-2">{describe(t)}</span>
          </span>
          <IconButton
            label="Dismiss"
            onClick={() => dismiss(t.id)}
            className="-mt-1 -mr-2 size-7"
          >
            <X size={14} />
          </IconButton>
        </div>
      ))}
    </div>
  );
}
