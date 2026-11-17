"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { type FormEvent, useState } from "react";
import { AuthShell } from "@/components/auth-shell";
import { Button, Field, Input, Notice } from "@/components/ui";
import { api, errorText } from "@/lib/api";

const toSlug = (name: string) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);

export default function SignupPage() {
  const router = useRouter();
  const [form, setForm] = useState({
    org_name: "",
    slug: "",
    name: "",
    email: "",
    password: "",
  });
  const [slugEdited, setSlugEdited] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const set = (key: keyof typeof form) => (e: { target: { value: string } }) =>
    setForm((f) => ({ ...f, [key]: e.target.value }));

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      await api("/auth/signup", "POST", form);
      localStorage.setItem("aafm.org", form.slug);
      router.replace("/dashboards");
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  };

  return (
    <AuthShell
      title="Create your organization"
      subtitle="You'll be its Super Admin and can add teams and people next."
    >
      <form onSubmit={submit} className="grid gap-4">
        <Field label="Organization name">
          <Input
            value={form.org_name}
            onChange={(e) =>
              setForm((f) => ({
                ...f,
                org_name: e.target.value,
                slug: slugEdited ? f.slug : toSlug(e.target.value),
              }))
            }
            required
            maxLength={100}
            autoFocus
          />
        </Field>
        <Field
          label="Sign-in name"
          hint="Lowercase letters, numbers and dashes. Your team types this to sign in."
        >
          <Input
            value={form.slug}
            onChange={(e) => {
              setSlugEdited(true);
              set("slug")(e);
            }}
            required
            pattern="[a-z0-9][a-z0-9-]{1,38}[a-z0-9]"
          />
        </Field>
        <Field label="Your name">
          <Input
            value={form.name}
            onChange={set("name")}
            required
            maxLength={100}
            autoComplete="name"
          />
        </Field>
        <Field label="Email">
          <Input
            type="email"
            value={form.email}
            onChange={set("email")}
            required
            autoComplete="email"
          />
        </Field>
        <Field
          label="Password"
          hint="At least 12 characters. A passphrase works well."
        >
          <Input
            type="password"
            value={form.password}
            onChange={set("password")}
            required
            minLength={12}
            maxLength={128}
            autoComplete="new-password"
          />
        </Field>
        <Notice>{error}</Notice>
        <Button type="submit" disabled={busy}>
          {busy ? "Creating…" : "Create organization"}
        </Button>
      </form>
      <p className="mt-6 text-center text-sm text-ink-3">
        Already have an account?{" "}
        <Link href="/login" className="text-accent hover:underline">
          Sign in
        </Link>
      </p>
    </AuthShell>
  );
}
