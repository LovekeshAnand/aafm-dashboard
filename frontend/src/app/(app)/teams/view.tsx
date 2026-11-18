"use client";

import { KeyRound, Pencil, Plus, Trash2, UserPlus } from "lucide-react";
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
import { type Member, type Role, ROLE_LABEL, type Team } from "@/lib/types";
import { useSocketEvent } from "@/lib/realtime";
import { useApi } from "@/lib/use-api";

const TEAM_ROLES: Role[] = ["admin", "editor", "viewer"];

/** Shown exactly once: the API never returns this password again (AWS IAM-style). */
function OneTimePassword({
  email,
  password,
  onClose,
}: {
  email: string;
  password: string;
  onClose: () => void;
}) {
  return (
    <div className="grid gap-4">
      <Notice tone="info">
        Share these credentials with <b className="text-ink">{email}</b>{" "}
        securely. They must choose a new password when they first sign in. This
        password will not be shown again.
      </Notice>
      <CopyValue value={password} label="password" />
      <div className="flex justify-end">
        <Button onClick={onClose}>Done</Button>
      </div>
    </div>
  );
}

function AddMember({
  team,
  onDone,
}: {
  team: Team;
  onDone: (result: { email: string; password?: string }) => void;
}) {
  const [form, setForm] = useState({
    email: "",
    name: "",
    role: "viewer" as Role,
  });
  const [error, setError] = useState("");
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    try {
      const res = await api<{ one_time_password?: string }>(
        `/teams/${team.id}/members`,
        "POST",
        form
      );
      onDone({ email: form.email, password: res.one_time_password });
    } catch (err) {
      setError(errorText(err));
    }
  };
  return (
    <form onSubmit={submit} className="grid gap-4">
      <Field label="Email">
        <Input
          type="email"
          value={form.email}
          onChange={(e) => setForm({ ...form, email: e.target.value })}
          required
          autoFocus
        />
      </Field>
      <Field label="Name" hint="Used if this creates a new account">
        <Input
          value={form.name}
          onChange={(e) => setForm({ ...form, name: e.target.value })}
          required
          maxLength={100}
        />
      </Field>
      <Field label="Role">
        <Select
          value={form.role}
          onChange={(e) => setForm({ ...form, role: e.target.value as Role })}
        >
          {TEAM_ROLES.map((r) => (
            <option key={r} value={r}>
              {ROLE_LABEL[r]}
            </option>
          ))}
        </Select>
      </Field>
      <Notice>{error}</Notice>
      <Button type="submit">Add to {team.name}</Button>
    </form>
  );
}

function NameForm({
  initial = "",
  label,
  onSubmit,
}: {
  initial?: string;
  label: string;
  onSubmit: (name: string) => Promise<void>;
}) {
  const [name, setName] = useState(initial);
  const [error, setError] = useState("");
  return (
    <form
      onSubmit={async (e) => {
        e.preventDefault();
        try {
          await onSubmit(name);
        } catch (err) {
          setError(errorText(err));
        }
      }}
      className="grid gap-4"
    >
      <Field label="Team name">
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
          maxLength={100}
          autoFocus
        />
      </Field>
      <Notice>{error}</Notice>
      <Button type="submit">{label}</Button>
    </form>
  );
}

