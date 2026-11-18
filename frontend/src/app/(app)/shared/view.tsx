"use client";

import { Ban, Check, Plus, X } from "lucide-react";
import { type FormEvent, useState } from "react";
import { SeriesChart, StatTile } from "@/components/charts";
import { PageHeader } from "@/components/page-header";
import { useSession } from "@/components/session";
import {
  Badge,
  Button,
  Card,
  cx,
  Field,
  Input,
  Modal,
  Notice,
  Select,
  Spinner,
} from "@/components/ui";
import { api, errorText } from "@/lib/api";
import { useSocketEvent } from "@/lib/realtime";
import {
  ADMINS,
  type Kpi,
  KPI_FORMULA,
  KPI_LABEL,
  METRIC_LABEL,
  type Metric,
  type Point,
  type Source,
} from "@/lib/types";
import { useApi } from "@/lib/use-api";

// Feature F7 (Prompt 68): "I want to see ARPU of Finance only". Ask a team for one figure;
// its Admins approve for a set time or decline; an approval shows only that figure.
type AccessRequest = {
  id: string;
  requester_name: string;
  target_team_id: string;
  team_name: string;
  source_kind: "metric" | "kpi";
  source: string;
  reason: string;
  days: number;
  status: "pending" | "approved" | "declined" | "revoked";
  active: boolean;
  decision_note: string | null;
  expires_at: string | null;
  created_at: string;
};
type DirectoryTeam = { id: string; name: string };

const DURATIONS = [1, 7, 30, 90];
const sourceOf = (r: Pick<AccessRequest, "source_kind" | "source">): Source =>
  r.source_kind === "kpi"
    ? { kpi: r.source as Kpi }
    : { metric: r.source as Metric };
const figure = (r: Pick<AccessRequest, "source_kind" | "source">) =>
  r.source_kind === "kpi"
    ? KPI_LABEL[r.source as Kpi]
    : METRIC_LABEL[r.source as Metric];
const date = (iso: string) =>
  new Date(iso).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
const days = (n: number) => `${n} day${n > 1 ? "s" : ""}`;

const STATUS: Record<string, { label: string; tone: string }> = {
  pending: { label: "Waiting for approval", tone: "bg-warn/15 text-warn" },
  approved: { label: "Approved", tone: "bg-accent/15 text-accent" },
  expired: { label: "Expired", tone: "bg-white/10 text-ink-3" },
  declined: { label: "Declined", tone: "bg-danger/15 text-danger" },
  revoked: { label: "Ended by an admin", tone: "bg-white/10 text-ink-3" },
};
const statusOf = (r: AccessRequest) =>
  r.status === "approved" && !r.active ? "expired" : r.status;

function AskForm({
  teams,
  onSent,
}: {
  teams: DirectoryTeam[];
  onSent: () => void;
}) {
  const [form, setForm] = useState({
    team_id: teams[0]?.id ?? "",
    source: "kpi:arpu",
    reason: "",
    days: "7",
  });
  const [error, setError] = useState("");
  const [kind, source] = form.source.split(":");

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    try {
      await api("/access-requests", "POST", {
        team_id: form.team_id,
        kind,
        source,
        reason: form.reason,
        days: Number(form.days),
      });
      onSent();
    } catch (err) {
      setError(errorText(err));
    }
  };

  if (!teams.length)
    return (
      <Notice tone="info">
        There are no other teams in your organization to ask.
      </Notice>
    );
  return (
    <form onSubmit={submit} className="grid gap-4">
      <Field label="Which team?">
        <Select
          value={form.team_id}
          onChange={(e) => setForm({ ...form, team_id: e.target.value })}
        >
          {teams.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </Select>
      </Field>
      <Field
        label="Which figure?"
        hint={
          kind === "kpi"
            ? `${KPI_FORMULA[source as Kpi]}. You'll see only the result, not the figures behind it.`
            : "You'll see only this figure, nothing else of the team."
        }
      >
        <Select
          value={form.source}
          onChange={(e) => setForm({ ...form, source: e.target.value })}
        >
          <optgroup label="KPIs">
            {Object.entries(KPI_LABEL).map(([value, label]) => (
              <option key={value} value={`kpi:${value}`}>
                {label}
              </option>
            ))}
          </optgroup>
          <optgroup label="Metrics">
            {Object.entries(METRIC_LABEL).map(([value, label]) => (
              <option key={value} value={`metric:${value}`}>
                {label}
              </option>
            ))}
          </optgroup>
        </Select>
      </Field>
      <Field label="Why do you need it?" hint="The team's admins see this">
        <Input
          value={form.reason}
          onChange={(e) => setForm({ ...form, reason: e.target.value })}
          required
          minLength={3}
          maxLength={500}
          placeholder="e.g. Comparing our quarter with Finance"
        />
      </Field>
      <Field label="For how long?">
        <Select
          value={form.days}
          onChange={(e) => setForm({ ...form, days: e.target.value })}
        >
          {DURATIONS.map((d) => (
            <option key={d} value={d}>
              {days(d)}
            </option>
          ))}
        </Select>
      </Field>
      <Notice>{error}</Notice>
      <Button type="submit">Send request</Button>
    </form>
  );
}

