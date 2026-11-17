"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { type FormEvent, Suspense, use, useState } from "react";
import { browser } from "react-dom";
import { AuthShell } from "@/components/auth-shell";
import { MembershipPicker } from "@/components/membership-picker";
import { Button, Field, Input, Notice, Spinner } from "@/components/ui";
import { api, errorText } from "@/lib/api";
import type { LoginResult } from "@/lib/types";

const ORG_KEY = "aafm.org";

/** Only same-site paths, so ?next= can't be used as an open redirect. */
const safeNext = () => {
  const next = new URLSearchParams(window.location.search).get("next") ?? "";
  return next.startsWith("/") && !next.startsWith("//") ? next : "/dashboards";
};

function LoginForm() {
  use(browser("The last organization is remembered in localStorage."));
  const router = useRouter();
  const [step, setStep] = useState<"identify" | "password" | "pick">(
    "identify"
  );
  const [org, setOrg] = useState(() => localStorage.getItem(ORG_KEY) ?? "");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [result, setResult] = useState<LoginResult | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  // Identifier-first, but nothing is sent until the password step: the server never says
  // whether an org or email exists (plan sections 1 and 10).
  const identify = (e: FormEvent) => {
    e.preventDefault();
    setStep("password");
  };

  const signIn = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const res = await api<LoginResult>("/auth/login", "POST", {
        org,
        email,
        password,
      });
      localStorage.setItem(ORG_KEY, org.trim().toLowerCase());
      if (res.must_change_password) return router.replace("/change-password");
      if (res.active_membership_id) return router.replace(safeNext());
      setResult(res);
      setStep("pick");
    } catch (err) {
      setError(errorText(err));
      setPassword("");
    } finally {
      setBusy(false);
    }
  };

  if (step === "pick" && result) {
    return (
      <MembershipPicker
        memberships={result.memberships}
        onSelected={() => router.replace(safeNext())}
      />
    );
  }

  return step === "identify" ? (
    <form onSubmit={identify} className="grid gap-4">
      <Field
        label="Organization"
        hint="Your organization's short name, e.g. acme"
      >
        <Input
          value={org}
          onChange={(e) => setOrg(e.target.value)}
          required
          autoComplete="organization"
          autoFocus={!org}
        />
      </Field>
      <Field label="Email">
        <Input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
          autoComplete="username"
          autoFocus={!!org}
        />
      </Field>
      <Button type="submit">Continue</Button>
    </form>
  ) : (
    <form onSubmit={signIn} className="grid gap-4">
      <button
        type="button"
        onClick={() => setStep("identify")}
        className="glass rounded-xl px-4 py-2.5 text-left text-sm"
      >
        <span className="text-ink-3">{org}</span> · {email}
        <span className="float-right text-accent">Change</span>
      </button>
      <Field label="Password">
        <Input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
          autoComplete="current-password"
          autoFocus
        />
      </Field>
      <Notice>{error}</Notice>
      <Button type="submit" disabled={busy}>
        {busy ? "Signing in…" : "Sign in"}
      </Button>
    </form>
  );
}

export default function LoginPage() {
  return (
    <AuthShell title="Sign in" subtitle="Your team's analytics, live.">
      <Suspense fallback={<Spinner />}>
        <LoginForm />
      </Suspense>
      <p className="mt-6 text-center text-sm text-ink-3">
        New here?{" "}
        <Link href="/signup" className="text-accent hover:underline">
          Create an organization
        </Link>
      </p>
    </AuthShell>
  );
}
