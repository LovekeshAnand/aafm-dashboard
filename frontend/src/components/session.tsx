"use client";

import { usePathname, useRouter } from "next/navigation";
import { createContext, type ReactNode, use, useEffect } from "react";
import { ApiError, SESSION_EXPIRED } from "@/lib/api";
import type { Me } from "@/lib/types";
import { useApi } from "@/lib/use-api";
import { Spinner } from "./ui";

type Session = Me & { reload: () => void };
const SessionContext = createContext<Session | null>(null);

export const useSession = () => {
  const session = use(SessionContext);
  if (!session) throw new Error("useSession outside <SessionProvider>");
  return session;
};

/**
 * Gate for the signed-in app. The server is the authority (every API call is checked there);
 * this only routes the user to the step they still need: sign in, change password, pick a team.
 */
export function SessionProvider({ children }: { children: ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const { data: me, error, reload } = useApi<Me>("/auth/me");

  const next =
    error instanceof ApiError && error.status === 401
      ? `/login?next=${encodeURIComponent(pathname)}`
      : me?.must_change_password
        ? "/change-password"
        : me && !me.active_membership
          ? "/select-team"
          : null;

  useEffect(() => {
    if (next) router.replace(next);
  }, [next, router]);

  // E13: any API call that finds the session gone (idle timeout, signed out in another tab,
  // revoked by an admin) brings the user back to sign-in, and then to this page.
  useEffect(() => {
    const expired = () =>
      router.replace(`/login?next=${encodeURIComponent(pathname)}`);
    window.addEventListener(SESSION_EXPIRED, expired);
    return () => window.removeEventListener(SESSION_EXPIRED, expired);
  }, [pathname, router]);

  if (error && !(error instanceof ApiError && error.status === 401)) {
    return (
      <p className="p-8 text-danger">
        Could not reach the server. Is the API running?
      </p>
    );
  }
  if (!me || next) return <FullPageSpinner />;
  return <SessionContext value={{ ...me, reload }}>{children}</SessionContext>;
}

export const FullPageSpinner = () => (
  <div className="grid min-h-dvh place-items-center">
    <Spinner />
  </div>
);
