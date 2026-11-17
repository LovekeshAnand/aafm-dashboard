"use client";

import { type PointerEvent, useLayoutEffect, useRef, useState } from "react";
import {
  formatMetric,
  METRIC_LABEL,
  type Metric,
  type Point,
} from "@/lib/types";

const PAD = { top: 10, right: 8, bottom: 22, left: 46 };

function useSize<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) =>
      setSize({
        width: entry.contentRect.width,
        height: entry.contentRect.height,
      })
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return [ref, size] as const;
}

/** 0 .. a round number >= max, split into 4 steps (1/2/2.5/5 x 10^n). */
function niceTicks(max: number) {
  const raw = (max || 1) / 4;
  const pow = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].find((m) => m * pow >= raw)! * pow;
  return Array.from({ length: 5 }, (_, i) => i * step);
}

const timeLabel = (t: string, spanMs: number) =>
  new Date(t).toLocaleString(
    "en-US",
    spanMs > 2 * 86400e3
      ? { month: "short", day: "numeric" }
      : { hour: "2-digit", minute: "2-digit", hour12: false }
  );

/**
 * Single-series time chart (dataviz rules: one series = no legend, the widget title names it;
 * 2px line, 4px rounded bar ends on the baseline, recessive grid, crosshair + tooltip on hover,
 * and a table view for screen readers).
 */
