"use client";

import { FolderKanban, Pencil, Plus, Trash2 } from "lucide-react";
import Link from "next/link";
import { type FormEvent, useState } from "react";
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
import { api, errorText } from "@/lib/api";
import { useSocketEvent } from "@/lib/realtime";
import { ADMINS, type Dashboard, type Project, type Team } from "@/lib/types";
import { useApi } from "@/lib/use-api";

function ProjectForm({
  initial,
  teams,
  onSubmit,
}: {
  initial?: Project;
  teams?: Team[];
  onSubmit: (v: { name: string; team_id?: string }) => Promise<void>;
}) {
  const [name, setName] = useState(initial?.name ?? "");
  const [teamId, setTeamId] = useState(teams?.[0]?.id ?? "");
  const [error, setError] = useState("");
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    try {
      await onSubmit(teams ? { name, team_id: teamId } : { name });
    } catch (err) {
      setError(errorText(err));
    }
  };
  return (
    <form onSubmit={submit} className="grid gap-4">
      {teams && (
        <Field label="Team">
          <Select value={teamId} onChange={(e) => setTeamId(e.target.value)}>
            {teams.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </Select>
        </Field>
      )}
      <Field label="Project name">
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
          maxLength={100}
          autoFocus
        />
      </Field>
      <Notice>{error}</Notice>
      <Button type="submit">{initial ? "Save" : "Create project"}</Button>
    </form>
  );
}

/**
 * Tier 3 A: Org -> Team -> Project. Everyone sees their team's projects (access comes through
 * the team, Prompt 48); Admins and the Super Admin create, rename and delete them.
 */
export default function ProjectsPage() {
  const { active_membership: active } = useSession();
  const projects = useApi<Project[]>("/projects");
  const teams = useApi<Team[]>("/teams");
  const dashboards = useApi<Dashboard[]>("/dashboards?limit=100");
  useSocketEvent("projects:changed", () => projects.reload());
  useSocketEvent("dashboards:changed", () => dashboards.reload());
  const [modal, setModal] = useState<
    { kind: "create" } | { kind: "rename"; project: Project } | null
  >(null);
  const [notice, setNotice] = useState("");
  const canManage = !!active && ADMINS.includes(active.role);
  const orgWide = !active?.team_id;

  const remove = async (project: Project, count: number) => {
    const detail = count
      ? ` and its ${count} dashboard${count > 1 ? "s" : ""}, data and alerts`
      : "";
    if (!confirm(`Delete "${project.name}"${detail}? This can't be undone.`))
      return;
    try {
      await api(`/projects/${project.id}`, "DELETE");
      setNotice("");
      projects.reload();
      dashboards.reload();
    } catch (err) {
      setNotice(errorText(err));
    }
  };

  if (projects.loading) return <Spinner />;
  const byTeam = (teams.data ?? [])
    .map((team) => ({
      team,
      projects: (projects.data ?? []).filter((p) => p.team_id === team.id),
    }))
    .filter((group) => group.projects.length);

  return (
    <>
      <PageHeader
        title="Projects"
        subtitle="Each team's work is split into projects. Dashboards, metrics and alerts belong to a project; team totals add them up."
        actions={
          canManage && (
            <Button onClick={() => setModal({ kind: "create" })}>
              <Plus size={16} /> New project
            </Button>
          )
        }
      />
      <div className="mb-4">
        <Notice>
          {notice || (projects.error ? errorText(projects.error) : "")}
        </Notice>
      </div>

      <div className="grid gap-6">
        {byTeam.map(({ team, projects: list }) => (
          <Card key={team.id} className="p-5">
            {orgWide && (
              <h2 className="mb-4 text-sm font-semibold tracking-wide text-ink-2 uppercase">
                {team.name}
              </h2>
            )}
            <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {list.map((project) => {
                const boards = (dashboards.data ?? []).filter(
                  (d) => d.project_id === project.id
                );
                return (
                  <li
                    key={project.id}
                    className="flex items-start gap-3 rounded-xl border border-white/10 bg-black p-4"
                  >
                    <span className="grid size-10 shrink-0 place-items-center rounded-lg bg-accent/10 text-accent">
                      <FolderKanban size={18} />
                    </span>
                    <div className="min-w-0 flex-1">
                      <Link
                        href={`/dashboards?project=${project.id}`}
                        className="block truncate font-medium hover:underline"
                      >
                        {project.name}
                      </Link>
                      <div className="mt-1.5">
                        <Badge>
                          {boards.length} dashboard
                          {boards.length === 1 ? "" : "s"}
                        </Badge>
                      </div>
                    </div>
                    {canManage && (
                      <div className="flex">
                        <IconButton
                          label={`Rename ${project.name}`}
                          onClick={() => setModal({ kind: "rename", project })}
                        >
                          <Pencil size={15} />
                        </IconButton>
                        <IconButton
                          label={`Delete ${project.name}`}
                          tone="danger"
                          onClick={() => remove(project, boards.length)}
                        >
                          <Trash2 size={15} />
                        </IconButton>
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          </Card>
        ))}
      </div>

      <Modal
        open={!!modal}
        onClose={() => setModal(null)}
        title={modal?.kind === "rename" ? "Rename project" : "New project"}
      >
        {modal && (
          <ProjectForm
            initial={modal.kind === "rename" ? modal.project : undefined}
            teams={
              modal.kind === "create" && orgWide
                ? (teams.data ?? [])
                : undefined
            }
            onSubmit={async (v) => {
              if (modal.kind === "rename")
                await api(`/projects/${modal.project.id}`, "PATCH", {
                  name: v.name,
                });
              else await api("/projects", "POST", v);
              setModal(null);
              projects.reload();
            }}
          />
        )}
      </Modal>
    </>
  );
}
