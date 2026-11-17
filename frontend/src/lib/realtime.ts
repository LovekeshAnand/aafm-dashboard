"use client";

import { useEffect, useRef, useState } from "react";
import { io, type Socket } from "socket.io-client";

// One socket per tab. In development NEXT_PUBLIC_SOCKET_URL points straight at the API
// (http://localhost:8000); in production it's unset, so the socket uses this origin and Nginx
// routes /socket.io to Express. The session cookie authenticates the handshake either way.
let socket: Socket | null = null;
export const getSocket = () => {
  if (socket) return socket;
  const s = io(process.env.NEXT_PUBLIC_SOCKET_URL || undefined, {
    withCredentials: true,
    autoConnect: true,
    // Must match the server: Next.js redirects "/socket.io/" (trailing slash) when proxying.
    addTrailingSlash: false,
  });
  // Socket.IO never retries after the server closes a socket. The server does that whenever
  // the session changes (team switch or sign-out in any tab, password change, 60 s recheck),
  // which left the badge on "Reconnecting…" forever (Prompt 44). Retry once with the current
  // cookie: a still-valid session reconnects, a revoked one fails the handshake (Offline).
  s.on("disconnect", (reason) => {
    if (reason === "io server disconnect") setTimeout(() => s.connect(), 1000);
  });
  return (socket = s);
};

/**
 * Sign-in, team switch, password change and sign-out change the session: reconnect with the
 * new cookie. The same socket object is kept, so mounted components keep their listeners.
 */
export const resetSocket = () => {
  socket?.disconnect().connect();
};

/** The current socket id, sent as X-Socket-Id so the author's own tab skips its own echo. */
export const currentSocketId = () =>
  socket?.connected ? socket.id : undefined;

export type LiveStatus = "connecting" | "live" | "offline";
export type PresenceUser = { user_id: string; name: string; editing: boolean };
export type DashboardChange = {
  dashboard_id: string;
  kind:
    | "renamed"
    | "deleted"
    | "widget_added"
    | "widget_updated"
    | "widget_removed"
    | "layout";
  actor: { user_id: string; name: string } | null;
  widget_ids?: string[];
  name?: string;
};

/**
 * Joins a dashboard's live room: reports connection status and who else is here, and calls
 * `onChange` for every change someone else makes. Re-joins automatically after a reconnect.
 */
export function useDashboardLive(
  dashboardId: string,
  onChange: (change: DashboardChange) => void,
  editing: boolean
) {
  const [status, setStatus] = useState<LiveStatus>("connecting");
  const [users, setUsers] = useState<PresenceUser[]>([]);
  const onChangeRef = useRef(onChange);
  useEffect(() => {
    onChangeRef.current = onChange;
  });

  useEffect(() => {
    const s = getSocket();
    const join = () =>
      s.emit("dashboard:join", dashboardId, (res: { ok: boolean }) =>
        setStatus(res.ok ? "live" : "offline")
      );
    const onDisconnect = () => setStatus("connecting");
    const onError = () => setStatus("offline");
    const onPresence = (p: { dashboard_id: string; users: PresenceUser[] }) => {
      if (p.dashboard_id === dashboardId) setUsers(p.users);
    };
    const onChanged = (c: DashboardChange) => {
      if (c.dashboard_id === dashboardId) onChangeRef.current(c);
    };

    if (s.connected) join();
    s.on("connect", join);
    s.on("disconnect", onDisconnect);
    s.on("connect_error", onError);
    s.on("presence", onPresence);
    s.on("dashboard:changed", onChanged);
    return () => {
      s.emit("dashboard:leave");
      s.off("connect", join);
      s.off("disconnect", onDisconnect);
      s.off("connect_error", onError);
      s.off("presence", onPresence);
      s.off("dashboard:changed", onChanged);
    };
  }, [dashboardId]);

  useEffect(() => {
    getSocket().emit("presence:editing", editing);
  }, [editing, dashboardId]);

  return { status, users };
}

/**
 * Subscribe to a socket event for the component's lifetime (Tier 2 A/B: team-channel events
 * such as "dashboards:changed", "teams:changed" and "metrics:tick"). The handler may change
 * every render; the subscription doesn't.
 */
export function useSocketEvent<T>(
  event: string,
  handler: (payload: T) => void
) {
  const handlerRef = useRef(handler);
  useEffect(() => {
    handlerRef.current = handler;
  });
  useEffect(() => {
    const s = getSocket();
    const listener = (payload: T) => handlerRef.current(payload);
    s.on(event, listener);
    return () => {
      s.off(event, listener);
    };
  }, [event]);
}

export type MetricTick = {
  team_id: string;
  points: { metric: string; ts: string; value: number }[];
};
