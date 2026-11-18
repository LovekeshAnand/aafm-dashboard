"use client";

import { Bell, ChevronDown, X } from "lucide-react";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";
import { useSocketEvent } from "@/lib/realtime";
import { useApi } from "@/lib/use-api";
import { cx, IconButton } from "./ui";

// Features F3 + F4 (Prompt 68): changes to your own access (added to a team, role changed,
// removed, password reset or changed, team deleted), in a sidebar centre and as a pop-up when
// they happen while you're signed in.
type Notification = {
  id: string;
  kind: string;
  title: string;
  body: string;
  link: string | null;
  read_at: string | null;
  created_at: string;
};
type Inbox = { items: Notification[]; unread: number };

const ago = (iso: string) => {
  const min = Math.round((Date.now() - new Date(iso).getTime()) / 60e3);
  if (min < 1) return "just now";
  if (min < 60) return `${min} min ago`;
  const h = Math.round(min / 60);
  return h < 48 ? `${h} h ago` : `${Math.round(h / 24)} days ago`;
};

export function NotificationsPanel() {
  const { data, reload } = useApi<Inbox>("/notifications?limit=30");
  const [expanded, setExpanded] = useState(false);
  const [popup, setPopup] = useState<Notification | null>(null);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);

  useSocketEvent<Notification>("notifications:new", (n) => {
    reload();
    setPopup(n);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setPopup(null), 8000);
  });

  // Opening the list marks everything in it as read.
  const toggle = async () => {
    const next = !expanded;
    setExpanded(next);
    if (next && data?.unread) {
      await api("/notifications/read", "POST", {}).catch(() => {});
      reload();
    }
  };

  const unread = data?.unread ?? 0;
  const items = data?.items ?? [];

  return (
    <section className="mt-1">
      <button
        onClick={toggle}
        aria-expanded={expanded}
        className="flex w-full items-center gap-3 rounded-xl px-4 py-2.5 text-sm text-ink-2 transition hover:bg-glass-strong hover:text-ink"
      >
        <span className="relative">
          <Bell size={18} />
          {unread > 0 && (
            <span className="absolute -top-1.5 -right-1.5 grid min-w-4 place-items-center rounded-full bg-accent px-1 text-[10px] font-semibold text-black">
              {unread}
            </span>
          )}
        </span>
        <span className="flex-1 text-left">Notifications</span>
        <ChevronDown
          size={16}
          className={cx("transition", expanded && "rotate-180")}
        />
      </button>
      {expanded && (
        <div className="mt-1 max-h-72 overflow-y-auto rounded-xl border border-white/10 bg-black/60 p-1">
          {items.length ? (
            <ul aria-label="Notifications">
              {items.map((n) => {
                const content = (
                  <>
                    <span
                      className={cx(
                        "block font-medium",
                        n.read_at ? "text-ink-2" : "text-ink"
                      )}
                    >
                      {n.title}
                    </span>
                    {n.body && (
                      <span className="mt-0.5 block text-ink-3">{n.body}</span>
                    )}
                    <span className="mt-0.5 block text-ink-3">
                      {ago(n.created_at)}
                    </span>
                  </>
                );
                return (
                  <li
                    key={n.id}
                    className="rounded-lg px-2 py-2 text-xs leading-snug"
                  >
                    {n.link ? (
                      <Link href={n.link} className="block hover:underline">
                        {content}
                      </Link>
                    ) : (
                      content
                    )}
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="px-3 py-4 text-xs text-ink-3">
              Nothing yet. Changes to your teams, role or password appear here.
            </p>
          )}
        </div>
      )}

      {popup && (
        <div
          role="status"
          className="fixed right-4 bottom-24 z-50 flex w-80 items-start gap-3 rounded-xl border border-accent/40 bg-black px-4 py-3 shadow-[0_20px_50px_-20px_rgb(0_0_0/0.8)]"
        >
          <Bell size={18} aria-hidden className="mt-0.5 shrink-0 text-accent" />
          <span className="min-w-0 flex-1 text-sm">
            <span className="block font-semibold">{popup.title}</span>
            {popup.body && <span className="text-ink-2">{popup.body}</span>}
          </span>
          <IconButton
            label="Dismiss"
            onClick={() => setPopup(null)}
            className="-mt-1 -mr-2 size-7"
          >
            <X size={14} />
          </IconButton>
        </div>
      )}
    </section>
  );
}
