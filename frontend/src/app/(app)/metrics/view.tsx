"use client";

import { Pencil, Plus, Sigma, Trash2 } from "lucide-react";
import { type FormEvent, useEffect, useState } from "react";
import { SeriesChart } from "@/components/charts";
import { PageHeader } from "@/components/page-header";
import { useSession } from "@/components/session";
import {
  Badge,
  Button,
  Card,
  Field,
  IconButton,
  Input,
  Modal,
  Notice,
  Select,
  Spinner,
} from "@/components/ui";
import { api, ApiError, errorText } from "@/lib/api";
import {
  type CustomMetric,
  EDITORS,
  METRIC_LABEL,
  type MetricUnit,
  type Point,
  type Team,
  UNIT_LABEL,
} from "@/lib/types";
import { useApi } from "@/lib/use-api";

const EXAMPLES = [
  "revenue / users",
  "(clicks - errors) / page_views * 100",
  "revenue / (clicks + 1)",
];

/**
 * Live check while typing: the server parses the formula (the same parser that saves it) and
 * returns the last 24 hours, so the author sees either the exact problem or the real curve.
 */
function useFormulaPreview(formula: string, teamId: string) {
  const [state, setState] = useState<{
    points?: Point[];
    error?: string;
    loading: boolean;
  }>({ loading: false });
  useEffect(() => {
    if (!formula.trim() || !teamId) return;
    let live = true;
    const timer = window.setTimeout(() => {
      const to = new Date();
      const from = new Date(to.getTime() - 24 * 3600e3);
      setState((s) => ({ ...s, loading: true }));
      api<{ points: Point[] }>(
        `/metrics/formula?formula=${encodeURIComponent(formula)}&from=${from.toISOString()}&to=${to.toISOString()}&bucket=1h&team_id=${teamId}`
      ).then(
        (data) => live && setState({ points: data.points, loading: false }),
        (err) =>
          live &&
          setState({
            error:
              err instanceof ApiError && err.errors[0]
                ? `${err.errors[0].message}${
                    "position" in err.errors[0]
                      ? ` (at character ${(err.errors[0] as { position: number }).position + 1})`
                      : ""
                  }`
                : errorText(err),
            loading: false,
          })
      );
    }, 400);
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [formula, teamId]);
  return formula.trim() ? state : { loading: false };
}

function MetricForm({
  initial,
  teams,
  defaultTeam,
  onSaved,
}: {
  initial?: CustomMetric;
  teams?: Team[];
  defaultTeam: string;
  onSaved: () => void;
}) {
  const [form, setForm] = useState({
    name: initial?.name ?? "",
    formula: initial?.formula ?? "",
    unit: initial?.unit ?? ("number" as MetricUnit),
    team_id: initial?.team_id ?? defaultTeam,
  });
  const [error, setError] = useState("");
  const preview = useFormulaPreview(form.formula, form.team_id);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const fields = { name: form.name, formula: form.formula, unit: form.unit };
    try {
      if (initial)
        await api(`/custom-metrics/${initial.id}`, "PATCH", {
          ...fields,
          version: initial.version,
        });
      else await api("/custom-metrics", "POST", teams ? form : fields);
      onSaved();
    } catch (err) {
      setError(
        err instanceof ApiError && err.status === 409
          ? "Someone else changed this metric first. Close and reopen it to see the latest version."
          : errorText(err)
      );
    }
  };

  return (
    <form onSubmit={submit} className="grid gap-4">
      {teams && !initial && (
        <Field label="Team">
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
      )}
      <Field label="Name">
        <Input
          value={form.name}
          onChange={(e) => setForm({ ...form, name: e.target.value })}
          required
          maxLength={60}
          autoFocus
        />
      </Field>
      <Field
        label="Formula"
        hint={`Use ${Object.keys(METRIC_LABEL).join(", ")}, numbers, + - * / and parentheses. Each value is computed from the totals of its time bucket.`}
      >
        <Input
          value={form.formula}
          onChange={(e) => setForm({ ...form, formula: e.target.value })}
          required
          maxLength={200}
          spellCheck={false}
          className="font-mono"
          placeholder={EXAMPLES[1]}
          aria-invalid={!!preview.error}
        />
      </Field>
      <div className="flex flex-wrap gap-2 text-xs text-ink-3">
        Try:
        {EXAMPLES.map((example) => (
          <button
            key={example}
            type="button"
            onClick={() => setForm({ ...form, formula: example })}
            className="rounded-full border border-white/10 px-2.5 py-0.5 font-mono text-ink-2 hover:text-ink"
          >
            {example}
          </button>
        ))}
      </div>
      <Field label="Shown as">
        <Select
          value={form.unit}
          onChange={(e) =>
            setForm({ ...form, unit: e.target.value as MetricUnit })
          }
        >
          {Object.entries(UNIT_LABEL).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </Select>
      </Field>

      <div
        className="h-40 rounded-xl border border-white/10 bg-black p-3"
        aria-live="polite"
      >
        {preview.error ? (
          <Notice>{preview.error}</Notice>
        ) : preview.points ? (
          <SeriesChart
            points={preview.points}
            source={{
              custom: {
                id: "preview",
                name: form.name || "Preview",
                unit: form.unit,
              },
            }}
            kind="line"
          />
        ) : preview.loading ? (
          <Spinner label="Checking" />
        ) : (
          <p className="grid h-full place-items-center text-sm text-ink-3">
            A preview of the last 24 hours appears here.
          </p>
        )}
      </div>

      <Notice>{error}</Notice>
      <Button type="submit">{initial ? "Save" : "Create metric"}</Button>
    </form>
  );
}

/**
 * Tier 3 D: custom metric definitions, per team (Prompt 48). Editors and up define them;
 * everyone in the team can chart them (Add widget → "Shows" → Custom metrics).
 */
export default function CustomMetricsPage() {
  const { active_membership: active } = useSession();
  const metrics = useApi<CustomMetric[]>("/custom-metrics");
  const teams = useApi<Team[]>("/teams");
  const [modal, setModal] = useState<
    { kind: "create" } | { kind: "edit"; metric: CustomMetric } | null
  >(null);
  const [notice, setNotice] = useState("");
  const canEdit = !!active && EDITORS.includes(active.role);
  const orgWide = !active?.team_id;
  const teamName = (id: string) =>
    teams.data?.find((t) => t.id === id)?.name ?? "";

  const remove = async (metric: CustomMetric) => {
    if (!confirm(`Delete "${metric.name}"?`)) return;
    try {
      await api(`/custom-metrics/${metric.id}`, "DELETE");
      setNotice("");
      metrics.reload();
    } catch (err) {
      setNotice(errorText(err)); // e.g. still used by widgets, which the API names
    }
  };

  return (
    <>
      <PageHeader
        title="Custom metrics"
        subtitle="Define your own metrics as formulas over revenue, page views, clicks, errors and active users, then chart them like any other metric."
        actions={
          canEdit && (
            <Button onClick={() => setModal({ kind: "create" })}>
              <Plus size={16} /> New metric
            </Button>
          )
        }
      />
      <div className="mb-4">
        <Notice>
          {notice || (metrics.error ? errorText(metrics.error) : "")}
        </Notice>
      </div>

      {metrics.loading ? (
        <Spinner />
      ) : !metrics.data?.length ? (
        <Card className="p-10 text-center text-sm text-ink-2">
          No custom metrics yet.
          {canEdit && " Create one with New metric."}
        </Card>
      ) : (
        <ul className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {metrics.data.map((m) => (
            <li
              key={m.id}
              className="flex items-start gap-3 rounded-2xl border border-white/10 bg-black p-5"
            >
              <span className="grid size-10 shrink-0 place-items-center rounded-lg bg-accent/10 text-accent">
                <Sigma size={18} />
              </span>
              <div className="min-w-0 flex-1">
                <div className="truncate font-medium">{m.name}</div>
                <code className="mt-1 block truncate text-sm text-ink-2">
                  {m.formula}
                </code>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  <Badge>{UNIT_LABEL[m.unit]}</Badge>
                  {orgWide && (
                    <Badge tone="accent">{teamName(m.team_id)}</Badge>
                  )}
                </div>
              </div>
              {canEdit && (
                <div className="flex">
                  <IconButton
                    label={`Edit ${m.name}`}
                    onClick={() => setModal({ kind: "edit", metric: m })}
                  >
                    <Pencil size={15} />
                  </IconButton>
                  <IconButton
                    label={`Delete ${m.name}`}
                    tone="danger"
                    onClick={() => remove(m)}
                  >
                    <Trash2 size={15} />
                  </IconButton>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      <Modal
        open={!!modal}
        onClose={() => setModal(null)}
        title={
          modal?.kind === "edit" ? "Edit custom metric" : "New custom metric"
        }
      >
        {modal && (
          <MetricForm
            initial={modal.kind === "edit" ? modal.metric : undefined}
            teams={orgWide ? (teams.data ?? []) : undefined}
            defaultTeam={active?.team_id ?? teams.data?.[0]?.id ?? ""}
            onSaved={() => {
              setModal(null);
              metrics.reload();
            }}
          />
        )}
      </Modal>
    </>
  );
}
