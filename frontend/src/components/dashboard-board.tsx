"use client";

import {
  Check,
  TriangleAlert,
  GripVertical,
  Maximize2,
  Move,
  Pencil,
  Plus,
  RefreshCw,
  Trash2,
} from "lucide-react";
import { useRouter } from "next/navigation";
import {
  type FormEvent,
  type ReactNode,
  useEffect,
  useRef,
  useState,
} from "react";
import ReactGridLayout, {
  type Layout,
  useContainerWidth,
  verticalCompactor,
} from "react-grid-layout";
import "react-grid-layout/css/styles.css";
import { type ChartBand, SeriesChart, StatTile } from "@/components/charts";
import { useSession } from "@/components/session";
import {
  Button,
  cx,
  Field,
  IconButton,
  Input,
  Modal,
  Notice,
  Select,
  Spinner,
} from "@/components/ui";
import { api, ApiError, errorText } from "@/lib/api";
import { alertSummary, describeAlert, useAlerts } from "@/lib/alerts";
import {
  ADMINS,
  type CustomMetric,
  type Dashboard,
  EDITORS,
  type Kpi,
  KPI_FORMULA,
  KPI_LABEL,
  KPI_METRICS,
  METRIC_LABEL,
  type Metric,
  type Point,
  type Source,
  sourceLabel,
  sourceOf,
  type Summary,
  type Widget,
  type WidgetType,
} from "@/lib/types";
import {
  type DashboardChange,
  type LiveStatus,
  type PresenceUser,
  type MetricTick,
  useDashboardLive,
  useSocketEvent,
} from "@/lib/realtime";
import { useApi } from "@/lib/use-api";

// Range -> bucket keeps every chart well under the API's 500-point cap.
// `refreshMs` (problems-log #29): live ticks arrive every 5 s, but a chart only needs
// refetching as often as its view can visibly change. 1 h (5-minute buckets) follows every
// tick; 24 h and 7 d (hourly buckets) refresh every 30 s / 60 s, which cuts requests 6-12x.
const RANGES = {
  "1h": { ms: 3600e3, bucket: "5m", refreshMs: 5_000 },
  "24h": { ms: 86400e3, bucket: "1h", refreshMs: 30_000 },
  "7d": { ms: 7 * 86400e3, bucket: "1h", refreshMs: 60_000 },
} as const;
type Range = keyof typeof RANGES;
type Window = { range: Range; from: string; to: string };
const windowFor = (range: Range): Window => ({
  range,
  from: new Date(Date.now() - RANGES[range].ms).toISOString(),
  to: new Date().toISOString(),
});

type DashboardWithWidgets = Dashboard & {
  widgets: Widget[];
  project_completed_at: string | null;
};

/** The base metrics a widget's source reads: itself, a KPI's two, or a formula's names. */
const sourceMetrics = (source: Source, customs: CustomMetric[]): Metric[] =>
  "metric" in source
    ? [source.metric]
    : "kpi" in source
      ? KPI_METRICS[source.kpi]
      : (Object.keys(METRIC_LABEL) as Metric[]).filter((m) =>
          new RegExp(`\\b${m}\\b`).test(
            customs.find((c) => c.id === source.custom.id)?.formula ?? ""
          )
        );

// Graph widgets sit on solid black (Prompt 27), not frosted glass, so the data reads cleanly.
const WIDGET_CARD =
  "flex h-full flex-col overflow-hidden rounded-2xl border border-white/10 bg-black p-4 shadow-[inset_0_1px_0_rgb(255_255_255/0.05)]";

