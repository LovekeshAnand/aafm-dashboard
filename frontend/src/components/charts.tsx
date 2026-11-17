"use client";

import { type PointerEvent, useLayoutEffect, useRef, useState } from "react";
import {
  formatSource,
  lowerIsBetter,
  type Point,
  type Source,
  sourceKey,
  sourceLabel,
} from "@/lib/types";

const PAD = { top: 10, right: 8, bottom: 22, left: 52 };

/** A shaded time span on a chart, e.g. an anomaly alert (Tier 2 D). */
export type ChartBand = { from: string; to: string | null; open: boolean };

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

/** Runs of consecutive non-null points, so a missing KPI value breaks the line (a gap). */
const segments = (points: Point[]) => {
  const runs: number[][] = [];
  points.forEach((p, i) => {
    if (p.value === null) return;
    const last = runs[runs.length - 1];
    if (last && last[last.length - 1] === i - 1) last.push(i);
    else runs.push([i]);
  });
  return runs;
};

/**
 * Single-series time chart (dataviz rules: one series = no legend, the widget title names it;
 * 2px line, 4px rounded bar ends on the baseline, recessive grid, crosshair + tooltip on hover,
 * and a table view for screen readers). Null values are gaps; `bands` shade alert periods.
 */
export function SeriesChart({
  points,
  source,
  kind,
  bands = [],
}: {
  points: Point[];
  source: Source;
  kind: "line" | "bar";
  bands?: ChartBand[];
}) {
  const [ref, { width, height }] = useSize<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const label = sourceLabel(source);
  const id = sourceKey(source);

  if (!points.length) {
    return (
      <div className="grid h-full place-items-center text-sm text-ink-3">
        No data in this range
      </div>
    );
  }

  const values = points.flatMap((p) => (p.value === null ? [] : [p.value]));
  const plotW = Math.max(width - PAD.left - PAD.right, 1);
  const plotH = Math.max(height - PAD.top - PAD.bottom, 1);
  const ticks = niceTicks(Math.max(0, ...values));
  const yMax = ticks[ticks.length - 1];
  const band = plotW / points.length;
  const x = (i: number) =>
    PAD.left +
    (kind === "bar"
      ? band * (i + 0.5)
      : (plotW * i) / Math.max(points.length - 1, 1));
  const y = (v: number) => PAD.top + plotH - (v / yMax) * plotH;
  const t0 = new Date(points[0].t).getTime();
  const tN = new Date(points[points.length - 1].t).getTime();
  const span = tN - t0;
  const xAt = (ms: number) =>
    PAD.left + Math.min(1, Math.max(0, (ms - t0) / (span || 1))) * plotW;
  const labelEvery = Math.max(
    1,
    Math.ceil(points.length / Math.max(2, Math.floor(plotW / 90)))
  );

  const runs = segments(points);
  const linePath = (run: number[]) =>
    run
      .map((i, k) => `${k ? "L" : "M"}${x(i)},${y(points[i].value!)}`)
      .join("");
  const areaPath = (run: number[]) =>
    `${linePath(run)}L${x(run[run.length - 1])},${y(0)}L${x(run[0])},${y(0)}Z`;

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
          aria-label={`${label} over time`}
        >
          <defs>
            <linearGradient id={`fill-${id}`} x1="0" x2="0" y1="0" y2="1">
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

          {/* Alert periods, under the data so the series stays readable. */}
          {bands.map((b) => {
            const from = xAt(new Date(b.from).getTime());
            const to = xAt(b.to ? new Date(b.to).getTime() : tN);
            return (
              <g key={b.from}>
                <rect
                  x={from}
                  y={PAD.top}
                  width={Math.max(to - from, 3)}
                  height={plotH}
                  fill="var(--color-danger)"
                  opacity={b.open ? 0.16 : 0.08}
                />
                <line
                  x1={from}
                  x2={from}
                  y1={PAD.top}
                  y2={PAD.top + plotH}
                  stroke="var(--color-danger)"
                  strokeOpacity={0.6}
                  strokeDasharray="3 3"
                />
              </g>
            );
          })}

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
                {formatSource(source, t)}
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

          {kind === "line"
            ? runs.map((run) => (
                <g key={run[0]}>
                  <path d={areaPath(run)} fill={`url(#fill-${id})`} />
                  <path
                    d={linePath(run)}
                    fill="none"
                    stroke="var(--color-series)"
                    strokeWidth={2}
                    strokeLinejoin="round"
                  />
                </g>
              ))
            : points.map((p, i) => {
                if (p.value === null) return null;
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
              })}

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
              {hovered.value !== null && (
                <circle
                  cx={x(hover!)}
                  cy={y(hovered.value)}
                  r={5}
                  fill="var(--color-series)"
                  stroke="var(--color-canvas)"
                  strokeWidth={2}
                />
              )}
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
          style={{ left: Math.min(x(hover!) + 10, width - 150), top: PAD.top }}
        >
          <div className="text-ink-3">
            {new Date(hovered.t).toLocaleString("en-US", {
              dateStyle: "medium",
              timeStyle: "short",
            })}
          </div>
          <div className="mt-0.5 text-sm font-semibold text-ink">
            {hovered.value === null
              ? "No value (nothing to divide by)"
              : formatSource(source, hovered.value)}
          </div>
        </div>
      )}

      <table className="sr-only">
        <caption>{label}</caption>
        <tbody>
          {points.map((p) => (
            <tr key={p.t}>
              <td>{p.t}</td>
              <td>{p.value ?? "no value"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Hero-number tile: current total and change vs the previous period of equal length. */
export function StatTile({
  source,
  current,
  previous,
}: {
  source: Source;
  current: number | null;
  previous: number | null;
}) {
  const change =
    current !== null && previous
      ? ((current - previous) / previous) * 100
      : null;
  const good =
    change !== null && (lowerIsBetter(source) ? change <= 0 : change >= 0);
  return (
    <div className="flex h-full flex-col justify-end">
      <div className="text-4xl font-semibold tracking-tight">
        {current === null ? "—" : formatSource(source, current)}
      </div>
      {change !== null && (
        <div className="mt-2 flex items-center gap-2 text-xs">
          <span
            className={
              good
                ? "rounded-full bg-accent/15 px-2 py-0.5 whitespace-nowrap text-accent"
                : "rounded-full bg-danger/15 px-2 py-0.5 whitespace-nowrap text-danger"
            }
          >
            {change >= 0 ? "▲" : "▼"} {Math.abs(change).toFixed(1)}%
          </span>
          <span className="truncate text-ink-3">vs previous period</span>
        </div>
      )}
    </div>
  );
}
