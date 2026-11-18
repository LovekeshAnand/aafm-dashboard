"use client";

import { ShieldCheck } from "lucide-react";
import { useEffect, useState } from "react";
import { PageHeader } from "@/components/page-header";
import { useSession } from "@/components/session";
import { Button, Card, cx, Notice, Select, Spinner } from "@/components/ui";
import { api, errorText } from "@/lib/api";
import type { AuditEntry, Team } from "@/lib/types";
import { useApi } from "@/lib/use-api";

const PAGE = 50;
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

type Page = { entries: AuditEntry[]; next_before: number | null };
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

/**
 * Tier 3 B: "who accessed what". The Super Admin sees the whole organization, a team Admin
 * their own team (RLS). The trail is append-only and hash-chained; Verify recomputes the
 * chain in the database and names the first entry that no longer matches.
 */
export default function AuditPage() {
  const { active_membership: active } = useSession();
  const teams = useApi<Team[]>("/teams");
  const [filters, setFilters] = useState({ action: "", result: "", team: "" });
  const [rows, setRows] = useState<AuditEntry[]>([]);
  const [state, setState] = useState<{
    loading: boolean;
    next: number | null; // cursor for "Load older" (null: nothing older matches)
    error?: string;
  }>({ loading: true, next: null });
  // E19: entries older than a week are packed into compressed segments; listing reads both.
  const storage = useApi<Storage>("/audit/storage");
  const [verify, setVerify] = useState<{
    intact: boolean;
    checked: number;
    first_broken: number | null;
    reason: string | null;
    checkpoints: { checked: number; latest_seq: number | null };
  } | null>(null);
  const orgWide = !active?.team_id;

  const query = (before?: number) =>
    [
      `limit=${PAGE}`,
      filters.action && `action=${encodeURIComponent(filters.action)}`,
      filters.result && `result=${filters.result}`,
      filters.team && `team_id=${filters.team}`,
      before && `before=${before}`,
    ]
      .filter(Boolean)
      .join("&");

  const load = async (before: number) => {
    setState((s) => ({ ...s, loading: true, error: undefined }));
    try {
      const page = await api<Page>(`/audit?${query(before)}`);
      setRows((current) => [...current, ...page.entries]);
      setState({ loading: false, next: page.next_before });
    } catch (err) {
      setState((s) => ({ ...s, loading: false, error: errorText(err) }));
    }
  };

  // Reload from the newest entry whenever a filter changes.
  useEffect(() => {
    let live = true;
    api<Page>(`/audit?${query()}`).then(
      (page) => {
        if (!live) return;
        setRows(page.entries);
        setState({ loading: false, next: page.next_before });
      },
      (err) =>
        live && setState({ loading: false, next: null, error: errorText(err) })
    );
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- query() is derived from filters
  }, [filters]);

  const runVerify = async () => {
    try {
      setVerify(await api("/audit/verify"));
    } catch (err) {
      setState((s) => ({ ...s, error: errorText(err) }));
    }
  };

  const teamName = (id: string | null) =>
    id
      ? (teams.data?.find((t) => t.id === id)?.name ?? "deleted team")
      : "Organization";

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

      <Card className="mb-4 flex flex-wrap items-end gap-3 p-4">
        <label className="grid gap-1 text-xs text-ink-3">
          Action
          <Select
            className="h-10 w-56"
            value={filters.action}
            onChange={(e) => setFilters({ ...filters, action: e.target.value })}
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
            className="h-10 w-40"
            value={filters.result}
            onChange={(e) => setFilters({ ...filters, result: e.target.value })}
          >
            <option value="">Any result</option>
            <option value="allowed">Allowed</option>
            <option value="denied">Denied</option>
            <option value="failed">Failed</option>
          </Select>
        </label>
        {orgWide && (
          <label className="grid gap-1 text-xs text-ink-3">
            Team
            <Select
              className="h-10 w-48"
              value={filters.team}
              onChange={(e) => setFilters({ ...filters, team: e.target.value })}
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
      </Card>

      {state.error && <Notice>{state.error}</Notice>}

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
            {rows.map((e) => (
              <tr key={e.seq} className="border-b border-white/5 align-top">
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
        {!state.loading && !rows.length && (
          <p className="p-8 text-center text-sm text-ink-3">
            No entries match these filters.
          </p>
        )}
      </div>

      <div className="mt-4 flex justify-center">
        {state.loading ? (
          <Spinner />
        ) : (
          state.next !== null && (
            <Button variant="ghost" onClick={() => load(state.next!)}>
              Load older entries
            </Button>
          )
        )}
      </div>
    </>
  );
}