// Every widget reads its own dashboard's project (Tier 3 A).
function WidgetBody({
  widget,
  dashboard,
  customs,
  win,
  summary,
  bands,
}: {
  widget: Widget;
  dashboard: Dashboard;
  customs: CustomMetric[];
  win: Window;
  summary?: Summary;
  bands: ChartBand[];
}) {
  const source = sourceOf(widget, customs);
  const query = `from=${win.from}&to=${win.to}&bucket=${RANGES[win.range].bucket}&team_id=${dashboard.team_id}&project_id=${dashboard.project_id}`;
  const path =
    widget.type === "stat"
      ? null
      : "custom" in source
        ? `/metrics/custom?id=${source.custom.id}&${query}`
        : "kpi" in source
          ? `/metrics/kpi?kpi=${source.kpi}&${query}`
          : `/metrics/series?metric=${source.metric}&${query}`;
  const series = useApi<{ points: Point[] }>(path);

  if (widget.type === "stat") {
    const row =
      "custom" in source
        ? summary?.custom.find((r) => r.id === source.custom.id)
        : "kpi" in source
          ? summary?.kpis.find((r) => r.kpi === source.kpi)
          : summary?.metrics.find((r) => r.metric === source.metric);
    return row ? (
      <StatTile source={source} current={row.current} previous={row.previous} />
    ) : (
      <Spinner />
    );
  }
  if (series.error) return <Notice>{errorText(series.error)}</Notice>;
  if (!series.data) return <Spinner />;
  return (
    <SeriesChart
      points={series.data.points}
      source={source}
      kind={widget.type}
      bands={bands}
    />
  );
}

/** The API body for a widget's source: exactly one of metric, kpi, custom_metric_id. */
type SourceBody =
  { metric: Metric } | { kpi: Kpi } | { custom_metric_id: string };

function WidgetForm({
  initial,
  customs,
  onSubmit,
  onClose,
}: {
  initial?: Widget;
  customs: CustomMetric[];
  onSubmit: (
    v: { type: WidgetType; title: string } & SourceBody
  ) => Promise<void>;
  onClose: () => void;
}) {
  const [type, setType] = useState<WidgetType>(initial?.type ?? "line");
  // One select for every kind of source: "metric:revenue", "kpi:arpu", "custom:<id>".
  const [sourceValue, setSourceValue] = useState(() =>
    initial?.custom_metric_id
      ? `custom:${initial.custom_metric_id}`
      : initial?.kpi
        ? `kpi:${initial.kpi}`
        : `metric:${initial?.metric ?? "revenue"}`
  );
  const [title, setTitle] = useState(initial?.title ?? "");
  const [error, setError] = useState("");
  const [kind, key] = sourceValue.split(":");
  const custom = customs.find((c) => c.id === key);
  const source: Source =
    kind === "custom"
      ? { custom: custom ?? { id: key, name: "Custom metric", unit: "number" } }
      : kind === "kpi"
        ? { kpi: key as Kpi }
        : { metric: key as Metric };
  const body: SourceBody =
    kind === "custom"
      ? { custom_metric_id: key }
      : kind === "kpi"
        ? { kpi: key as Kpi }
        : { metric: key as Metric };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    try {
      await onSubmit({
        type,
        ...body,
        title: title.trim() || sourceLabel(source),
      });
      onClose();
    } catch (err) {
      setError(errorText(err));
    }
  };

  return (
    <form onSubmit={submit} className="grid gap-4">
      <Field
        label="Shows"
        hint={
          "kpi" in source
            ? `KPI: ${KPI_FORMULA[source.kpi]}`
            : custom
              ? `Custom: ${custom.formula}`
              : undefined
        }
      >
        <Select
          value={sourceValue}
          onChange={(e) => setSourceValue(e.target.value)}
        >
          <optgroup label="Metrics">
            {Object.entries(METRIC_LABEL).map(([value, label]) => (
              <option key={value} value={`metric:${value}`}>
                {label}
              </option>
            ))}
          </optgroup>
          <optgroup label="KPIs">
            {Object.entries(KPI_LABEL).map(([value, label]) => (
              <option key={value} value={`kpi:${value}`}>
                {label} ({KPI_FORMULA[value as Kpi]})
              </option>
            ))}
          </optgroup>
          {customs.length > 0 && (
            <optgroup label="Custom metrics">
              {customs.map((c) => (
                <option key={c.id} value={`custom:${c.id}`}>
                  {c.name} ({c.formula})
                </option>
              ))}
            </optgroup>
          )}
        </Select>
      </Field>
      <Field label="Visualization">
        <div className="grid grid-cols-3 gap-2">
          {(["line", "bar", "stat"] as const).map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setType(t)}
              aria-pressed={type === t}
              className={cx(
                "rounded-xl border px-3 py-2.5 text-sm capitalize transition",
                type === t
                  ? "border-accent/60 bg-accent/10 text-accent"
                  : "border-line text-ink-2 hover:bg-glass-strong"
              )}
            >
              {t === "stat" ? "Number" : t}
            </button>
          ))}
        </div>
      </Field>
      <Field label="Title" hint="Optional, defaults to the metric's name">
        <Input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          maxLength={100}
          placeholder={sourceLabel(source)}
        />
      </Field>
      <Notice>{error}</Notice>
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button type="submit">{initial ? "Save" : "Add widget"}</Button>
      </div>
    </form>
  );
}

