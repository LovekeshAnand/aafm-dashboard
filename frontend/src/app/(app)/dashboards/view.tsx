"use client";

import { Plus } from "lucide-react";
import Image from "next/image";
import { useRouter, useSearchParams } from "next/navigation";
import { type FormEvent, useCallback, useRef, useState } from "react";
import { DashboardBoard } from "@/components/dashboard-board";
import { TrendCard } from "@/components/trend-card";
import { useSession } from "@/components/session";
import {
  Button,
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
  type Project,
  METRIC_LABEL,
  ROLE_LABEL,
  KPI_FORMULA,
  KPI_LABEL,
  type Summary,
  type Team,
} from "@/lib/types";
import { useSocketEvent } from "@/lib/realtime";
import { useApi } from "@/lib/use-api";

function CreateDashboard({
  teams,
  projects,
  initialProject,
  onClose,
}: {
  teams: Team[];
  projects: Project[];
  initialProject?: string;
  onClose: () => void;
}) {
  const router = useRouter();
  const { active_membership: active } = useSession();
  const orgWide = !active?.team_id;
  const [name, setName] = useState("");
  const [teamId, setTeamId] = useState(
    projects.find((p) => p.id === initialProject)?.team_id ??
      active?.team_id ??
      teams[0]?.id ??
      ""
  );
  const teamProjects = projects.filter((p) => p.team_id === teamId);
  const [projectId, setProjectId] = useState(
    initialProject && teamProjects.some((p) => p.id === initialProject)
      ? initialProject
      : (teamProjects[0]?.id ?? "")
  );
  const [error, setError] = useState("");

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    try {
      const created = await api<Dashboard>("/dashboards", "POST", {
        name,
        project_id: projectId,
      });
      router.push(`/dashboards/${created.id}?project=${created.project_id}`);
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
            onChange={(e) => {
              setTeamId(e.target.value);
              setProjectId(
                projects.find((p) => p.team_id === e.target.value)?.id ?? ""
              );
            }}
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
      <Field label="Project">
        <Select
          value={projectId}
          onChange={(e) => setProjectId(e.target.value)}
          required
        >
          {teamProjects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </Select>
      </Field>
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
 * Dashboard home (Prompt 27): banner and totals, then the selected dashboard itself.
 * The dashboards are folder tabs on top of the board (Prompt 71); `selectedId` comes from
 * /dashboards/<id> so a switch is also a shareable deep link.
 * Tier 3 A: `?project=<id>` scopes the totals and the switcher to one project; without it
 * they cover all of the team's projects.
 */
const LIST_LIMIT = 100;
const TAB_MIN = 140; // px: below this a tab name is unreadable, so it moves into "More"
const MORE_WIDTH = 120;
const lastDay = () => {
  const to = new Date();
  return {
    from: new Date(to.getTime() - 24 * 3600e3).toISOString(),
    to: to.toISOString(),
  };
};

export function DashboardsHome({ selectedId }: { selectedId?: string }) {
  const router = useRouter();
  const project = useSearchParams().get("project");
  const { active_membership: active, user } = useSession();
  // E6: the API's page maximum, narrowed on the server to the selected project.
  const dashboards = useApi<Dashboard[]>(
    `/dashboards?limit=${LIST_LIMIT}${project ? `&project_id=${project}` : ""}`
  );
  const teams = useApi<Team[]>("/teams");
  const projects = useApi<Project[]>("/projects");
  const summary = useApi<Summary>(
    `/metrics/summary?range=24h${project ? `&project_id=${project}` : ""}`
  );
  const [creating, setCreating] = useState(false);
  // Width of the tab row, to decide how many tabs fit (Prompt 72). A callback ref, so it
  // attaches whenever the row mounts (React 19 runs the returned cleanup on unmount).
  const [rowWidth, setRowWidth] = useState(1200);
  const rowRef = useCallback((el: HTMLDivElement | null) => {
    if (!el) return;
    const observer = new ResizeObserver(([entry]) =>
      setRowWidth(entry.contentRect.width)
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  // Tier 2: totals follow live ticks; the switcher follows dashboards that teammates create,
  // rename or delete (and Tier 3 A: projects being added, renamed or removed).
  // The cards show 24-hour totals: refreshing every 30 s is plenty (problems-log #29).
  const lastSummary = useRef(0);
  const [day, setDay] = useState(lastDay);
  useSocketEvent("metrics:tick", () => {
    if (Date.now() - lastSummary.current < 30_000) return;
    lastSummary.current = Date.now();
    summary.reload();
    setDay(lastDay());
  });
  const seriesQuery = `from=${day.from}&to=${day.to}&bucket=1h${project ? `&project_id=${project}` : ""}`;
  useSocketEvent("dashboards:changed", () => dashboards.reload());
  useSocketEvent("projects:changed", () => projects.reload());
  const canEdit = !!active && EDITORS.includes(active.role);
  const orgWide = !active?.team_id;
  const teamName = (id: string) =>
    teams.data?.find((t) => t.id === id)?.name ?? "";
  const projectList = projects.data ?? [];
  const projectName = (id: string) =>
    projectList.find((p) => p.id === id)?.name ?? "";
  const withProject = (path: string) =>
    project ? `${path}?project=${project}` : path;

  const list = dashboards.data ?? [];
  const visible = list; // already scoped to ?project on the server
  // A link to a dashboard that no longer exists (deleted by a teammate, or a reseed) falls
  // back to the first one instead of stranding the user on a 404 (Prompt 43).
  const missing =
    !!selectedId && !!dashboards.data && !list.some((d) => d.id === selectedId);
  const boardId = selectedId && !missing ? selectedId : visible[0]?.id;
  const tabs = visible.some((d) => d.id === boardId)
    ? visible
    : [...list.filter((d) => d.id === boardId), ...visible];

  // The list is fetched per project, so switching opens that project's first dashboard.
  const pickProject = (id: string | null) =>
    router.push(id ? `/dashboards?project=${id}` : "/dashboards");

  // Project picker (Prompt 75): one segmented control instead of loose pills. Organization-wide,
  // projects sit under small team labels, so the team isn't repeated on every option.
  const segment = (selected: boolean) =>
    cx(
      "rounded-lg px-3.5 py-1.5 text-sm whitespace-nowrap transition",
      selected
        ? "bg-surface font-medium text-ink shadow-[0_1px_3px_rgb(0_0_0/0.25)] ring-1 ring-line"
        : "text-ink-2 hover:bg-glass-strong hover:text-ink"
    );
  const projectGroups = orgWide
    ? (teams.data ?? [])
        .map((t) => ({
          team: t,
          projects: projectList.filter((p) => p.team_id === t.id),
        }))
        .filter((g) => g.projects.length)
    : [{ team: null, projects: projectList }];
  const projectPicker = projectList.length > 0 && (
    <div
      role="tablist"
      aria-label="Projects"
      className="mb-4 inline-flex max-w-full flex-wrap items-center gap-1 rounded-xl border border-line bg-panel p-1"
    >
      <button
        role="tab"
        aria-selected={project === null}
        onClick={() => pickProject(null)}
        className={segment(project === null)}
      >
        All projects
      </button>
      {projectGroups.map(({ team, projects: group }) => (
        <div
          key={team?.id ?? "team"}
          role="group"
          aria-label={team?.name}
          className="flex flex-wrap items-center gap-1"
        >
          <span aria-hidden className="mx-1 h-5 w-px bg-line" />
          {team && (
            <span className="px-1.5 text-[11px] font-medium tracking-wide text-ink-3 uppercase">
              {team.name}
            </span>
          )}
          {group.map((p) => (
            <button
              key={p.id}
              role="tab"
              aria-selected={p.id === project}
              onClick={() => pickProject(p.id)}
              className={segment(p.id === project)}
            >
              {p.name}
            </button>
          ))}
        </div>
      ))}
    </div>
  );

  // Prompt 72: no sideways scrolling. Tabs share the row like browser tabs (names truncate,
  // full name on hover); those that don't fit at TAB_MIN go into a native "More" menu. The
  // selected dashboard always keeps a visible tab.
  const fit = Math.max(
    1,
    Math.floor((rowWidth - (canEdit ? 48 : 0)) / TAB_MIN)
  );
  const overflowing = tabs.length > fit;
  const slots = overflowing
    ? Math.max(
        1,
        Math.floor((rowWidth - (canEdit ? 48 : 0) - MORE_WIDTH) / TAB_MIN)
      )
    : tabs.length;
  let shown = tabs.slice(0, slots);
  const chosen = tabs.find((d) => d.id === boardId);
  if (chosen && !shown.includes(chosen))
    shown = [...shown.slice(0, -1), chosen];
  const hidden = tabs.filter((d) => !shown.includes(d));
  const firstSelected = shown[0]?.id === boardId;
  const open = (id: string) => router.push(withProject(`/dashboards/${id}`));
  const folderTabs = (
    <div
      ref={rowRef}
      role="tablist"
      aria-label="Dashboards"
      className="relative z-10 -mb-px flex min-w-0 items-end gap-1"
    >
      {shown.map((d) => {
        const selected = d.id === boardId;
        const where = !project
          ? `${orgWide ? `${teamName(d.team_id)} · ` : ""}${projectName(d.project_id)}`
          : "";
        return (
          <button
            key={d.id}
            role="tab"
            aria-selected={selected}
            title={where ? `${d.name} (${where})` : d.name}
            onClick={() => open(d.id)}
            className={cx(
              "flex max-w-64 min-w-0 flex-initial flex-col rounded-t-xl border border-b-0 px-4 text-left transition",
              selected
                ? "border-line bg-panel pt-2.5 pb-3 text-ink shadow-[inset_0_2px_0_var(--color-accent)]"
                : "mb-0.5 border-line bg-glass py-2 text-ink-2 hover:bg-glass-strong hover:text-ink"
            )}
          >
            <span
              className={cx(
                "truncate text-sm",
                selected ? "font-semibold" : "font-medium"
              )}
            >
              {d.name}
            </span>
            {where && (
              <span className="truncate text-[11px] text-ink-3">{where}</span>
            )}
          </button>
        );
      })}
      {hidden.length > 0 && (
        <select
          aria-label="More dashboards"
          value=""
          onChange={(e) => e.target.value && open(e.target.value)}
          className="mb-1 h-8 shrink-0 cursor-pointer rounded-lg border border-line bg-panel px-2 text-sm text-ink-2 hover:text-ink"
          style={{ width: MORE_WIDTH - 8 }}
        >
          <option value="">More ({hidden.length})</option>
          {hidden.map((d) => (
            <option key={d.id} value={d.id}>
              {d.name}
            </option>
          ))}
        </select>
      )}
      {canEdit && (
        <button
          onClick={() => setCreating(true)}
          aria-label="New dashboard"
          title="New dashboard"
          className="mb-1 ml-1 grid size-8 shrink-0 place-items-center rounded-lg text-ink-3 transition hover:bg-glass-strong hover:text-ink"
        >
          <Plus size={16} />
        </button>
      )}
    </div>
  );

  return (
    <>
      {/* Hero banner (Prompts 20-24): black panel with a green glow; the glass-panes render
          is blended with `screen` so its own black backdrop merges into the panel. The image
          box has the render's exact aspect ratio (952x736) so the radial fade follows the
          image and no hard frame edge shows. */}
      <section className="theme-dark relative mb-6 overflow-hidden rounded-2xl border border-[#3b7a57]/30 bg-black bg-[radial-gradient(45%_110%_at_80%_50%,rgb(31_92_60/0.55),transparent_70%),radial-gradient(40%_90%_at_0%_0%,rgb(47_125_85/0.22),transparent_70%)] shadow-[inset_0_1px_0_rgb(255_255_255/0.06),0_30px_80px_-30px_rgb(15_51_35/0.9)]">
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
              {project
                ? `Here's how ${projectName(project) || "this project"} moved over the last 24 hours.`
                : "Here's how your team's metrics moved over the last 24 hours."}
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

      {projectPicker}

      {/* Five base metrics plus ARPU (Tier 2 C): 3x2 at most, six in a row squeezed (Prompt 42).
          Prompt 71: each card carries its 24 h trend, tinted green (good) or red (bad). */}
      <div className="mb-8 grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {(summary.data?.metrics ?? []).map((row) => (
          <TrendCard
            key={row.metric}
            label={METRIC_LABEL[row.metric]}
            source={{ metric: row.metric }}
            current={row.current}
            previous={row.previous}
            seriesPath={`/metrics/series?metric=${row.metric}&${seriesQuery}`}
          />
        ))}
        {summary.data?.kpis
          .filter((k) => k.kpi === "arpu")
          .map((k) => (
            <TrendCard
              key={k.kpi}
              label={KPI_LABEL[k.kpi]}
              hint={KPI_FORMULA[k.kpi]}
              source={{ kpi: k.kpi }}
              current={k.current}
              previous={k.previous}
              seriesPath={`/metrics/kpi?kpi=${k.kpi}&${seriesQuery}`}
            />
          ))}
      </div>

      {dashboards.loading ? (
        <Spinner />
      ) : dashboards.error ? (
        <Notice>{errorText(dashboards.error)}</Notice>
      ) : !boardId ? (
        <div className="rounded-2xl border border-white/10 bg-black p-10 text-center text-sm text-ink-2">
          {project
            ? "No dashboards in this project yet."
            : "No dashboards yet."}
          {canEdit && " Create the first one from the banner."}
        </div>
      ) : (
        <>
          {list.length >= LIST_LIMIT && (
            <div className="mb-4">
              <Notice tone="info">
                Showing the {LIST_LIMIT} most recently updated dashboards
                {project ? " in this project" : ""}. Pick a project to see
                others.
              </Notice>
            </div>
          )}
          {missing && (
            <div className="mb-4">
              <Notice tone="info">
                That dashboard no longer exists. Showing{" "}
                {list.find((d) => d.id === boardId)?.name} instead.
              </Notice>
            </div>
          )}
          {folderTabs}
          <div
            className={cx(
              "rounded-2xl border border-line bg-panel p-4 lg:p-5",
              firstSelected && "rounded-tl-none"
            )}
          >
            <DashboardBoard
              key={boardId}
              id={boardId}
              switcher={null}
              onChanged={dashboards.reload}
            />
          </div>
        </>
      )}

      <Modal
        open={creating}
        onClose={() => setCreating(false)}
        title="New dashboard"
      >
        <CreateDashboard
          teams={teams.data ?? []}
          projects={projectList}
          initialProject={project ?? undefined}
          onClose={() => setCreating(false)}
        />
      </Modal>
    </>
  );
}

export default function DashboardsPage() {
  return <DashboardsHome />;
}
