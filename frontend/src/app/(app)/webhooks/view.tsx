"use client";

import {
  ChevronRight,
  KeyRound,
  Plus,
  Power,
  RefreshCw,
  RotateCw,
  Send,
  Trash2,
} from "lucide-react";
import { type FormEvent, useState } from "react";
import { CopyValue } from "@/components/copy-value";
import { PageHeader } from "@/components/page-header";
import { useSession } from "@/components/session";
import {
  Badge,
  Button,
  Card,
  cx,
  Field,
  IconButton,
  Input,
  Modal,
  Notice,
  Select,
  Spinner,
} from "@/components/ui";
import { api, errorText } from "@/lib/api";
import {
  type Delivery,
  type Project,
  type Team,
  EVENT_LABEL,
  FORMAT_NAME,
  type Webhook,
  WEBHOOK_EVENTS,
  type WebhookEvent,
  type WebhookFormat,
} from "@/lib/types";
import { useSocketEvent } from "@/lib/realtime";
import { useApi } from "@/lib/use-api";

const STATUS_TONE: Record<Delivery["status"], string> = {
  delivered: "bg-accent/15 text-accent",
  pending: "bg-warn/15 text-warn",
  sending: "bg-warn/15 text-warn",
  failed: "bg-danger/15 text-danger",
};

const time = (iso: string) =>
  new Date(iso).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });

// F5 (Prompt 68): set up by picking an app, not by reading a spec. Each chat app gets readable
// messages in its own format; "Developer endpoint" keeps the signed Standard Webhooks JSON.
const DESTINATIONS: {
  format: WebhookFormat;
  name: string;
  hint: string;
  how: string[];
  help: string | null;
  placeholder: string;
}[] = [
  {
    format: "slack",
    name: "Slack",
    hint: "Messages in a Slack channel",
    how: [
      "In Slack, create an app (or open yours) and turn on Incoming Webhooks.",
      "Choose Add New Webhook, pick the channel, then copy the link.",
    ],
    help: "https://docs.slack.dev/messaging/sending-messages-using-incoming-webhooks",
    placeholder: "https://hooks.slack.com/services/…",
  },
  {
    format: "teams",
    name: "Microsoft Teams",
    hint: "Messages in a Teams channel",
    how: [
      "In the channel, open More options (…) → Workflows.",
      "Choose “Send webhook alerts to a channel”, save, then copy the link.",
    ],
    help: "https://support.microsoft.com/en-us/office/create-incoming-webhooks-with-workflows-for-microsoft-teams-8ae491c7-0394-4861-ba59-055e33f75498",
    placeholder: "https://…/workflows/…",
  },
  {
    format: "discord",
    name: "Discord",
    hint: "Messages in a Discord channel",
    how: [
      "Open the channel's settings → Integrations → Webhooks → New Webhook.",
      "Choose Copy Webhook URL.",
    ],
    help: "https://support.discord.com/hc/en-us/articles/228383668-Intro-to-Webhooks",
    placeholder: "https://discord.com/api/webhooks/…",
  },
  {
    format: "standard",
    name: "Developer endpoint",
    hint: "Signed JSON for your own system",
    how: [
      "Any HTTPS address that accepts POST requests.",
      "Each message is signed (Standard Webhooks); you'll get the secret to verify it.",
    ],
    help: "https://github.com/standard-webhooks/standard-webhooks/blob/main/spec/standard-webhooks.md",
    placeholder: "https://example.com/hooks/aafm",
  },
];

