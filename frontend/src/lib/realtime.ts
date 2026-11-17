"use client";

import { useEffect, useRef, useState } from "react";
import { io, type Socket } from "socket.io-client";

// One socket per tab. In development NEXT_PUBLIC_SOCKET_URL points straight at the API
// (http://localhost:8000); in production it's unset, so the socket uses this origin and Nginx
// routes /socket.io to Express. The session cookie authenticates the handshake either way.
let socket: Socket | null = null;
export const getSocket = () =>
  (socket ??= io(process.env.NEXT_PUBLIC_SOCKET_URL || undefined, {
    withCredentials: true,
    autoConnect: true,
    // Must match the server: Next.js redirects "/socket.io/" (trailing slash) when proxying.
    addTrailingSlash: false,
  }));

/** Sign-in, team switch, password change and sign-out change the session: start a new socket. */
export const resetSocket = () => {
  socket?.disconnect();
  socket = null;
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
