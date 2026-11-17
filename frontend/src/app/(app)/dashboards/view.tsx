"use client";

import { Plus } from "lucide-react";
import Image from "next/image";
import { useRouter } from "next/navigation";
import { type FormEvent, useState } from "react";
import { StatTile } from "@/components/charts";
import { DashboardBoard } from "@/components/dashboard-board";
import { useSession } from "@/components/session";
import {
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
import {
  type Dashboard,
  EDITORS,
  METRIC_LABEL,
  ROLE_LABEL,
  type SummaryRow,
  type Team,
} from "@/lib/types";
import { useApi } from "@/lib/use-api";

function CreateDashboard({
  teams,
  onClose,
}: {
  teams: Team[];
  onClose: () => void;
}) {
  const router = useRouter();
  const { active_membership: active } = useSession();
  const orgWide = !active?.team_id;
  const [name, setName] = useState("");
  const [teamId, setTeamId] = useState(teams[0]?.id ?? "");
  const [error, setError] = useState("");

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    try {
      const created = await api<Dashboard>(
        "/dashboards",
        "POST",
        orgWide ? { name, team_id: teamId } : { name }
      );
      router.push(`/dashboards/${created.id}`);
    } catch (err) {
      setError(errorText(err));
    }
  };

  return (
    <form onSubmit={submit} className="grid gap-4">
      <Field label="Name">
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
          maxLength={100}
          autoFocus
        />
      </Field>
      {orgWide && (
        <Field label="Team">
          <Select
            value={teamId}
            onChange={(e) => setTeamId(e.target.value)}
            required
          >
            {teams.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </Select>
        </Field>
      )}
      <Notice>{error}</Notice>
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button type="submit">Create</Button>
      </div>
    </form>
  );
}

/**
 * Dashboard home (Prompt 27): banner and team totals, then the selected dashboard itself.
 * With several dashboards a pill switcher appears at the top of the board; `selectedId`
 * comes from /dashboards/<id> so a switch is also a shareable deep link.
 */
export function DashboardsHome({ selectedId }: { selectedId?: string }) {
  const router = useRouter();
  const { active_membership: active, user } = useSession();
  const dashboards = useApi<Dashboard[]>("/dashboards");
  const teams = useApi<Team[]>("/teams");
  const summary = useApi<{ metrics: SummaryRow[] }>(
    "/metrics/summary?range=24h"
  );
  const [creating, setCreating] = useState(false);
  const canEdit = !!active && EDITORS.includes(active.role);
  const orgWide = !active?.team_id;
  const teamName = (id: string) =>
    teams.data?.find((t) => t.id === id)?.name ?? "";

  const list = dashboards.data ?? [];
  const boardId = selectedId ?? list[0]?.id;

  const switcher = list.length > 1 && (
    <div
      role="tablist"
      aria-label="Dashboards"
      className="flex max-w-full overflow-x-auto rounded-xl border border-white/10 bg-black p-1"
    >
      {list.map((d) => (
        <button
          key={d.id}
          role="tab"
          aria-selected={d.id === boardId}
          onClick={() => router.push(`/dashboards/${d.id}`)}
          className={cx(
            "shrink-0 rounded-lg px-4 py-2 text-sm whitespace-nowrap transition",
            d.id === boardId
              ? "bg-ink font-semibold text-black"
              : "text-ink-2 hover:text-ink"
          )}
        >
          {d.name}
          {orgWide && (
            <span
              className={cx(
                "ml-2 text-xs",
                d.id === boardId ? "text-black/60" : "text-ink-3"
              )}
            >
              {teamName(d.team_id)}
            </span>
          )}
        </button>
      ))}
    </div>
  );

  return (
    <>
      {/* Hero banner (Prompts 20-24): black panel with a green glow; the glass-panes render
          is blended with `screen` so its own black backdrop merges into the panel. The image
          box has the render's exact aspect ratio (952x736) so the radial fade follows the
          image and no hard frame edge shows. */}
      <section className="relative mb-6 overflow-hidden rounded-2xl border border-[#3b7a57]/30 bg-black bg-[radial-gradient(45%_110%_at_80%_50%,rgb(31_92_60/0.55),transparent_70%),radial-gradient(40%_90%_at_0%_0%,rgb(47_125_85/0.22),transparent_70%)] shadow-[inset_0_1px_0_rgb(255_255_255/0.06),0_30px_80px_-30px_rgb(15_51_35/0.9)]">
        <div
          aria-hidden
          className="absolute top-1/2 right-[4%] hidden aspect-[952/736] h-[125%] -translate-y-1/2 mix-blend-screen [mask-image:radial-gradient(closest-side,black_60%,transparent)] sm:block"
        >
          <Image
            src="/images/glass-panes-hero.jpg"
            alt=""
            fill
            priority
            sizes="(min-width: 640px) 420px, 0px"
            className="object-cover"
          />
        </div>
        <div className="relative flex min-h-60 flex-col justify-center gap-5 p-8 sm:max-w-[55%] lg:p-10">
          <span className="text-xs font-medium tracking-[0.2em] text-[#9fd3b4] uppercase">
            {active?.team_name ?? "All teams"} ·{" "}
            {active && ROLE_LABEL[active.role]}
          </span>
          <div>
            <h1 className="bg-gradient-to-br from-white via-[#e3f1e8] to-[#8fc7a6] bg-clip-text text-4xl font-semibold tracking-tight text-transparent lg:text-5xl">
              Welcome back, {user.name.split(" ")[0]}
            </h1>
            <p className="mt-3 max-w-md text-sm text-[#b9d3c3]">
              Here&apos;s how your team&apos;s metrics moved over the last 24
              hours.
            </p>
          </div>
          {canEdit && (
            <div>
              <Button onClick={() => setCreating(true)}>
                <Plus size={16} /> New dashboard
              </Button>
            </div>
          )}
        </div>
        <div
          aria-hidden
          className="absolute inset-x-0 bottom-0 h-px bg-gradient-to-r from-transparent via-[#8fc7a6]/50 to-transparent"
        />
      </section>

      <div className="mb-8 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {(summary.data?.metrics ?? []).map((row) => (
          <Card key={row.metric} className="h-36 p-5">
            <div className="text-sm text-ink-2">{METRIC_LABEL[row.metric]}</div>
            <div className="h-[calc(100%-1.25rem)]">
              <StatTile {...row} />
            </div>
          </Card>
        ))}
      </div>

      {dashboards.loading ? (
        <Spinner />
      ) : dashboards.error ? (
        <Notice>{errorText(dashboards.error)}</Notice>
      ) : !boardId ? (
        <div className="rounded-2xl border border-white/10 bg-black p-10 text-center text-sm text-ink-2">
          No dashboards yet.
          {canEdit && " Create the first one from the banner."}
        </div>
      ) : (
        <DashboardBoard
          key={boardId}
          id={boardId}
          switcher={switcher || undefined}
          onChanged={dashboards.reload}
        />
      )}

      <Modal
        open={creating}
        onClose={() => setCreating(false)}
        title="New dashboard"
      >
        <CreateDashboard
          teams={teams.data ?? []}
          onClose={() => setCreating(false)}
        />
      </Modal>
    </>
  );
}

export default function DashboardsPage() {
  return <DashboardsHome />;
}
