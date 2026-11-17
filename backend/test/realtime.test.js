// Real-time sync over real Socket.IO connections against a real (seeded) database.
// Requires `npm run migrate && npm run seed`. Created rows are prefixed "rt-test-" and removed.
import assert from "node:assert/strict";
import { once } from "node:events";
import { after, before, describe, test } from "node:test";
import pg from "pg";
import { io as connect } from "socket.io-client";

const ORIGIN = "http://localhost:3000";
process.env.CORS_ORIGIN = ORIGIN;
process.env.AUTH_RATE_LIMIT = "1000";
const { app } = await import("../src/app.js");
const { pool } = await import("../src/db/pool.js");
const { initRealtime } = await import("../src/realtime.js");

const PASSWORD = process.env.SEED_PASSWORD || "Password@123";
const owner = new pg.Client({
  connectionString: process.env.MIGRATION_DATABASE_URL,
});
let server, io, base;
const sockets = [];

before(async () => {
  server = app.listen(0);
  io = initRealtime(server);
  base = `http://127.0.0.1:${server.address().port}`;
  await owner.connect();
});

after(async () => {
  sockets.forEach((s) => s.disconnect());
  await owner.query("DELETE FROM dashboards WHERE name LIKE 'rt-test-%'");
  await owner.end();
  await new Promise((resolve) => io.close(resolve));
  await pool.end();
});

/** Signs in over REST and returns the session cookie (picking `team` if there are several). */
const signIn = async (user, team) => {
  const call = async (path, body, cookie = "") => {
    const res = await fetch(`${base}/api/v1${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "X-Requested-With": "test",
        cookie,
      },
      body: JSON.stringify(body),
    });
    const set = res.headers.getSetCookie()[0]?.split(";")[0];
    return { json: await res.json(), cookie: set ?? cookie };
  };
  const login = await call("/auth/login", {
    org: "acme",
    email: `${user}@acme.test`,
    password: PASSWORD,
  });
  if (login.json.data.active_membership_id) return login.cookie;
  const membership = login.json.data.memberships.find(
    (m) => m.team_name === team
  );
  return (
    await call("/auth/context", { membership_id: membership.id }, login.cookie)
  ).cookie;
};

const open = (cookie, origin = ORIGIN) => {
  const socket = connect(base, {
    transports: ["websocket"],
    extraHeaders: { ...(cookie && { cookie }), origin },
    reconnection: false,
  });
  sockets.push(socket);
  return socket;
};
// The socket may already be connected by the time this is awaited (e.g. while another user
// signs in), so check the state first instead of waiting for an event that already fired.
const connected = (socket) =>
  socket.connected
    ? Promise.resolve("connected")
    : Promise.race([
        once(socket, "connect").then(() => "connected"),
        once(socket, "connect_error").then(
          ([err]) => `refused: ${err.message}`
        ),
      ]);
const join = (socket, id) => socket.emitWithAck("dashboard:join", id);

const rest = async (cookie, method, path, body, socketId) => {
  const res = await fetch(`${base}/api/v1${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      "X-Requested-With": "test",
      cookie,
      ...(socketId && { "X-Socket-Id": socketId }),
    },
    body: body && JSON.stringify(body),
  });
  return (await res.json()).data;
};

describe("socket security", () => {
  test("a connection without a session is refused", async () => {
    assert.match(await connected(open(null)), /refused/);
  });

  test("a connection from a foreign origin is refused (cross-site WebSocket hijacking)", async () => {
    const cookie = await signIn("bob");
    assert.match(await connected(open(cookie, "http://evil.test")), /refused/);
  });

  test("a user cannot join another team's dashboard", async () => {
    const {
      rows: [finance],
    } = await owner.query(
      "SELECT d.id FROM dashboards d JOIN teams t ON t.id = d.team_id WHERE t.name = 'Finance' LIMIT 1"
    );
    const carol = open(await signIn("carol"));
    assert.equal(await connected(carol), "connected");
    assert.deepEqual(await join(carol, finance.id), { ok: false });
    assert.deepEqual(await join(carol, "not-a-uuid"), { ok: false });
  });
});

describe("live dashboard sync", () => {
  test("presence lists both viewers; edits reach the other viewer, not the author", async () => {
    const bobCookie = await signIn("bob");
    const dashboard = await rest(bobCookie, "POST", "/dashboards", {
      name: `rt-test-${Date.now()}`,
    });

    const bob = open(bobCookie);
    const alice = open(await signIn("alice", "Finance"));
    assert.equal(await connected(bob), "connected");
    assert.equal(await connected(alice), "connected");

    assert.deepEqual(await join(bob, dashboard.id), { ok: true });
    const presence = once(alice, "presence");
    assert.deepEqual(await join(alice, dashboard.id), { ok: true });
    const [{ users }] = await presence;
    assert.deepEqual(users.map((u) => u.name).sort(), [
      "Alice Admin",
      "Bob Editor",
    ]);

    let bobGotOwnEvent = false;
    bob.on("dashboard:changed", () => (bobGotOwnEvent = true));
    const change = once(alice, "dashboard:changed");
    await rest(
      bobCookie,
      "PATCH",
      `/dashboards/${dashboard.id}`,
      { name: `${dashboard.name}-renamed`, version: dashboard.version },
      bob.id
    );
    const [event] = await change;
    assert.equal(event.kind, "renamed");
    assert.equal(event.dashboard_id, dashboard.id);
    assert.equal(event.actor.name, "Bob Editor");
    assert.equal(event.name, `${dashboard.name}-renamed`);

    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(bobGotOwnEvent, false, "the author's own tab is skipped");

    const editing = once(bob, "presence");
    alice.emit("presence:editing", true);
    const [{ users: after }] = await editing;
    assert.equal(after.find((u) => u.name === "Alice Admin").editing, true);
  });
});
