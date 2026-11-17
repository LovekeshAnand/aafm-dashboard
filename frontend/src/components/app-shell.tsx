"use client";

import { ArrowLeftRight, LayoutDashboard, LogOut, Users } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { type ReactNode, Suspense } from "react";
import { AlertsPanel, AlertToaster } from "@/components/alerts-panel";
import { Brand } from "@/components/auth-shell";
import {
  FullPageSpinner,
  SessionProvider,
  useSession,
} from "@/components/session";
import { cx, IconButton } from "@/components/ui";
import { api } from "@/lib/api";
import { ROLE_LABEL } from "@/lib/types";

const NAV = [
  { href: "/dashboards", label: "Dashboards", icon: LayoutDashboard },
  { href: "/teams", label: "Teams & people", icon: Users },
];

function Sidebar() {
  const pathname = usePathname();
  const router = useRouter();
  const { user, active_membership: active, memberships } = useSession();

  const signOut = async () => {
    await api("/auth/logout", "POST").catch(() => {});
    router.replace("/login");
  };

  return (
    <aside className="glass sticky top-0 flex h-dvh w-64 shrink-0 flex-col rounded-none border-y-0 border-l-0 p-4 max-lg:hidden">
      <div className="px-2 py-3">
        <Brand />
      </div>

      <Link
        href="/select-team"
        className="mt-4 flex items-center gap-3 rounded-xl border border-line bg-black/20 px-3 py-2.5 transition hover:bg-glass-strong"
        title={memberships.length > 1 ? "Switch workspace" : undefined}
      >
        <span className="flex-1 leading-tight">
          <span className="block text-sm font-medium">
            {active?.team_name ?? "Whole organization"}
          </span>
          <span className="text-xs text-ink-3">
            {active && ROLE_LABEL[active.role]}
          </span>
        </span>
        {memberships.length > 1 && (
          <ArrowLeftRight size={16} className="text-ink-3" />
        )}
      </Link>

      <nav className="mt-6 grid gap-1.5" aria-label="Main">
        {NAV.map(({ href, label, icon: Icon }) => {
          const current = pathname.startsWith(href);
          return (
            <Link
              key={href}
              href={href}
              aria-current={current ? "page" : undefined}
              className={cx(
                "flex items-center gap-3 rounded-xl px-4 py-2.5 text-sm transition",
                current
                  ? "bg-ink font-semibold text-black shadow-[0_0_24px_-6px_rgb(255_255_255/0.5)]"
                  : "text-ink-2 hover:bg-glass-strong hover:text-ink"
              )}
            >
              <Icon size={18} />
              {label}
            </Link>
          );
        })}
      </nav>

      <AlertsPanel orgWide={!active?.team_id} />

      <div className="mt-auto flex items-center gap-3 rounded-xl px-2 py-2">
        <span className="grid size-9 place-items-center rounded-full bg-gradient-to-br from-ink to-accent text-sm font-semibold text-black">
          {user.name.slice(0, 1).toUpperCase()}
        </span>
        <span className="min-w-0 flex-1 leading-tight">
          <span className="block truncate text-sm">{user.name}</span>
          <span className="block truncate text-xs text-ink-3">
            {user.email}
          </span>
        </span>
        <IconButton label="Sign out" onClick={signOut}>
          <LogOut size={16} />
        </IconButton>
      </div>
    </aside>
  );
}

/** Compact top bar for narrow screens, where the sidebar is hidden. */
function MobileBar() {
  const pathname = usePathname();
  const { active_membership: active } = useSession();
  return (
    <header className="glass mb-4 flex items-center gap-2 rounded-xl p-1.5 lg:hidden">
      {NAV.map(({ href, label, icon: Icon }) => (
        <Link
          key={href}
          href={href}
          className={cx(
            "flex items-center gap-2 rounded-lg px-3 py-2 text-xs",
            pathname.startsWith(href) ? "bg-ink text-black" : "text-ink-2"
          )}
        >
          <Icon size={14} />
          {label}
        </Link>
      ))}
      <Link
        href="/select-team"
        className="ml-auto truncate px-3 text-xs text-ink-3"
      >
        {active?.team_name ?? "Organization"}
      </Link>
    </header>
  );
}

// The signed-in app is per-user and rendered in the browser behind the session check, so
// one Suspense boundary covers every request-time hook (usePathname, useParams) below it.
export function AppShell({ children }: { children: ReactNode }) {
  return (
    <Suspense fallback={<FullPageSpinner />}>
      <SessionProvider>
        <div className="relative flex min-h-dvh w-full">
          {/* Backdrop art (frontend/assets), softly blurred (Prompt 39; scaled 5% so the blur never
              shows soft edges) and dimmed on the left so text stays readable;
              the frosted panels blur whatever sits behind them. */}
          <div
            aria-hidden
            className="pointer-events-none fixed inset-0 -z-10 bg-[url(/images/aurora-ring-wide.jpg)] scale-105 bg-cover bg-center opacity-80 blur-sm"
          />
          <div
            aria-hidden
            className="pointer-events-none fixed inset-0 -z-10 bg-gradient-to-r from-canvas/90 via-canvas/70 to-canvas/30"
          />
          <Sidebar />
          <main className="min-w-0 flex-1 p-4 lg:p-8">
            <MobileBar />
            {children}
          </main>
          <AlertToaster />
        </div>
      </SessionProvider>
    </Suspense>
  );
}
