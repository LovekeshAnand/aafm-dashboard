import { createAdapter } from "@socket.io/postgres-adapter";
import { Server } from "socket.io";
import { SESSION } from "./constants.js";
import { pool, withContext } from "./db/pool.js";
import { hashToken, resolveSession } from "./utils/session.js";

// Real-time dashboard sync + presence (Prompts 32-33).
// Events carry ids only, never dashboard data: each browser re-reads under its own RLS.
let io;
const room = (dashboardId) => `dashboard:${dashboardId}`;
const teamRoom = (teamId) => `team:${teamId}`;
const orgRoom = (orgId) => `org:${orgId}`;
// Keyed by the token's hash, never the token itself (room names are visible to the adapter).
const sessionRoom = (token) => `session:${hashToken(token).toString("hex")}`;
const userRoom = (userId) => `user:${userId}`;
const MESSAGES_PER_MINUTE = 100;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REVALIDATE_MS = 60_000;

/** Reads one cookie from a raw Cookie header (no extra dependency needed). */
const readCookie = (header, name) => {
  const pair = header?.split(/;\s*/).find((c) => c.startsWith(`${name}=`));
  return pair ? decodeURIComponent(pair.slice(name.length + 1)) : undefined;
};

const allowedOrigins = () => process.env.CORS_ORIGIN?.split(",") ?? [];

/**
 * Everyone currently in a dashboard room, one entry per user (multiple tabs collapse).
 * Presence is best-effort (Prompt 50): asking the whole cluster times out if another API
 * instance has died, and that must never fail a join on a healthy instance. Then this
 * instance's own sockets are used until the adapter notices the dead node.
 */
const presenceOf = async (dashboardId) => {
  let sockets;
  try {
    sockets = await io.in(room(dashboardId)).fetchSockets();
  } catch (err) {
    console.warn(
      `presence: cluster lookup failed (${err.message}); using local sockets`
    );
    sockets = await io.local.in(room(dashboardId)).fetchSockets();
  }
  const byUser = new Map();
  for (const s of sockets) {
    const prev = byUser.get(s.data.userId);
    byUser.set(s.data.userId, {
      user_id: s.data.userId,
      name: s.data.name,
      editing: Boolean(prev?.editing || s.data.editing),
    });
  }
  return [...byUser.values()];
};

const broadcastPresence = async (dashboardId) =>
  io.to(room(dashboardId)).emit("presence", {
    dashboard_id: dashboardId,
    users: await presenceOf(dashboardId),
  });

/**
 * Separate worker process (npm run worker, problems-log #39): no HTTP server and no browser
 * connections, but the same Postgres adapter, so the ticks, alerts and webhook updates it
 * publishes reach the browsers connected to the API instances.
 */
const initEmitter = () => {
  io = new Server();
  io.adapter(createAdapter(pool));
  return io;
};

