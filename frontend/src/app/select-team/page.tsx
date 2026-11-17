"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { AuthShell } from "@/components/auth-shell";
import { MembershipPicker } from "@/components/membership-picker";
import { Notice, Spinner } from "@/components/ui";
import { ApiError } from "@/lib/api";
import type { Me } from "@/lib/types";
import { useApi } from "@/lib/use-api";

export default function SelectTeamPage() {
  const router = useRouter();
  const { data: me, error } = useApi<Me>("/auth/me");
  const signedOut = error instanceof ApiError && error.status === 401;

  useEffect(() => {
    if (signedOut) router.replace("/login");
    else if (me?.must_change_password) router.replace("/change-password");
  }, [signedOut, me, router]);

  return (
    <AuthShell
      title="Choose a workspace"
      subtitle={me ? `Signed in as ${me.user.email}` : undefined}
    >
      {me ? (
        <MembershipPicker
          memberships={me.memberships}
          onSelected={() => router.replace("/dashboards")}
        />
      ) : error && !signedOut ? (
        <Notice>Could not load your memberships.</Notice>
      ) : (
        <Spinner />
      )}
      {me?.active_membership && (
        <p className="mt-6 text-center text-sm">
          <Link href="/dashboards" className="text-accent hover:underline">
            Back to dashboards
          </Link>
        </p>
      )}
    </AuthShell>
  );
}