function RenameForm({
  name,
  onSubmit,
  onClose,
}: {
  name: string;
  onSubmit: (name: string) => Promise<void>;
  onClose: () => void;
}) {
  const [value, setValue] = useState(name);
  return (
    <form
      onSubmit={async (e) => {
        e.preventDefault();
        await onSubmit(value);
        onClose();
      }}
      className="grid gap-4"
    >
      <Field label="Name">
        <Input
          value={value}
          onChange={(e) => setValue(e.target.value)}
          required
          maxLength={100}
          autoFocus
        />
      </Field>
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button type="submit">Save</Button>
      </div>
    </form>
  );
}

const CHANGE_VERB: Record<
  DashboardChange["kind"],
  (c: DashboardChange) => string
> = {
  renamed: (c) => `renamed this dashboard to “${c.name}”`,
  deleted: () => "deleted this dashboard",
  widget_added: () => "added a widget",
  widget_updated: () => "edited a widget",
  widget_removed: () => "removed a widget",
  layout: () => "rearranged the layout",
};

/** Live status dot plus everyone else on this dashboard (a ring marks who is editing). */
function PresenceBar({
  status,
  users,
}: {
  status: LiveStatus;
  users: PresenceUser[];
}) {
  const { user } = useSession();
  const others = users.filter((u) => u.user_id !== user.id);
  const label = {
    live: "Live",
    connecting: "Reconnecting…",
    offline: "Offline",
  }[status];
  return (
    <div className="flex h-10 items-center gap-3 rounded-xl border border-white/10 bg-black px-3">
      <span
        className="flex items-center gap-2 text-xs text-ink-2"
        role="status"
        title={
          status === "live"
            ? "Changes from others appear instantly"
            : "Live updates paused; your edits still save"
        }
      >
        <span
          aria-hidden
          className={cx(
            "size-2 rounded-full",
            status === "live" && "animate-pulse bg-[#4caf7d]",
            status === "connecting" && "bg-warn",
            status === "offline" && "bg-danger"
          )}
        />
        {label}
      </span>
      {others.length > 0 && (
        <ul
          className="flex -space-x-2"
          aria-label={`Also here: ${others.map((u) => `${u.name}${u.editing ? " (editing)" : ""}`).join(", ")}`}
        >
          {others.slice(0, 4).map((u) => (
            <li
              key={u.user_id}
              title={`${u.name}${u.editing ? " · editing" : " · viewing"}`}
              className={cx(
                "grid size-7 place-items-center rounded-full border-2 border-black bg-gradient-to-br from-ink to-accent text-[11px] font-semibold text-black",
                u.editing && "ring-2 ring-accent"
              )}
            >
              {u.name.slice(0, 1).toUpperCase()}
            </li>
          ))}
          {others.length > 4 && (
            <li className="grid size-7 place-items-center rounded-full border-2 border-black bg-white/15 text-[10px] text-ink">
              +{others.length - 4}
            </li>
          )}
        </ul>
      )}
    </div>
  );
}