function WebhookForm({
  teams,
  projects,
  defaultTeam,
  onCreated,
}: {
  teams?: Team[];
  projects: Project[];
  defaultTeam: string;
  onCreated: (created: Webhook & { secret: string }) => void;
}) {
  const [form, setForm] = useState({
    format: "slack" as WebhookFormat,
    team_id: defaultTeam,
    url: "",
    description: "",
    project_id: "",
    events: ["alert.opened", "alert.resolved"] as WebhookEvent[],
  });
  const [error, setError] = useState("");
  const destination = DESTINATIONS.find((d) => d.format === form.format)!;
  const toggle = (event: WebhookEvent) =>
    setForm({
      ...form,
      events: form.events.includes(event)
        ? form.events.filter((e) => e !== event)
        : [...form.events, event],
    });

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    try {
      onCreated(
        await api<Webhook & { secret: string }>("/webhooks", "POST", {
          ...(teams && { team_id: form.team_id }),
          format: form.format,
          url: form.url.trim(),
          description: form.description,
          project_id: form.project_id || null,
          events: form.events,
        })
      );
    } catch (err) {
      setError(errorText(err));
    }
  };

  return (
    <form onSubmit={submit} className="grid gap-5">
      <fieldset className="grid gap-2 text-sm">
        <legend className="mb-1.5 text-ink-2">
          1. Where should we send updates?
        </legend>
        <div className="grid grid-cols-2 gap-2">
          {DESTINATIONS.map((d) => (
            <button
              key={d.format}
              type="button"
              onClick={() => setForm({ ...form, format: d.format })}
              aria-pressed={form.format === d.format}
              className={cx(
                "rounded-xl border px-3 py-2.5 text-left transition",
                form.format === d.format
                  ? "border-accent/60 bg-accent/10"
                  : "border-white/10 bg-black/30 hover:bg-glass-strong"
              )}
            >
              <span className="block font-medium">{d.name}</span>
              <span className="block text-xs text-ink-3">{d.hint}</span>
            </button>
          ))}
        </div>
      </fieldset>

      <div className="grid gap-2">
        <span className="text-sm text-ink-2">
          2. Paste the{" "}
          {destination.format === "standard"
            ? "address"
            : `${destination.name} link`}
        </span>
        <ol className="list-decimal space-y-1 pl-5 text-xs text-ink-3">
          {destination.how.map((step) => (
            <li key={step}>{step}</li>
          ))}
        </ol>
        {destination.help && (
          <a
            href={destination.help}
            target="_blank"
            rel="noreferrer"
            className="w-fit text-xs text-accent hover:underline"
          >
            How do I get this link?
          </a>
        )}
        <Input
          type="url"
          value={form.url}
          onChange={(e) => setForm({ ...form, url: e.target.value })}
          required
          maxLength={2000}
          placeholder={destination.placeholder}
          aria-label={`${destination.name} link`}
          autoFocus
        />
      </div>

      <fieldset className="grid gap-2 text-sm">
        <legend className="mb-1.5 text-ink-2">
          3. What should we tell you about?
        </legend>
        <div className="grid gap-2">
          {WEBHOOK_EVENTS.map((event) => (
            <label
              key={event}
              className="flex cursor-pointer items-center gap-2.5 rounded-lg border border-white/10 bg-black/30 px-3 py-2"
            >
              <input
                type="checkbox"
                checked={form.events.includes(event)}
                onChange={() => toggle(event)}
                className="accent-[var(--color-accent)]"
              />
              {EVENT_LABEL[event]}
            </label>
          ))}
        </div>
      </fieldset>

      <details className="text-sm">
        <summary className="cursor-pointer text-ink-2">More options</summary>
        <div className="mt-3 grid gap-4">
          {teams && (
            <Field label="Team">
              <Select
                value={form.team_id}
                onChange={(e) =>
                  setForm({ ...form, team_id: e.target.value, project_id: "" })
                }
              >
                {teams.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </Select>
            </Field>
          )}
          <Field label="Only for one project">
            <Select
              value={form.project_id}
              onChange={(e) => setForm({ ...form, project_id: e.target.value })}
            >
              <option value="">All projects in the team</option>
              {projects
                .filter((p) => p.team_id === form.team_id)
                .map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
            </Select>
          </Field>
          <Field label="Name" hint="Optional, e.g. #finance-alerts">
            <Input
              value={form.description}
              onChange={(e) =>
                setForm({ ...form, description: e.target.value })
              }
              maxLength={200}
            />
          </Field>
        </div>
      </details>

      <Notice>{error}</Notice>
      <Button type="submit" disabled={!form.events.length}>
        Connect {destination.name}
      </Button>
    </form>
  );
}

function Deliveries({ hook }: { hook: Webhook }) {
  const { data, loading, reload } = useApi<Delivery[]>(
    `/webhooks/${hook.id}/deliveries`
  );
  // Each attempt (and each failure) shows up as it happens (Prompt 50).
  useSocketEvent<{ webhook_id: string }>("webhooks:changed", (e) => {
    if (e.webhook_id === hook.id) reload();
  });
  const [open, setOpen] = useState<string | null>(null);
  const [notice, setNotice] = useState("");

  const redeliver = async (id: string) => {
    try {
      await api(`/webhook-deliveries/${id}/redeliver`, "POST");
      setNotice("Queued again with the same webhook-id.");
      reload();
    } catch (err) {
      setNotice(errorText(err));
    }
  };

  return (
    <div className="mt-4 border-t border-white/10 pt-4">
      <div className="mb-3 flex items-center justify-between">
        <h3 className="text-sm font-medium">Recent deliveries</h3>
        <IconButton label="Refresh deliveries" onClick={reload}>
          <RefreshCw size={15} />
        </IconButton>
      </div>
      {notice && (
        <div className="mb-3" onClick={() => setNotice("")}>
          <Notice tone="info">{notice}</Notice>
        </div>
      )}
      {loading ? (
        <Spinner />
      ) : !data?.length ? (
        <p className="text-sm text-ink-3">
          Nothing sent yet. Use Send test, or wait for a subscribed event.
        </p>
      ) : (
        <ul className="grid gap-2">
          {data.map((d) => (
            <li
              key={d.id}
              className="rounded-xl border border-white/10 bg-black/40"
            >
              <button
                type="button"
                onClick={() => setOpen(open === d.id ? null : d.id)}
                aria-expanded={open === d.id}
                className="flex w-full flex-wrap items-center gap-3 px-3 py-2.5 text-left text-sm"
              >
                <ChevronRight
                  size={14}
                  className={cx(
                    "text-ink-3 transition",
                    open === d.id && "rotate-90"
                  )}
                />
                <code className="text-xs">{d.event}</code>
                <span
                  className={cx(
                    "rounded-full px-2 py-0.5 text-[11px] font-medium",
                    STATUS_TONE[d.status]
                  )}
                >
                  {d.status}
                </span>
                <span className="text-xs text-ink-3">
                  attempt {d.attempt}
                  {d.response_code ? ` · HTTP ${d.response_code}` : ""}
                </span>
                <span className="ml-auto text-xs text-ink-3">
                  {time(d.created_at)}
                </span>
              </button>
              {open === d.id && (
                <div className="grid gap-2 border-t border-white/10 px-3 py-3 text-xs">
                  {d.last_error && (
                    <p className="text-danger">Last error: {d.last_error}</p>
                  )}
                  {d.status === "pending" && d.attempt > 0 && (
                    <p className="text-ink-2">
                      Next attempt: {time(d.next_attempt_at)}
                    </p>
                  )}
                  <p className="text-ink-3">
                    webhook-id <code className="text-ink-2">{d.event_id}</code>
                  </p>
                  <pre className="max-h-48 overflow-auto rounded-lg bg-black p-3 text-ink-2">
                    {JSON.stringify(JSON.parse(d.body), null, 2)}
                  </pre>
                  <div>
                    <Button variant="ghost" onClick={() => redeliver(d.id)}>
                      <RotateCw size={14} /> Redeliver
                    </Button>
                  </div>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * Tier 3 C: webhook subscriptions per team (Prompt 48), for Admins and the Super Admin.
 * Messages follow the Standard Webhooks spec: headers webhook-id, webhook-timestamp and
 * webhook-signature (HMAC-SHA256 with the endpoint's whsec_ secret).
 */
export default function WebhooksPage() {
  const { active_membership: active } = useSession();
  const hooks = useApi<Webhook[]>("/webhooks");
  const teams = useApi<Team[]>("/teams");
  const projects = useApi<Project[]>("/projects");
  useSocketEvent("webhooks:changed", () => hooks.reload());
  const [creating, setCreating] = useState(false);
  const [secret, setSecret] = useState<{ value: string; rotated: boolean }>();
  const [expanded, setExpanded] = useState<string | null>(null);
  const [notice, setNotice] = useState<{
    tone: "error" | "success";
    text: string;
  }>();
  const orgWide = !active?.team_id;
  const name = (list: { id: string; name: string }[] | undefined, id: string) =>
    list?.find((x) => x.id === id)?.name ?? "";

  const run = async (action: () => Promise<unknown>, success: string) => {
    try {
      await action();
      setNotice({ tone: "success", text: success });
    } catch (err) {
      setNotice({ tone: "error", text: errorText(err) });
    }
    hooks.reload();
  };

  return (
    <>
      <PageHeader
        title="Webhooks"
        subtitle="Notify external systems when alerts fire, dashboards change or members join and leave. Every failed delivery is also recorded in the Audit log."
        actions={
          <Button onClick={() => setCreating(true)}>
            <Plus size={16} /> Add endpoint
          </Button>
        }
      />
      {notice && (
        <div className="mb-4" onClick={() => setNotice(undefined)}>
          <Notice tone={notice.tone}>{notice.text}</Notice>
        </div>
      )}
      {hooks.error && <Notice>{errorText(hooks.error)}</Notice>}

      {hooks.loading ? (
        <Spinner />
      ) : !hooks.data?.length ? (
        <Card className="p-10 text-center text-sm text-ink-2">
          No endpoints yet. Add one to start receiving events.
        </Card>
      ) : (
        <ul className="grid gap-4">
          {hooks.data.map((hook) => (
            <li key={hook.id}>
              <Card className="p-5">
                <div className="flex flex-wrap items-start gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium">
                        {hook.description || FORMAT_NAME[hook.format]}
                      </span>
                      <Badge>{FORMAT_NAME[hook.format]}</Badge>
                      <code className="truncate text-xs text-ink-3">
                        {new URL(hook.url).host}
                      </code>
                      <Badge tone={hook.enabled ? "accent" : "neutral"}>
                        {hook.enabled ? "Enabled" : "Disabled"}
                      </Badge>
                      {hook.last_status && (
                        <span
                          className={cx(
                            "rounded-full px-2 py-0.5 text-[11px] font-medium",
                            STATUS_TONE[hook.last_status]
                          )}
                        >
                          last: {hook.last_status}
                        </span>
                      )}
                    </div>
                    <p className="mt-1 text-xs text-ink-3">
                      {orgWide && `${name(teams.data, hook.team_id)} · `}
                      {hook.project_id
                        ? name(projects.data, hook.project_id)
                        : "All projects"}
                      {hook.failure_count > 0 &&
                        ` · ${hook.failure_count} failed attempt${hook.failure_count > 1 ? "s" : ""} in a row`}
                    </p>
                    {hook.disabled_reason && !hook.enabled && (
                      <p className="mt-1 text-xs text-danger">
                        {hook.disabled_reason}
                      </p>
                    )}
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      {hook.events.map((e) => (
                        <Badge key={e}>{EVENT_LABEL[e]}</Badge>
                      ))}
                    </div>
                  </div>
                  <div className="flex flex-wrap items-center gap-1">
                    <IconButton
                      label="Send test event"
                      onClick={() =>
                        run(
                          () => api(`/webhooks/${hook.id}/test`, "POST"),
                          "Test event queued. Open the deliveries to follow it."
                        )
                      }
                    >
                      <Send size={15} />
                    </IconButton>
                    <IconButton
                      label={hook.enabled ? "Disable" : "Enable"}
                      onClick={() =>
                        run(
                          () =>
                            api(`/webhooks/${hook.id}`, "PATCH", {
                              enabled: !hook.enabled,
                            }),
                          hook.enabled
                            ? "Endpoint disabled"
                            : "Endpoint enabled"
                        )
                      }
                    >
                      <Power size={15} />
                    </IconButton>
                    <IconButton
                      label="Rotate signing secret"
                      onClick={async () => {
                        if (
                          !confirm(
                            "Create a new signing secret? The current one keeps working for 24 hours."
                          )
                        )
                          return;
                        try {
                          const res = await api<{ secret: string }>(
                            `/webhooks/${hook.id}/rotate-secret`,
                            "POST"
                          );
                          setSecret({ value: res.secret, rotated: true });
                        } catch (err) {
                          setNotice({ tone: "error", text: errorText(err) });
                        }
                      }}
                    >
                      <KeyRound size={15} />
                    </IconButton>
                    <IconButton
                      label="Delete endpoint"
                      tone="danger"
                      onClick={() =>
                        confirm(`Delete the endpoint ${hook.url}?`) &&
                        run(
                          () => api(`/webhooks/${hook.id}`, "DELETE"),
                          "Endpoint deleted"
                        )
                      }
                    >
                      <Trash2 size={15} />
                    </IconButton>
                    <Button
                      variant="ghost"
                      onClick={() =>
                        setExpanded(expanded === hook.id ? null : hook.id)
                      }
                      aria-expanded={expanded === hook.id}
                    >
                      Deliveries
                    </Button>
                  </div>
                </div>
                {expanded === hook.id && <Deliveries hook={hook} />}
              </Card>
            </li>
          ))}
        </ul>
      )}

      <Modal
        open={creating}
        onClose={() => setCreating(false)}
        title="Add webhook endpoint"
      >
        <WebhookForm
          teams={orgWide ? (teams.data ?? []) : undefined}
          projects={projects.data ?? []}
          defaultTeam={active?.team_id ?? teams.data?.[0]?.id ?? ""}
          onCreated={(created) => {
            setCreating(false);
            // Only developer endpoints verify signatures; chat apps don't need the secret.
            if (created.format === "standard")
              setSecret({ value: created.secret, rotated: false });
            else
              setNotice({
                tone: "success",
                text: `Connected to ${FORMAT_NAME[created.format]}. Use the send button (paper plane) to post a test message.`,
              });
            hooks.reload();
          }}
        />
      </Modal>

      <Modal
        open={!!secret}
        onClose={() => setSecret(undefined)}
        title={secret?.rotated ? "New signing secret" : "Signing secret"}
      >
        {secret && (
          <div className="grid gap-4">
            <Notice tone="info">
              Use this secret to verify the webhook-signature header. It is
              shown only once.
              {secret.rotated &&
                " The previous secret keeps signing for 24 hours, so switch your receiver before then."}
            </Notice>
            <CopyValue value={secret.value} label="secret" />
            <div className="flex justify-end">
              <Button onClick={() => setSecret(undefined)}>Done</Button>
            </div>
          </div>
        )}
      </Modal>
    </>
  );
}
