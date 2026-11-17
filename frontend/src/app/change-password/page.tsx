"use client";

import { useRouter } from "next/navigation";
import { type FormEvent, useState } from "react";
import { AuthShell } from "@/components/auth-shell";
import { Button, Field, Input, Notice } from "@/components/ui";
import { api, errorText } from "@/lib/api";

export default function ChangePasswordPage() {
  const router = useRouter();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (next !== confirm) return setError("The new passwords don't match.");
    setBusy(true);
    setError("");
    try {
      await api("/auth/password", "POST", {
        current_password: current,
        new_password: next,
      });
      router.replace("/select-team");
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  };

  return (
    <AuthShell
      title="Set your password"
      subtitle="Your admin gave you a one-time password. Choose your own to continue."
    >
      <form onSubmit={submit} className="grid gap-4">
        <Field label="Current (one-time) password">
          <Input
            type="password"
            value={current}
            onChange={(e) => setCurrent(e.target.value)}
            required
            autoComplete="current-password"
            autoFocus
          />
        </Field>
        <Field label="New password" hint="At least 12 characters.">
          <Input
            type="password"
            value={next}
            onChange={(e) => setNext(e.target.value)}
            required
            minLength={12}
            maxLength={128}
            autoComplete="new-password"
          />
        </Field>
        <Field label="Confirm new password">
          <Input
            type="password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            required
            autoComplete="new-password"
          />
        </Field>
        <Notice>{error}</Notice>
        <Button type="submit" disabled={busy}>
          {busy ? "Saving…" : "Save and continue"}
        </Button>
      </form>
    </AuthShell>
  );
}