const initRealtime = (httpServer) => {
  io = new Server(httpServer, {
    // Cross-site WebSocket hijacking guard: browsers always send Origin on the handshake.
    // Same-origin requests through the Next proxy carry no CORS need but still an Origin.
    allowRequest: (req, done) => {
      const origin = req.headers.origin;
      done(null, !origin || allowedOrigins().includes(origin));
    },
    cors: { origin: allowedOrigins(), credentials: true },
    maxHttpBufferSize: 10_000, // clients only send tiny control messages
    // "/socket.io" (no trailing slash): Next.js 308-redirects "/socket.io/" when proxying.
    addTrailingSlash: false,
    serveClient: false,
  });
  io.adapter(createAdapter(pool));

  // Same session cookie as the REST API; a team/org context is required, like requireContext.
  io.use(async (socket, next) => {
    try {
      const token = readCookie(socket.handshake.headers.cookie, SESSION.COOKIE);
      const session = token && (await resolveSession(token));
      if (!session?.role || session.must_change_password)
        return next(new Error("unauthorized"));
      socket.data = {
        token,
        userId: session.user_id,
        name: session.name,
        context: {
          userId: session.user_id,
          orgId: session.org_id,
          teamId: session.team_id,
        },
        dashboardId: null,
        editing: false,
      };
      next();
    } catch (err) {
      // A database failure is not a verdict on the session (Prompt 50): log it, send the client
      // a generic, retryable error (never the internal message), and let it try again.
      console.error("socket auth failed:", err.message);
      next(Object.assign(new Error("unavailable"), { data: { retry: true } }));
    }
  });

  io.on("connection", (socket) => {
    // Tier 2 A: every socket also listens to its scope's channel. A team session gets its
    // team; an org-wide (Super Admin) session gets the org channel, which carries every
    // team's events. These carry list-level changes, live metric ticks and alerts.
    const { orgId, teamId } = socket.data.context;
    socket.join([
      teamId ? teamRoom(teamId) : orgRoom(orgId),
      // OWASP WebSocket Cheat Sheet: on logout, close the user's sockets immediately. These
      // rooms let a REST logout / password change / reset find them (across instances).
      sessionRoom(socket.data.token),
      userRoom(socket.data.userId),
    ]);

    // OWASP WebSocket Cheat Sheet: rate-limit messages ("100 messages per minute is a common
    // starting point"). A client over the limit is disconnected.
    let windowStart = Date.now();
    let count = 0;
    socket.use((packet, next) => {
      const now = Date.now();
      if (now - windowStart > 60_000) {
        windowStart = now;
        count = 0;
      }
      if (++count > MESSAGES_PER_MINUTE) return socket.disconnect(true);
      next();
    });

    const leaveCurrent = async () => {
      const current = socket.data.dashboardId;
      if (!current) return;
      socket.data.dashboardId = null;
      socket.data.editing = false;
      await socket.leave(room(current));
      await broadcastPresence(current);
    };

    // Join only if RLS lets this session read the dashboard (404 otherwise, like REST).
    socket.on("dashboard:join", async (dashboardId, ack = () => {}) => {
      try {
        if (typeof dashboardId !== "string" || !UUID.test(dashboardId))
          return ack({ ok: false });
        // Re-check the session on every join: it may have been revoked or rotated since the
        // handshake (sign-out, team switch, password reset, removed membership).
        const session = await resolveSession(socket.data.token);
        if (!session?.role) {
          ack({ ok: false });
          return socket.disconnect(true);
        }
        const { rowCount } = await withContext(socket.data.context, (db) =>
          db.query("SELECT 1 FROM dashboards WHERE id = $1", [dashboardId])
        );
        if (!rowCount) return ack({ ok: false });
        if (socket.data.dashboardId !== dashboardId) await leaveCurrent();
        socket.data.dashboardId = dashboardId;
        await socket.join(room(dashboardId));
        ack({ ok: true });
        await broadcastPresence(dashboardId);
      } catch (err) {
        console.error(err);
        ack({ ok: false });
      }
    });

    socket.on("dashboard:leave", () => leaveCurrent().catch(console.error));

    socket.on("presence:editing", (editing) => {
      if (!socket.data.dashboardId) return;
      socket.data.editing = editing === true;
      broadcastPresence(socket.data.dashboardId).catch(console.error);
    });

    socket.on("disconnect", () => {
      if (socket.data.dashboardId)
        broadcastPresence(socket.data.dashboardId).catch(console.error);
    });
  });

  // Long-lived sockets must not outlive their session (logout, password reset, removed
  // membership, timeouts): re-check every minute and drop the dead ones. If the database can't
  // answer, nothing is dropped: a DB blip must not disconnect every live user (Prompt 50).
  const timer = setInterval(async () => {
    for (const socket of await io.local.fetchSockets()) {
      let session;
      try {
        session = await resolveSession(socket.data.token);
      } catch (err) {
        console.error("socket recheck skipped:", err.message);
        return;
      }
      if (!session?.role) socket.disconnect(true);
    }
  }, REVALIDATE_MS);
  timer.unref();

  return io;
};

/**
 * Tell everyone viewing a dashboard that it changed. `exceptSocket` (the author's own tab,
 * from the X-Socket-Id header) is skipped because it already shows the change.
 */
const publishDashboardChange = (dashboardId, change, { req } = {}) => {
  if (!io) return;
  const socketId = req?.get("X-Socket-Id");
  const target = socketId
    ? io.to(room(dashboardId)).except(socketId)
    : io.to(room(dashboardId));
  target.emit("dashboard:changed", {
    dashboard_id: dashboardId,
    actor: req ? { user_id: req.auth.user_id, name: req.auth.name } : null,
    ...change,
  });
};

/**
 * A team-level event (Tier 2 A): goes to that team's channel and to its org channel (the
 * Super Admins), never to other teams. Payloads carry ids/values for that team only.
 */
const publishTeamEvent = (orgId, teamId, event, payload) => {
  if (!io) return;
  io.to([teamRoom(teamId), orgRoom(orgId)]).emit(event, {
    team_id: teamId,
    ...payload,
  });
};

/**
 * Close live connections when their session ends (OWASP: on logout, close the user's sockets
 * immediately; the 60 s recheck stays as the backstop).
 * - `{ token }`: that session (logout, team switch).
 * - `{ userId, exceptToken }`: every session of the user except one (password change keeps
 *   the current session; reset revokes all of them).
 */
/** Every open tab of one user (F3: notifications reach all of them at once). */
const publishUserEvent = (userId, event, payload) => {
  if (!io) return;
  io.to(userRoom(userId)).emit(event, payload);
};

const closeSockets = ({ token, userId, exceptToken }) => {
  if (!io) return;
  if (token) return io.in(sessionRoom(token)).disconnectSockets(true);
  const target = io.in(userRoom(userId));
  (exceptToken
    ? target.except(sessionRoom(exceptToken))
    : target
  ).disconnectSockets(true);
};

export {
  closeSockets,
  initEmitter,
  initRealtime,
  publishDashboardChange,
  publishTeamEvent,
  publishUserEvent,
};
