"use client";

import { ArrowDown, ArrowUp } from "lucide-react";
import { useId } from "react";
import { Card } from "@/components/ui";
import {
  formatSource,
  lowerIsBetter,
  type Point,
  type Source,
} from "@/lib/types";
import { useApi } from "@/lib/use-api";

/**
 * Overview card (Prompts 71-72, after the user's reference image): the figure, its change
 * against the previous 24 hours, and a soft area sparkline of the last 24 hours in a band along
 * the bottom that fades in from the left, so it never runs through the text.
 * Green when the change is good, red when it is bad; for errors and error rate "up" is bad,
 * matching every other change badge in the app.
 */
export function TrendCard({
  label,
  hint,
  source,
  current,
  previous,
  seriesPath,
}: {
  label: string;
  hint?: string;
  source: Source;
  current: number | null;
  previous: number | null;
  /** /metrics/series or /metrics/kpi for the last 24 hours, hourly. */
  seriesPath: string;
}) {
  const series = useApi<{ points: Point[] }>(seriesPath);
  const change =
    current !== null && previous
      ? ((current - previous) / previous) * 100
      : null;
  const good =
    change === null || (lowerIsBetter(source) ? change <= 0 : change >= 0);
  const tone = good ? "var(--color-series)" : "var(--color-danger)";
  const points = (series.data?.points ?? []).filter(
    (p): p is Point & { value: number } => p.value !== null
  );

  return (
    <Card className="relative h-48 overflow-hidden p-5">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0"
        style={{
          background: `radial-gradient(90% 85% at 100% 100%, color-mix(in srgb, ${tone} 16%, transparent), transparent 70%)`,
        }}
      />
      <Sparkline points={points} tone={tone} />

      <div className="relative flex items-start justify-between gap-3">
        <div className="min-w-0 truncate text-sm text-ink-2" title={hint}>
          {label}
          {hint && <span className="text-xs text-ink-3"> · {hint}</span>}
        </div>
        {change !== null && (
          <div className="flex shrink-0 items-center gap-1.5 text-xs">
            <span
              className="flex items-center gap-0.5 font-medium"
              style={{ color: tone }}
            >
              {change >= 0 ? <ArrowUp size={13} /> : <ArrowDown size={13} />}
              {Math.abs(change).toFixed(1)}%
            </span>
            <span className="text-ink-3">24h</span>
          </div>
        )}
      </div>
      <div className="relative mt-2 text-4xl font-light tracking-tight tabular-nums">
        {current === null ? "—" : formatSource(source, current)}
      </div>
      {current !== null && previous !== null && (
        <div className="relative mt-1 text-xs text-ink-3">
          <span className="font-medium" style={{ color: tone }}>
            {current >= previous ? "+" : "−"}
            {formatSource(source, Math.abs(current - previous))}
          </span>{" "}
          vs previous 24h
        </div>
      )}
    </Card>
  );
}

/** Smooth area line (midpoint quadratic curves: no overshoot) with a dot on the latest value. */
function Sparkline({
  points,
  tone,
}: {
  points: { t: string; value: number }[];
  tone: string;
}) {
  const id = useId();
  if (points.length < 2) return null;
  const values = points.map((p) => p.value);
  const min = Math.min(...values);
  const span = Math.max(...values) - min || 1;
  const xy = values.map(
    (v, i) =>
      [(i / (values.length - 1)) * 96, 36 - ((v - min) / span) * 30] as const
  );
  let line = `M${xy[0][0]},${xy[0][1]}`;
  for (let i = 1; i < xy.length - 1; i++) {
    const [x, y] = xy[i];
    const [nx, ny] = xy[i + 1];
    line += ` Q${x},${y} ${(x + nx) / 2},${(y + ny) / 2}`;
  }
  const [lx, ly] = xy[xy.length - 1];
  line += ` L${lx},${ly}`;

  return (
    <div
      aria-hidden
      className="pointer-events-none absolute inset-x-0 bottom-0 h-[38%] [mask-image:linear-gradient(to_right,transparent,black_35%)]"
    >
      <svg
        viewBox="0 0 100 40"
        preserveAspectRatio="none"
        className="size-full overflow-visible"
      >
        <defs>
          <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={tone} stopOpacity={0.28} />
            <stop offset="100%" stopColor={tone} stopOpacity={0} />
          </linearGradient>
        </defs>
        <path d={`${line} L${lx},40 L0,40 Z`} fill={`url(#${id})`} />
        <path
          d={line}
          fill="none"
          stroke={tone}
          strokeWidth={1.75}
          vectorEffect="non-scaling-stroke"
        />
      </svg>
      {/* An HTML dot keeps its round shape (the SVG is stretched to the card). */}
      <span
        className="absolute size-2 -translate-1/2 rounded-full ring-2 ring-canvas"
        style={{ left: `${lx}%`, top: `${(ly / 40) * 100}%`, background: tone }}
      />
    </div>
  );
}