export function SeriesChart({
  points,
  metric,
  kind,
}: {
  points: Point[];
  metric: Metric;
  kind: "line" | "bar";
}) {
  const [ref, { width, height }] = useSize<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);

  if (!points.length) {
    return (
      <div className="grid h-full place-items-center text-sm text-ink-3">
        No data in this range
      </div>
    );
  }

  const plotW = Math.max(width - PAD.left - PAD.right, 1);
  const plotH = Math.max(height - PAD.top - PAD.bottom, 1);
  const ticks = niceTicks(Math.max(...points.map((p) => p.value)));
  const yMax = ticks[ticks.length - 1];
  const band = plotW / points.length;
  const x = (i: number) =>
    PAD.left +
    (kind === "bar"
      ? band * (i + 0.5)
      : (plotW * i) / Math.max(points.length - 1, 1));
  const y = (v: number) => PAD.top + plotH - (v / yMax) * plotH;
  const span =
    new Date(points[points.length - 1].t).getTime() -
    new Date(points[0].t).getTime();
  const labelEvery = Math.max(
    1,
    Math.ceil(points.length / Math.max(2, Math.floor(plotW / 90)))
  );

  const line = points
    .map((p, i) => `${i ? "L" : "M"}${x(i)},${y(p.value)}`)
    .join("");
  const area = `${line}L${x(points.length - 1)},${y(0)}L${x(0)},${y(0)}Z`;

  const onMove = (e: PointerEvent<SVGRectElement>) => {
    const left = e.clientX - e.currentTarget.getBoundingClientRect().left;
    const i =
      kind === "bar"
        ? Math.floor(left / band)
        : Math.round((left / plotW) * (points.length - 1));
    setHover(Math.min(points.length - 1, Math.max(0, i)));
  };

  const hovered = hover === null ? null : points[hover];

  return (
    <div ref={ref} className="relative h-full w-full">
      {width > 0 && (
        <svg
          width={width}
          height={height}
          role="img"
          aria-label={`${METRIC_LABEL[metric]} over time`}
        >
          <defs>
            <linearGradient id={`fill-${metric}`} x1="0" x2="0" y1="0" y2="1">
              <stop
                offset="0%"
                stopColor="var(--color-series)"
                stopOpacity="0.35"
              />
              <stop
                offset="100%"
                stopColor="var(--color-series)"
                stopOpacity="0"
              />
            </linearGradient>
          </defs>
          {ticks.map((t) => (
            <g key={t}>
              <line
                x1={PAD.left}
                x2={PAD.left + plotW}
                y1={y(t)}
                y2={y(t)}
                stroke="rgb(255 255 255 / 0.06)"
              />
              <text
                x={PAD.left - 8}
                y={y(t)}
                dy="0.32em"
                textAnchor="end"
                className="fill-ink-3 text-[10px]"
              >
                {formatMetric(metric, t)}
              </text>
            </g>
          ))}
          {points.map((p, i) =>
            i % labelEvery === 0 ? (
              <text
                key={p.t}
                x={x(i)}
                y={height - 6}
                textAnchor="middle"
                className="fill-ink-3 text-[10px]"
              >
                {timeLabel(p.t, span)}
              </text>
            ) : null
          )}

          {kind === "line" ? (
            <>
              <path d={area} fill={`url(#fill-${metric})`} />
              <path
                d={line}
                fill="none"
                stroke="var(--color-series)"
                strokeWidth={2}
                strokeLinejoin="round"
              />
            </>
          ) : (
            points.map((p, i) => {
              const w = Math.max(band - 2, 1); // 2px surface gap between bars
              const top = y(p.value);
              const r = Math.min(4, w / 2, y(0) - top);
              const left = x(i) - w / 2;
              return (
                <path
                  key={p.t}
                  d={`M${left},${y(0)}V${top + r}Q${left},${top} ${left + r},${top}H${left + w - r}Q${left + w},${top} ${left + w},${top + r}V${y(0)}Z`}
                  fill="var(--color-series)"
                  opacity={hover === null || hover === i ? 1 : 0.45}
                />
              );
            })
          )}

          {hovered && kind === "line" && (
            <>
              <line
                x1={x(hover!)}
                x2={x(hover!)}
                y1={PAD.top}
                y2={y(0)}
                stroke="rgb(255 255 255 / 0.25)"
                strokeDasharray="3 3"
              />
              <circle
                cx={x(hover!)}
                cy={y(hovered.value)}
                r={5}
                fill="var(--color-series)"
                stroke="var(--color-canvas)"
                strokeWidth={2}
              />
            </>
          )}

          {/* hit target: the whole plot, larger than any mark */}
          <rect
            x={PAD.left}
            y={PAD.top}
            width={plotW}
            height={plotH}
            fill="transparent"
            onPointerMove={onMove}
            onPointerLeave={() => setHover(null)}
          />
        </svg>
      )}

      {hovered && (
        <div
          className="glass pointer-events-none absolute z-10 rounded-xl px-3 py-2 text-xs whitespace-nowrap"
          style={{ left: Math.min(x(hover!) + 10, width - 140), top: PAD.top }}
        >
          <div className="text-ink-3">
            {new Date(hovered.t).toLocaleString("en-US", {
              dateStyle: "medium",
              timeStyle: "short",
            })}
          </div>
          <div className="mt-0.5 text-sm font-semibold text-ink">
            {formatMetric(metric, hovered.value)}
          </div>
        </div>
      )}

      <table className="sr-only">
        <caption>{METRIC_LABEL[metric]}</caption>
        <tbody>
          {points.map((p) => (
            <tr key={p.t}>
              <td>{p.t}</td>
              <td>{p.value}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Hero-number tile: current total and change vs the previous period of equal length. */
export function StatTile({
  metric,
  current,
  previous,
}: {
  metric: Metric;
  current: number;
  previous: number;
}) {
  const change = previous ? ((current - previous) / previous) * 100 : null;
  // For errors, going down is good.
  const good =
    change !== null && (metric === "errors" ? change <= 0 : change >= 0);
  return (
    <div className="flex h-full flex-col justify-end">
      <div className="text-4xl font-semibold tracking-tight">
        {formatMetric(metric, current)}
      </div>
      {change !== null && (
        <div className="mt-2 flex items-center gap-2 text-xs">
          <span
            className={
              good
                ? "rounded-full bg-accent/15 px-2 py-0.5 text-accent"
                : "rounded-full bg-danger/15 px-2 py-0.5 text-danger"
            }
          >
            {change >= 0 ? "▲" : "▼"} {Math.abs(change).toFixed(1)}%
          </span>
          <span className="text-ink-3">vs previous period</span>
        </div>
      )}
    </div>
  );
}