/** One granted figure: the current value and its last 24 hours, read through the grant. */
function SharedFigure({ request }: { request: AccessRequest }) {
  const [to] = useState(() => new Date().toISOString());
  const [from] = useState(() =>
    new Date(Date.now() - 24 * 3600e3).toISOString()
  );
  const summary = useApi<{ current: number | null; previous: number | null }>(
    `/shared/${request.id}/summary?range=24h`
  );
  const series = useApi<{ points: Point[] }>(
    `/shared/${request.id}/series?from=${from}&to=${to}&bucket=1h`
  );
  const source = sourceOf(request);
  return (
    <Card className="grid gap-3 p-5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="font-semibold">
          {figure(request)}{" "}
          <span className="text-ink-3">· {request.team_name}</span>
        </h3>
        <span className="text-xs text-ink-3">
          Read-only · until {date(request.expires_at!)}
        </span>
      </div>
      <div className="h-24">
        {summary.data ? (
          <StatTile
            source={source}
            current={summary.data.current}
            previous={summary.data.previous}
          />
        ) : summary.error ? (
          <Notice>{errorText(summary.error)}</Notice>
        ) : (
          <Spinner />
        )}
      </div>
      <div className="h-48 rounded-xl border border-white/10 bg-black p-3">
        {series.data ? (
          <SeriesChart
            points={series.data.points}
            source={source}
            kind="line"
          />
        ) : (
          <Spinner />
        )}
      </div>
    </Card>
  );
}

function Review({
  request,
  onDone,
}: {
  request: AccessRequest;
  onDone: (message: string) => void;
}) {
  const [duration, setDuration] = useState(String(request.days));
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  const act = async (path: string, body?: object, message = "Done") => {
    try {
      await api(`/access-requests/${request.id}/${path}`, "POST", body);
      onDone(message);
    } catch (err) {
      setError(errorText(err));
    }
  };
  const status = statusOf(request);
  return (
    <li className="grid gap-3 rounded-xl border border-white/10 bg-black p-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">{request.requester_name}</span>
        <span className="text-ink-2">
          asks to see <b className="text-ink">{figure(request)}</b> of{" "}
          {request.team_name} for {days(request.days)}
        </span>
        <span
          className={cx(
            "ml-auto rounded-full px-2 py-0.5 text-[11px] font-medium",
            STATUS[status].tone
          )}
        >
          {STATUS[status].label}
        </span>
      </div>
      <p className="text-sm text-ink-3">“{request.reason}”</p>
      {request.status === "pending" && (
        <div className="flex flex-wrap items-end gap-2">
          <label className="grid gap-1 text-xs text-ink-3">
            Allow for
            <Select
              className="h-10 w-32"
              value={duration}
              onChange={(e) => setDuration(e.target.value)}
            >
              {DURATIONS.map((d) => (
                <option key={d} value={d}>
                  {days(d)}
                </option>
              ))}
            </Select>
          </label>
          <label className="grid min-w-48 flex-1 gap-1 text-xs text-ink-3">
            Note (optional)
            <Input
              value={note}
              onChange={(e) => setNote(e.target.value)}
              maxLength={500}
              placeholder="Shown to the requester"
            />
          </label>
          <Button
            onClick={() =>
              act(
                "decide",
                { approve: true, days: Number(duration), note },
                `Approved for ${days(Number(duration))}`
              )
            }
          >
            <Check size={16} /> Approve
          </Button>
          <Button
            variant="danger"
            onClick={() => act("decide", { approve: false, note }, "Declined")}
          >
            <X size={16} /> Decline
          </Button>
        </div>
      )}
      {status === "approved" && (
        <div className="flex items-center justify-between gap-2 text-xs text-ink-3">
          Until {date(request.expires_at!)}
          <Button
            variant="ghost"
            onClick={() => act("revoke", undefined, "Access ended")}
          >
            <Ban size={14} /> End access now
          </Button>
        </div>
      )}
      <Notice>{error}</Notice>
    </li>
  );
}