function Members({ team, canManage }: { team: Team; canManage: boolean }) {
  const { user } = useSession();
  const members = useApi<Member[]>(`/teams/${team.id}/members`);
  const [adding, setAdding] = useState(false);
  const [secret, setSecret] = useState<{
    email: string;
    password: string;
  } | null>(null);
  const [notice, setNotice] = useState<{
    tone: "error" | "success";
    text: string;
  } | null>(null);

  const act = async (action: () => Promise<unknown>, success: string) => {
    try {
      await action();
      setNotice({ tone: "success", text: success });
    } catch (err) {
      setNotice({ tone: "error", text: errorText(err) });
    }
    members.reload();
  };

  return (
    <Card className="p-6">
      <div className="mb-4 flex items-center justify-between gap-4">
        <h2 className="text-lg font-semibold">{team.name} members</h2>
        {canManage && (
          <Button variant="ghost" onClick={() => setAdding(true)}>
            <UserPlus size={16} /> Add person
          </Button>
        )}
      </div>
      {notice && (
        <div className="mb-4">
          <Notice tone={notice.tone}>{notice.text}</Notice>
        </div>
      )}
      {members.loading ? (
        <Spinner />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-xs text-ink-3">
              <tr className="border-b border-line">
                <th className="py-2 font-normal">Name</th>
                <th className="py-2 font-normal">Email</th>
                <th className="py-2 font-normal">Role</th>
                {canManage && (
                  <th className="py-2 text-right font-normal">Actions</th>
                )}
              </tr>
            </thead>
            <tbody>
              {members.data?.map((m) => (
                <tr
                  key={m.id}
                  className="border-b border-line/60 last:border-0"
                >
                  <td className="py-3 pr-4 whitespace-nowrap">
                    {m.name}{" "}
                    {m.user_id === user.id && <Badge tone="accent">You</Badge>}
                  </td>
                  <td className="py-3 pr-4 whitespace-nowrap text-ink-2">
                    {m.email}
                  </td>
                  <td className="py-3">
                    {canManage ? (
                      <Select
                        aria-label={`Role for ${m.name}`}
                        className="h-9 w-32"
                        value={m.role}
                        onChange={(e) =>
                          act(
                            () =>
                              api(`/memberships/${m.id}`, "PATCH", {
                                role: e.target.value,
                              }),
                            `${m.name} is now ${ROLE_LABEL[e.target.value as Role]}`
                          )
                        }
                      >
                        {TEAM_ROLES.map((r) => (
                          <option key={r} value={r}>
                            {ROLE_LABEL[r]}
                          </option>
                        ))}
                      </Select>
                    ) : (
                      <Badge>{ROLE_LABEL[m.role]}</Badge>
                    )}
                  </td>
                  {canManage && (
                    <td className="py-3 text-right whitespace-nowrap">
                      <IconButton
                        label={`Reset password for ${m.name}`}
                        onClick={async () => {
                          try {
                            const res = await api<{
                              one_time_password: string;
                            }>(`/users/${m.user_id}/reset-password`, "POST");
                            setSecret({
                              email: m.email,
                              password: res.one_time_password,
                            });
                          } catch (err) {
                            setNotice({
                              tone: "error",
                              text:
                                errorText(err) === "Not found"
                                  ? `${m.name} also belongs to teams you don't manage, so only a Super Admin can reset their password.`
                                  : errorText(err),
                            });
                          }
                        }}
                        className="inline-grid"
                      >
                        <KeyRound size={15} />
                      </IconButton>
                      <IconButton
                        label={`Remove ${m.name}`}
                        onClick={() =>
                          act(
                            () => api(`/memberships/${m.id}`, "DELETE"),
                            `${m.name} removed from ${team.name}`
                          )
                        }
                        tone="danger"
                        className="inline-grid"
                      >
                        <Trash2 size={15} />
                      </IconButton>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <Modal
        open={adding}
        onClose={() => setAdding(false)}
        title={`Add person to ${team.name}`}
      >
        <AddMember
          team={team}
          onDone={({ email, password }) => {
            setAdding(false);
            members.reload();
            if (password) setSecret({ email, password });
            else
              setNotice({
                tone: "success",
                text: `${email} already had an account and was added to ${team.name}.`,
              });
          }}
        />
      </Modal>
      <Modal
        open={!!secret}
        onClose={() => setSecret(null)}
        title="Sign-in credentials"
      >
        {secret && (
          <OneTimePassword {...secret} onClose={() => setSecret(null)} />
        )}
      </Modal>
    </Card>
  );
}

export default function TeamsPage() {
  const { active_membership: active } = useSession();
  const teams = useApi<Team[]>("/teams");
  useSocketEvent("teams:changed", () => teams.reload());
  const isSuper = active?.role === "super_admin";
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [modal, setModal] = useState<"create" | "rename" | null>(null);
  const [error, setError] = useState("");

  const selected =
    teams.data?.find((t) => t.id === selectedId) ?? teams.data?.[0];
  const canManage = (team: Team) =>
    isSuper || (active?.role === "admin" && active.team_id === team.id);

  return (
    <>
      <PageHeader
        title="Teams & people"
        subtitle={
          isSuper
            ? "Every team in your organization"
            : `Members of ${active?.team_name}`
        }
        actions={
          isSuper && (
            <Button onClick={() => setModal("create")}>
              <Plus size={16} /> New team
            </Button>
          )
        }
      />
      <Notice>{error}</Notice>

      {teams.loading ? (
        <Spinner />
      ) : (
        <div
          className={cx("grid gap-6", isSuper && "lg:grid-cols-[16rem_1fr]")}
        >
          {isSuper && (
            <nav className="glass h-fit rounded-2xl p-2" aria-label="Teams">
              {teams.data?.map((t) => (
                <div
                  key={t.id}
                  className={cx(
                    "group flex items-center rounded-xl",
                    selected?.id === t.id && "bg-ink text-black"
                  )}
                >
                  <button
                    onClick={() => setSelectedId(t.id)}
                    className="flex-1 truncate px-4 py-2.5 text-left text-sm"
                  >
                    {t.name}
                  </button>
                  {selected?.id === t.id && (
                    <>
                      <IconButton
                        label={`Rename ${t.name}`}
                        onClick={() => setModal("rename")}
                        tone="light"
                        className="size-8"
                      >
                        <Pencil size={14} />
                      </IconButton>
                      <IconButton
                        label={`Delete ${t.name}`}
                        tone="lightDanger"
                        className="mr-1 size-8"
                        onClick={async () => {
                          if (
                            !confirm(
                              `Delete team "${t.name}" with all its dashboards and memberships?`
                            )
                          )
                            return;
                          try {
                            await api(`/teams/${t.id}`, "DELETE");
                            setSelectedId(null);
                            teams.reload();
                          } catch (err) {
                            setError(errorText(err));
                          }
                        }}
                      >
                        <Trash2 size={14} />
                      </IconButton>
                    </>
                  )}
                </div>
              ))}
            </nav>
          )}
          {selected ? (
            <Members
              key={selected.id}
              team={selected}
              canManage={canManage(selected)}
            />
          ) : (
            <Card className="p-10 text-sm text-ink-2">No teams yet.</Card>
          )}
        </div>
      )}

      <Modal
        open={modal === "create"}
        onClose={() => setModal(null)}
        title="New team"
      >
        <NameForm
          label="Create team"
          onSubmit={async (name) => {
            const team = await api<Team>("/teams", "POST", { name });
            setModal(null);
            setSelectedId(team.id);
            teams.reload();
          }}
        />
      </Modal>
      <Modal
        open={modal === "rename"}
        onClose={() => setModal(null)}
        title="Rename team"
      >
        {selected && (
          <NameForm
            initial={selected.name}
            label="Save"
            onSubmit={async (name) => {
              await api(`/teams/${selected.id}`, "PATCH", { name });
              setModal(null);
              teams.reload();
            }}
          />
        )}
      </Modal>
    </>
  );
}
