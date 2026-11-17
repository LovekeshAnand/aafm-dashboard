"use client";

import { Building2, ChevronRight, Users } from "lucide-react";
import { useState } from "react";
import { api, errorText } from "@/lib/api";
import { type Membership, ROLE_LABEL } from "@/lib/types";
import { Notice } from "./ui";

/** "Which workspace?" step: one row per membership; picking one rotates the session server-side. */
export function MembershipPicker({
  memberships,
  onSelected,
}: {
  memberships: Membership[];
  onSelected: () => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");

  const choose = async (id: string) => {
    setBusy(id);
    setError("");
    try {
      await api("/auth/context", "POST", { membership_id: id });
      onSelected();
    } catch (err) {
      setError(errorText(err));
      setBusy(null);
    }
  };

  if (!memberships.length)
    return (
      <Notice tone="info">
        You are not a member of any team yet. Ask an admin to add you.
      </Notice>
    );

  return (
    <div className="grid gap-2">
      {memberships.map((m) => (
        <button
          key={m.id}
          onClick={() => choose(m.id)}
          disabled={busy !== null}
          className="glass flex items-center gap-4 rounded-xl px-4 py-3 text-left transition hover:bg-glass-strong disabled:opacity-60"
        >
          <span className="grid size-10 place-items-center rounded-full bg-accent/10 text-accent">
            {m.team_id ? <Users size={18} /> : <Building2 size={18} />}
          </span>
          <span className="flex-1">
            <span className="block font-medium">
              {m.team_name ?? "Whole organization"}
            </span>
            <span className="text-xs text-ink-3">{ROLE_LABEL[m.role]}</span>
          </span>
          {busy === m.id ? (
            <span className="text-xs text-ink-3">Opening…</span>
          ) : (
            <ChevronRight size={18} className="text-ink-3" />
          )}
        </button>
      ))}
      <Notice>{error}</Notice>
    </div>
  );
}
