"use client";

import {
  ChevronLeft,
  ChevronRight,
  Search,
  ShieldCheck,
  X,
} from "lucide-react";
import { useEffect, useState } from "react";
import { PageHeader } from "@/components/page-header";
import { useSession } from "@/components/session";
import {
  Button,
  Card,
  cx,
  IconButton,
  Input,
  Notice,
  Select,
  Spinner,
} from "@/components/ui";
import { api, errorText } from "@/lib/api";
import type { AuditEntry, Team } from "@/lib/types";
import { useApi } from "@/lib/use-api";

const CATEGORIES = [
  ["", "All actions"],
  ["auth.", "Sign-in and sessions"],
  ["dashboard.", "Dashboards"],
  ["widget.", "Widgets"],
  ["layout.", "Layout"],
  ["project.", "Projects"],
  ["custom_metric.", "Custom metrics"],
  ["member", "Members"],
  ["team.", "Teams"],
  ["webhook.", "Webhooks"],
  ["access.", "Denied requests"],
  ["audit.", "Audit log access"],
] as const;

const RESULT_TONE: Record<AuditEntry["result"], string> = {
  allowed: "text-ink-3",
  denied: "bg-danger/15 text-danger",
  failed: "bg-warn/15 text-warn",
};

type Page = {
  entries: AuditEntry[];
  total: number;
  page: number;
  size: number;
  pages: number;
  as_of: number | null;
};
type Storage = {
  live_entries: number;
  archived_entries: number;
  segments: number;
  archive_raw_bytes: number;
  archive_stored_bytes: number;
  compression_ratio: number | null;
};
const kb = (bytes: number) => `${(bytes / 1024).toFixed(1)} KB`;

/** A short, human summary of the entry's details (never secrets: the API doesn't log any). */
const details = (e: AuditEntry) =>
  Object.entries(e.meta)
    .filter(([key]) => key !== "filters" && key !== "request_id")
    .map(
      ([key, value]) =>
        `${key}: ${typeof value === "object" ? JSON.stringify(value) : String(value)}`
    )
    .join(" · ");

const EMPTY = {
  q: "",
  action: "",
  result: "",
  team: "",
  from: "",
  to: "",
  sort: "newest",
  size: "50",
};

/** Page numbers around the current one: 1 … 4 5 [6] 7 8 … 20 */
const pageList = (page: number, pages: number) => {
  const shown = new Set([
    1,
    pages,
    page - 2,
    page - 1,
    page,
    page + 1,
    page + 2,
  ]);
  const list = [...shown]
    .filter((p) => p >= 1 && p <= pages)
    .sort((a, b) => a - b);
  return list.flatMap((p, i) => (i && p - list[i - 1] > 1 ? ["…", p] : [p]));
};

/**
 * Tier 3 B: "who accessed what". The Super Admin sees the whole organization, a team Admin
 * their own team. F6 (Prompt 68): search, an issues-only filter and issues-first sorting,
 * dates, and numbered pages that stay stable while new entries arrive (`as_of`). The trail is
 * append-only and hash-chained; Verify recomputes it and checks the signed checkpoints.
 */