/** On-screen help while Edit layout is on (Prompt 32): every editing gesture, in one row. */
function EditGuide({ canDelete }: { canDelete: boolean }) {
  const steps: [ReactNode, string][] = [
    [
      <GripVertical key="g" size={14} />,
      "Drag a widget by this handle to move it",
    ],
    [
      <Maximize2 key="r" size={14} />,
      "Drag a widget's bottom-right corner to resize it",
    ],
    [
      <Plus key="a" size={14} />,
      "Add widget picks a metric, KPI or custom metric and a chart type",
    ],
    [<Pencil key="p" size={14} />, "Change a widget's metric, chart or title"],
    [<Trash2 key="t" size={14} />, "Remove a widget"],
  ];
  return (
    <div
      role="note"
      aria-label="How to edit this dashboard"
      className="mb-4 rounded-2xl border border-accent/25 bg-black px-5 py-4"
    >
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-semibold">Editing layout</p>
        <p className="text-xs text-ink-3">
          Changes save automatically · press <b className="text-ink">Done</b> to
          finish
          {canDelete && " · Delete removes the whole dashboard"}
        </p>
      </div>
      <ul className="grid gap-2 text-xs text-ink-2 sm:grid-cols-2 xl:grid-cols-5">
        {steps.map(([icon, text]) => (
          <li key={text} className="flex items-center gap-2.5">
            <span className="grid size-7 shrink-0 place-items-center rounded-lg border border-white/10 bg-white/5 text-ink">
              {icon}
            </span>
            {text}
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * One dashboard: toolbar (name, time range, edit controls) and the widget grid.
 * `switcher` replaces the plain title (null hides it: the home page names the dashboard in
 * its folder tab, Prompt 71); `onChanged` lets the parent refresh its list after a rename or
 * delete.
 */
export function DashboardBoard({
  id,
  switcher,
  onChanged,
}: {
  id: string;
  switcher?: ReactNode;
  onChanged?: () => void;
}) {
  const router = useRouter();
  const { active_membership: active } = useSession();
  const {
    data: dashboard,
    error,
    reload,
  } = useApi<DashboardWithWidgets>(`/dashboards/${id}`);
  const [win, setWin] = useState<Window>(() => windowFor("24h"));
  const summary = useApi<Summary>(
    dashboard
      ? `/metrics/summary?range=${win.range}&team_id=${dashboard.team_id}&project_id=${dashboard.project_id}&at=${win.to}`
      : null
  );
  // Tier 3 D: the team's custom metrics, for widget labels and the "Shows" picker.
  const customMetrics = useApi<CustomMetric[]>(
    dashboard ? `/custom-metrics?team_id=${dashboard.team_id}` : null
  );
  const customs = customMetrics.data ?? [];
  // measureBeforeMount: never draw the grid at the hook's 1280px default (Prompt 28).
  const { width, containerRef, mounted } = useContainerWidth({
    measureBeforeMount: true,
  });
  const [editing, setEditing] = useState(false);
  const [modal, setModal] = useState<
    | { kind: "add" }
    | { kind: "edit"; widget: Widget }
    | { kind: "rename" }
    | null
  >(null);
  const [notice, setNotice] = useState<{
    tone: "error" | "success" | "info";
    text: string;
  } | null>(null);

  // F1: a completed project's dashboards are read-only (the database enforces it too).
  const completed = dashboard?.project_completed_at ?? null;
  const canEdit = !!active && EDITORS.includes(active.role) && !completed;
  const canDelete = !!active && ADMINS.includes(active.role) && !completed;

  // --- Real-time (Prompts 32-33) -------------------------------------------------------
  // Someone else's change: re-read the dashboard (under our own RLS), name who did what,
  // and briefly glow the widgets it touched. While we're mid-drag the refresh waits for
  // the drop, so a remote update never yanks a widget out from under the cursor.
  const dragging = useRef(false);
  const pendingReload = useRef(false);
  const [highlight, setHighlight] = useState<Set<string>>(new Set());
  const highlightTimer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(highlightTimer.current), []);

  const onRemoteChange = (change: DashboardChange) => {
    const who = change.actor?.name ?? "Someone";
    if (change.kind === "deleted") {
      onChanged?.();
      router.replace("/dashboards");
      return;
    }
    setNotice({
      tone: "info",
      text: `${who} ${CHANGE_VERB[change.kind](change)}`,
    });
    if (change.kind === "renamed") onChanged?.();
    if (dragging.current) pendingReload.current = true;
    else reload();
    if (change.widget_ids?.length) {
      setHighlight(new Set(change.widget_ids));
      window.clearTimeout(highlightTimer.current);
      highlightTimer.current = window.setTimeout(
        () => setHighlight(new Set()),
        1600
      );
    }
  };
  const live = useDashboardLive(id, onRemoteChange, editing);
  const { alerts } = useAlerts();

  // Tier 2 B: a new tick for this dashboard's team slides the time window to "now", so every
  // chart and number refetches its (server-aggregated) data. The previous data stays on
  // screen while the new one loads, so there is no flicker.
  // ponytail: one refetch per widget per tick (5 s); stream deltas instead if dashboards
  // grow to many widgets or many concurrent viewers.
  // Only ticks for this dashboard's project count, paced by the range (RANGES.refreshMs).
  const lastRefresh = useRef(0);
  useSocketEvent<MetricTick>("metrics:tick", (tick) => {
    if (
      !dashboard ||
      tick.team_id !== dashboard.team_id ||
      !tick.points.some((p) => p.project_id === dashboard.project_id) ||
      Date.now() - lastRefresh.current < RANGES[win.range].refreshMs
    )
      return;
    lastRefresh.current = Date.now();
    setWin((w) => windowFor(w.range));
  });

  const startInteraction = () => {
    dragging.current = true;
  };
  const endInteraction = () => {
    dragging.current = false;
    if (pendingReload.current) {
      pendingReload.current = false;
      reload();
    }
  };

  // A 409 means someone else saved first: show it and pull the fresh version.
  const run = async (action: () => Promise<unknown>, success?: string) => {
    try {
      await action();
      if (success) setNotice({ tone: "success", text: success });
    } catch (err) {
      setNotice({
        tone: "error",
        text:
          err instanceof ApiError && err.status === 409
            ? "Someone else changed this first. Showing the latest version."
            : errorText(err),
      });
    }
    reload();
  };

  // The measured <section> must exist from the very first render: useContainerWidth attaches
  // its ResizeObserver once on mount, so an early return without the ref left the grid at
  // the 1280px default and it overflowed the page (Prompt 28). Every branch renders the
  // same <section ref> root, so React keeps one DOM node across loading -> loaded.
  if (error || !dashboard) {
    return (
      <section ref={containerRef}>
        {error ? (
          <Notice>
            {error instanceof ApiError && error.status === 404
              ? "Dashboard not found, or it belongs to another team."
              : errorText(error)}
          </Notice>
        ) : (
          <Spinner />
        )}
      </section>
    );
  }

  const layout: Layout = dashboard.widgets.map((w) => ({
    i: w.id,
    x: w.x,
    y: w.y,
    w: w.w,
    h: w.h,
    minW: 2,
    minH: 2,
  }));

  const saveLayout = (next: Layout) => {
    const items = next.map(({ i, x, y, w, h }) => ({ id: i, x, y, w, h }));
    const changed = items.some((item) => {
      const old = dashboard.widgets.find((w) => w.id === item.id);
      return (
        !old ||
        old.x !== item.x ||
        old.y !== item.y ||
        old.w !== item.w ||
        old.h !== item.h
      );
    });
    if (changed) run(() => api(`/dashboards/${id}/layout`, "PUT", { items }));
  };

  return (
    <section ref={containerRef} aria-label={dashboard.name}>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          {switcher === undefined ? (
            <h2 className="truncate text-xl font-semibold">{dashboard.name}</h2>
          ) : (
            switcher
          )}
          {canEdit && (
            <IconButton
              label="Rename dashboard"
              onClick={() => setModal({ kind: "rename" })}
            >
              <Pencil size={16} />
            </IconButton>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <PresenceBar status={live.status} users={live.users} />
          <div
            className="flex rounded-xl border border-white/10 bg-black p-1"
            role="group"
            aria-label="Time range"
          >
            {(Object.keys(RANGES) as Range[]).map((r) => (
              <button
                key={r}
                onClick={() => setWin(windowFor(r))}
                aria-pressed={win.range === r}
                className={cx(
                  "rounded-lg px-3.5 py-1.5 text-xs font-medium uppercase transition",
                  win.range === r
                    ? "bg-ink text-black"
                    : "text-ink-2 hover:text-ink"
                )}
              >
                {r}
              </button>
            ))}
          </div>
          <IconButton
            label="Refresh data"
            onClick={() => setWin(windowFor(win.range))}
            className="border border-white/10 bg-black"
          >
            <RefreshCw size={16} />
          </IconButton>
          {canEdit && (
            <Button
              variant={editing ? "primary" : "ghost"}
              onClick={() => setEditing((v) => !v)}
            >
              {editing ? <Check size={16} /> : <Move size={16} />}
              {editing ? "Done" : "Edit layout"}
            </Button>
          )}
          {canEdit && editing && (
            <Button variant="ghost" onClick={() => setModal({ kind: "add" })}>
              <Plus size={16} /> Add widget
            </Button>
          )}
          {canDelete && editing && (
            <Button
              variant="danger"
              onClick={async () => {
                if (!confirm(`Delete "${dashboard.name}" and all its widgets?`))
                  return;
                await api(`/dashboards/${id}`, "DELETE");
                onChanged?.();
                router.replace("/dashboards");
              }}
            >
              <Trash2 size={16} /> Delete
            </Button>
          )}
        </div>
      </div>

      {editing && <EditGuide canDelete={canDelete} />}

      {completed && (
        <div className="mb-4">
          <Notice tone="info">
            This project was completed on{" "}
            {new Date(completed).toLocaleDateString("en-US", {
              month: "short",
              day: "numeric",
              year: "numeric",
            })}
            . Its dashboards are read-only and live data has stopped; the
            history stays available. An Admin can reopen it from Projects.
          </Notice>
        </div>
      )}
      {notice && (
        <div className="mb-4" onClick={() => setNotice(null)}>
          <Notice tone={notice.tone}>{notice.text}</Notice>
        </div>
      )}

      {/* No negative margins or grid padding: the grid is exactly the page width, so the
          page never scrolls sideways (Prompt 27). */}
      <div
        className={cx(
          "rounded-2xl transition",
          editing && "outline-1 outline-offset-8 outline-line outline-dashed"
        )}
      >
        {!dashboard.widgets.length ? (
          <div className="rounded-2xl border border-white/10 bg-black p-10 text-center text-sm text-ink-2">
            This dashboard is empty.
            {canEdit && " Click Edit layout, then Add widget."}
          </div>
        ) : (
          mounted && (
            <ReactGridLayout
              width={width}
              layout={layout}
              gridConfig={{
                cols: 12,
                rowHeight: 72,
                margin: [16, 16],
                containerPadding: [0, 0],
              }}
              dragConfig={{ enabled: editing, handle: ".drag-handle" }}
              resizeConfig={{ enabled: editing }}
              compactor={verticalCompactor}
              onDragStart={startInteraction}
              onResizeStart={startInteraction}
              onDragStop={(next) => {
                endInteraction();
                saveLayout(next);
              }}
              onResizeStop={(next) => {
                endInteraction();
                saveLayout(next);
              }}
            >
              {dashboard.widgets.map((w) => {
                const source = sourceOf(w, customs);
                // Tier 2 D: alerts in this dashboard's project on any base metric the widget
                // reads (a KPI or custom formula reads several, #29), as chart bands; an open
                // one also marks the whole widget.
                const inputs = sourceMetrics(source, customs);
                const widgetAlerts = alerts.filter(
                  (a) =>
                    a.project_id === dashboard.project_id &&
                    inputs.includes(a.metric)
                );
                const anomaly = widgetAlerts.find((a) => a.status === "open");
                return (
                  <div key={w.id}>
                    <div
                      className={cx(
                        WIDGET_CARD,
                        anomaly
                          ? "border-danger/60 shadow-[0_0_0_1px_rgb(248_113_113/0.35),0_0_32px_-8px_rgb(248_113_113/0.45)]"
                          : highlight.has(w.id) &&
                              "border-accent/70 shadow-[0_0_0_1px_rgb(168_197_179/0.5),0_0_32px_-6px_rgb(168_197_179/0.45)]"
                      )}
                    >
                      <div className="mb-3 flex items-center gap-2">
                        {editing && (
                          <span
                            className="drag-handle cursor-grab text-ink-3 active:cursor-grabbing"
                            aria-label="Drag to move"
                          >
                            <GripVertical size={16} />
                          </span>
                        )}
                        <h3 className="min-w-0 flex-1 truncate text-sm font-medium">
                          {w.title || sourceLabel(source)}
                        </h3>
                        {anomaly && (
                          <span
                            className="inline-flex items-center gap-1 rounded-full bg-danger/15 px-2 py-0.5 text-[11px] font-medium text-danger"
                            title={describeAlert(anomaly)}
                          >
                            <TriangleAlert size={12} aria-hidden /> Alert
                          </span>
                        )}
                        {editing ? (
                          <>
                            <IconButton
                              label="Edit widget"
                              onClick={() =>
                                setModal({ kind: "edit", widget: w })
                              }
                              className="size-7"
                            >
                              <Pencil size={14} />
                            </IconButton>
                            <IconButton
                              label="Remove widget"
                              onClick={() =>
                                run(
                                  () => api(`/widgets/${w.id}`, "DELETE"),
                                  "Widget removed"
                                )
                              }
                              tone="danger"
                              className="size-7"
                            >
                              <Trash2 size={14} />
                            </IconButton>
                          </>
                        ) : (
                          <span className="text-xs text-ink-3">
                            {"custom" in source
                              ? "Custom"
                              : "kpi" in source
                                ? "KPI"
                                : sourceLabel(source)}
                          </span>
                        )}
                      </div>
                      <div className="min-h-0 flex-1">
                        <WidgetBody
                          widget={w}
                          dashboard={dashboard}
                          customs={customs}
                          win={win}
                          summary={summary.data}
                          bands={widgetAlerts.map((a) => ({
                            from: a.opened_at,
                            to: a.resolved_at,
                            open: a.status === "open",
                            label: alertSummary(a),
                          }))}
                        />
                      </div>
                    </div>
                  </div>
                );
              })}
            </ReactGridLayout>
          )
        )}
      </div>

      <Modal
        open={modal?.kind === "add"}
        onClose={() => setModal(null)}
        title="Add widget"
      >
        <WidgetForm
          customs={customs}
          onClose={() => setModal(null)}
          onSubmit={(v) =>
            run(() => {
              const bottom = Math.max(
                0,
                ...dashboard.widgets.map((w) => w.y + w.h)
              );
              return api(`/dashboards/${id}/widgets`, "POST", {
                ...v,
                x: 0,
                y: bottom,
                w: v.type === "stat" ? 3 : 6,
                h: v.type === "stat" ? 2 : 4,
              });
            }, "Widget added")
          }
        />
      </Modal>

      <Modal
        open={modal?.kind === "edit"}
        onClose={() => setModal(null)}
        title="Edit widget"
      >
        {modal?.kind === "edit" && (
          <WidgetForm
            initial={modal.widget}
            customs={customs}
            onClose={() => setModal(null)}
            onSubmit={(v) =>
              run(
                () =>
                  api(`/widgets/${modal.widget.id}`, "PATCH", {
                    ...v,
                    version: modal.widget.version,
                  }),
                "Widget saved"
              )
            }
          />
        )}
      </Modal>

      <Modal
        open={modal?.kind === "rename"}
        onClose={() => setModal(null)}
        title="Rename dashboard"
      >
        <RenameForm
          name={dashboard.name}
          onClose={() => setModal(null)}
          onSubmit={(name) =>
            run(async () => {
              await api(`/dashboards/${id}`, "PATCH", {
                name,
                version: dashboard.version,
              });
              onChanged?.();
            }, "Dashboard renamed")
          }
        />
      </Modal>
    </section>
  );
}