export default function SharedDataPage() {
  const { active_membership: active } = useSession();
  const mine = useApi<AccessRequest[]>("/access-requests?box=mine");
  const isAdmin = !!active && ADMINS.includes(active.role);
  const incoming = useApi<AccessRequest[]>(
    isAdmin ? "/access-requests?box=incoming" : null
  );
  const directory = useApi<DirectoryTeam[]>("/teams/directory");
  const [asking, setAsking] = useState(false);
  const [notice, setNotice] = useState("");
  // A decision or a new request arrives as a notification: refresh the lists.
  useSocketEvent("notifications:new", () => {
    mine.reload();
    incoming.reload();
  });

  const granted = (mine.data ?? []).filter((r) => r.active);
  const others = (directory.data ?? []).filter((t) => t.id !== active?.team_id);

  return (
    <>
      <PageHeader
        title="Shared data"
        subtitle="Ask another team to share one figure with you, for a limited time. You see only that figure, read-only."
        actions={
          active?.team_id && (
            <Button onClick={() => setAsking(true)}>
              <Plus size={16} /> Ask for access
            </Button>
          )
        }
      />
      {notice && (
        <div className="mb-4" onClick={() => setNotice("")}>
          <Notice tone="success">{notice}</Notice>
        </div>
      )}

      {isAdmin && (
        <section className="mb-8">
          <h2 className="mb-3 text-sm font-semibold tracking-wide text-ink-2 uppercase">
            Requests to review
          </h2>
          {incoming.loading ? (
            <Spinner />
          ) : (incoming.data ?? []).length ? (
            <ul className="grid gap-3">
              {incoming.data!.map((r) => (
                <Review
                  key={r.id}
                  request={r}
                  onDone={(message) => {
                    setNotice(message);
                    incoming.reload();
                  }}
                />
              ))}
            </ul>
          ) : (
            <p className="text-sm text-ink-3">No requests for your team.</p>
          )}
        </section>
      )}

      <section className="mb-8">
        <h2 className="mb-3 text-sm font-semibold tracking-wide text-ink-2 uppercase">
          Shared with me
        </h2>
        {granted.length ? (
          <div className="grid gap-4 lg:grid-cols-2">
            {granted.map((r) => (
              <SharedFigure key={r.id} request={r} />
            ))}
          </div>
        ) : (
          <p className="text-sm text-ink-3">
            Nothing shared with you right now.
          </p>
        )}
      </section>

      <section>
        <h2 className="mb-3 text-sm font-semibold tracking-wide text-ink-2 uppercase">
          My requests
        </h2>
        {(mine.data ?? []).length ? (
          <ul className="grid gap-2">
            {mine.data!.map((r) => {
              const status = statusOf(r);
              return (
                <li
                  key={r.id}
                  className="flex flex-wrap items-center gap-2 rounded-xl border border-white/10 bg-black px-4 py-3 text-sm"
                >
                  <b>{figure(r)}</b>
                  <span className="text-ink-2">of {r.team_name}</span>
                  <Badge>{days(r.days)}</Badge>
                  <span
                    className={cx(
                      "ml-auto rounded-full px-2 py-0.5 text-[11px] font-medium",
                      STATUS[status].tone
                    )}
                  >
                    {STATUS[status].label}
                  </span>
                  {r.decision_note && (
                    <span className="w-full text-xs text-ink-3">
                      “{r.decision_note}”
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="text-sm text-ink-3">
            You haven&apos;t asked for anything yet.
          </p>
        )}
      </section>

      <Modal
        open={asking}
        onClose={() => setAsking(false)}
        title="Ask for access"
      >
        <AskForm
          teams={others}
          onSent={() => {
            setAsking(false);
            setNotice("Request sent. The team's admins have been notified.");
            mine.reload();
          }}
        />
      </Modal>
    </>
  );
}