export default function AuditPage() {
  const { active_membership: active } = useSession();
  const teams = useApi<Team[]>("/teams");
  const storage = useApi<Storage>("/audit/storage");
  const [draft, setDraft] = useState(EMPTY.q); // search box, applied after typing stops
  const [filters, setFilters] = useState(EMPTY);
  const [page, setPage] = useState(1);
  const [asOf, setAsOf] = useState<number | null>(null);
  const [result, setResult] = useState<{
    data?: Page;
    loading: boolean;
    error?: string;
  }>({ loading: true });
  const [verify, setVerify] = useState<{
    intact: boolean;
    checked: number;
    first_broken: number | null;
    reason: string | null;
    checkpoints: { checked: number; latest_seq: number | null };
  } | null>(null);
  const orgWide = !active?.team_id;

  // Search applies 300 ms after typing stops.
  useEffect(() => {
    const timer = window.setTimeout(
      () => setFilters((f) => (f.q === draft ? f : { ...f, q: draft })),
      300
    );
    return () => window.clearTimeout(timer);
  }, [draft]);

  const change = (patch: Partial<typeof EMPTY>) => {
    setFilters((f) => ({ ...f, ...patch }));
    setPage(1);
    setAsOf(null); // new filters: a fresh snapshot
  };

  useEffect(() => {
    let live = true;
    const params = new URLSearchParams({
      page: String(page),
      size: filters.size,
      sort: filters.sort,
    });
    if (filters.q) params.set("q", filters.q);
    if (filters.action) params.set("action", filters.action);
    if (filters.result) params.set("result", filters.result);
    if (filters.team) params.set("team_id", filters.team);
    if (filters.from) params.set("from", new Date(filters.from).toISOString());
    if (filters.to)
      params.set(
        "to",
        new Date(new Date(filters.to).getTime() + 86400e3).toISOString()
      ); // through the end of that day
    if (asOf && page > 1) params.set("as_of", String(asOf));
    setResult((r) => ({ ...r, loading: true, error: undefined }));
    api<Page>(`/audit?${params}`).then(
      (data) => {
        if (!live) return;
        setResult({ data, loading: false });
        if (page === 1) setAsOf(data.as_of);
      },
      (err) => live && setResult({ loading: false, error: errorText(err) })
    );
    return () => {
      live = false;
    };
    // asOf is set from page 1's answer and only read for later pages.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filters, page]);

  const runVerify = async () => {
    try {
      setVerify(await api("/audit/verify"));
    } catch (err) {
      setResult((r) => ({ ...r, error: errorText(err) }));
    }
  };

  const teamName = (id: string | null) =>
    id
      ? (teams.data?.find((t) => t.id === id)?.name ?? "deleted team")
      : "Organization";
  const data = result.data;
  const filtered =
    JSON.stringify({ ...filters, q: draft }) !== JSON.stringify(EMPTY);

  return (
    <>
      <PageHeader
        title="Audit log"
        subtitle="Sign-ins, every change, who opened what, and every refused request. Entries can't be edited or deleted."
        actions={
          <Button variant="ghost" onClick={runVerify}>
            <ShieldCheck size={16} /> Verify integrity
          </Button>
        }
      />

      {storage.data && (
        <p className="mb-4 text-xs text-ink-3">
          {storage.data.live_entries.toLocaleString()} recent entries as rows ·{" "}
          {storage.data.archived_entries.toLocaleString()} older entries in{" "}
          {storage.data.segments.toLocaleString()} compressed segments
          {storage.data.compression_ratio !== null &&
            ` (${kb(storage.data.archive_raw_bytes)} of JSON stored in ${kb(storage.data.archive_stored_bytes)}, ${storage.data.compression_ratio}×)`}
          . Every entry stays searchable and in the integrity chain.
        </p>
      )}

      {verify && (
        <div className="mb-4" onClick={() => setVerify(null)}>
          <Notice tone={verify.intact ? "success" : "error"}>
            {verify.intact
              ? `Intact: all ${verify.checked} entries match the hash chain${
                  verify.checkpoints.latest_seq
                    ? `, and ${verify.checkpoints.checked} signed checkpoints (latest #${verify.checkpoints.latest_seq}) are present and genuine`
                    : ""
                }.`
              : `Tampering detected at entry #${verify.first_broken}: ${verify.reason}.`}
          </Notice>
        </div>
      )}

      <Card className="mb-4 grid gap-3 p-4">
        <div className="relative">
          <Search
            size={16}
            aria-hidden
            className="pointer-events-none absolute top-1/2 left-3.5 -translate-y-1/2 text-ink-3"
          />
          <Input
            type="search"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="Search people, actions, details or IP addresses"
            aria-label="Search the audit log"
            // inline, not a class: Input's own px-4 would win a Tailwind class conflict (#29)
            style={{ paddingLeft: "2.5rem" }}
            maxLength={100}
          />
        </div>
        <div className="flex flex-wrap items-end gap-3">
          <label className="grid gap-1 text-xs text-ink-3">
            Action
            <Select
              className="h-11 w-52"
              value={filters.action}
              onChange={(e) => change({ action: e.target.value })}
            >
              {CATEGORIES.map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </Select>
          </label>
          <label className="grid gap-1 text-xs text-ink-3">
            Result
            <Select
              className="h-11 w-44"
              value={filters.result}
              onChange={(e) => change({ result: e.target.value })}
            >
              <option value="">Any result</option>
              <option value="issues">Issues only</option>
              <option value="denied">Denied</option>
              <option value="failed">Failed</option>
              <option value="allowed">Allowed</option>
            </Select>
          </label>
          {orgWide && (
            <label className="grid gap-1 text-xs text-ink-3">
              Team
              <Select
                className="h-11 w-44"
                value={filters.team}
                onChange={(e) => change({ team: e.target.value })}
              >
                <option value="">All teams</option>
                {(teams.data ?? []).map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </Select>
            </label>
          )}
          <label className="grid w-40 gap-1 text-xs text-ink-3">
            From
            <Input
              type="date"
              value={filters.from}
              onChange={(e) => change({ from: e.target.value })}
            />
          </label>
          <label className="grid w-40 gap-1 text-xs text-ink-3">
            To
            <Input
              type="date"
              value={filters.to}
              onChange={(e) => change({ to: e.target.value })}
            />
          </label>
          <label className="grid gap-1 text-xs text-ink-3">
            Sort
            <Select
              className="h-11 w-40"
              value={filters.sort}
              onChange={(e) => change({ sort: e.target.value })}
            >
              <option value="newest">Newest first</option>
              <option value="oldest">Oldest first</option>
              <option value="issues">Issues first</option>
            </Select>
          </label>
          {filtered && (
            <Button
              variant="ghost"
              onClick={() => {
                setDraft("");
                change(EMPTY);
              }}
            >
              <X size={14} /> Clear
            </Button>
          )}
        </div>
      </Card>

      {result.error && <Notice>{result.error}</Notice>}

      <div className="mb-2 flex items-center justify-between text-xs text-ink-3">
        <span aria-live="polite">
          {data
            ? `${data.total.toLocaleString()} ${data.total === 1 ? "entry" : "entries"}`
            : ""}
        </span>
        {result.loading && <Spinner />}
      </div>

      <div className="overflow-x-auto rounded-2xl border border-white/10 bg-black">
        <table className="w-full min-w-[56rem] text-left text-sm">
          <thead className="border-b border-white/10 text-xs text-ink-3">
            <tr>
              <th className="px-4 py-3 font-medium">When</th>
              <th className="px-4 py-3 font-medium">Who</th>
              <th className="px-4 py-3 font-medium">Action</th>
              <th className="px-4 py-3 font-medium">Team</th>
              <th className="px-4 py-3 font-medium">Details</th>
              <th className="px-4 py-3 font-medium">IP</th>
            </tr>
          </thead>
          <tbody>
            {(data?.entries ?? []).map((e) => (
              <tr
                key={e.seq}
                className={cx(
                  "border-b border-white/5 align-top",
                  e.result !== "allowed" && "bg-danger/[0.04]"
                )}
              >
                <td className="px-4 py-2.5 whitespace-nowrap text-ink-2">
                  {new Date(e.at).toLocaleString("en-US", {
                    month: "short",
                    day: "numeric",
                    hour: "2-digit",
                    minute: "2-digit",
                    second: "2-digit",
                    hour12: false,
                  })}
                </td>
                <td className="px-4 py-2.5">{e.actor_name ?? "System"}</td>
                <td className="px-4 py-2.5 whitespace-nowrap">
                  <code className="text-xs">{e.action}</code>
                  {e.result !== "allowed" && (
                    <span
                      className={cx(
                        "ml-2 rounded-full px-2 py-0.5 text-[11px] font-medium",
                        RESULT_TONE[e.result]
                      )}
                    >
                      {e.result}
                    </span>
                  )}
                </td>
                <td className="px-4 py-2.5 text-ink-2">
                  {teamName(e.team_id)}
                </td>
                <td className="max-w-md px-4 py-2.5 text-xs break-words text-ink-3">
                  {details(e) ||
                    (e.target_type && `${e.target_type} ${e.target_id ?? ""}`)}
                </td>
                <td className="px-4 py-2.5 text-xs text-ink-3">{e.ip}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {!result.loading && data && !data.entries.length && (
          <p className="p-8 text-center text-sm text-ink-3">
            No entries match these filters.
          </p>
        )}
      </div>

      {data && data.pages > 1 && (
        <nav
          aria-label="Audit log pages"
          className="mt-4 flex flex-wrap items-center justify-between gap-3"
        >
          <label className="flex items-center gap-2 text-xs text-ink-3">
            Per page
            <Select
              className="h-9 w-24"
              value={filters.size}
              onChange={(e) => change({ size: e.target.value })}
            >
              {["25", "50", "100", "200"].map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </Select>
          </label>
          <div className="flex items-center gap-1">
            <IconButton
              label="Previous page"
              disabled={page <= 1}
              onClick={() => setPage((p) => p - 1)}
            >
              <ChevronLeft size={16} />
            </IconButton>
            {pageList(page, data.pages).map((p, i) =>
              p === "…" ? (
                <span key={`gap-${i}`} className="px-1 text-ink-3">
                  …
                </span>
              ) : (
                <button
                  key={p}
                  onClick={() => setPage(p as number)}
                  aria-current={p === page ? "page" : undefined}
                  className={cx(
                    "h-9 min-w-9 rounded-lg px-2 text-sm transition",
                    p === page
                      ? "bg-ink font-semibold text-black"
                      : "text-ink-2 hover:bg-glass-strong"
                  )}
                >
                  {p}
                </button>
              )
            )}
            <IconButton
              label="Next page"
              disabled={page >= data.pages}
              onClick={() => setPage((p) => p + 1)}
            >
              <ChevronRight size={16} />
            </IconButton>
          </div>
        </nav>
      )}
    </>
  );
}
