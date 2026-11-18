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
    // Presence is a stream of snapshots: Bob's join may still deliver a "Bob only" snapshot
    // after Alice entered the room (problems-log #41). And anyone else watching the shared
    // seeded org (a developer's open browser follows new dashboards live) may also appear,
    // so wait for the snapshot that includes both, not for exactly two.
    const both = new Promise((resolve) =>
      alice.on("presence", ({ users }) => {
        const names = users.map((u) => u.name);
        if (names.includes("Alice Admin") && names.includes("Bob Editor"))
          resolve(true);
      })
    );
    assert.deepEqual(await join(alice, dashboard.id), { ok: true });
    assert.equal(await both, true);

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

    const editing = new Promise((resolve) =>
      bob.on("presence", ({ users }) => {
        if (users.find((u) => u.name === "Alice Admin")?.editing) resolve(true);
      })
    );
    alice.emit("presence:editing", true);
    assert.equal(await editing, true, "Bob sees Alice marked as editing");
  });
});

describe("team channel (Tier 2 A)", () => {
  test("a new dashboard reaches the same team and the Super Admin, never another team", async () => {
    const bobCookie = await signIn("bob");
    const alice = open(await signIn("alice", "Finance"));
    const carol = open(await signIn("carol"));
    const sam = open(await signIn("super"));
    for (const s of [alice, carol, sam])
      assert.equal(await connected(s), "connected");

    let carolHeard = false;
    carol.on("dashboards:changed", () => (carolHeard = true));
    const aliceHears = once(alice, "dashboards:changed");
    const samHears = once(sam, "dashboards:changed");

    const created = await rest(bobCookie, "POST", "/dashboards", {
      name: `rt-test-list-${Date.now()}`,
    });
    const [[forAlice], [forSam]] = await Promise.all([aliceHears, samHears]);
    assert.equal(forAlice.kind, "created");
    assert.equal(forAlice.dashboard_id, created.id);
    assert.equal(forSam.team_id, created.team_id);

    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(
      carolHeard,
      false,
      "Marketing must not hear about Finance dashboards"
    );
  });
});

describe("live metrics simulator (Tier 2 B)", () => {
  test("a tick writes one point per metric per project and pushes each team only its own", async () => {
    const { runTick } = await import("../src/simulator.js");
    const bob = open(await signIn("bob"));
    const carol = open(await signIn("carol"));
    assert.equal(await connected(bob), "connected");
    assert.equal(await connected(carol), "connected");

    // Let this test claim the interval. A running dev server may claim it first (its own
    // simulator), so retry a few times instead of assuming this process wins.
    const bobTick = once(bob, "metrics:tick");
    const carolTick = once(carol, "metrics:tick");
    let rows = [];
    for (let attempt = 0; attempt < 5 && !rows.length; attempt++) {
      await owner.query(
        "UPDATE simulator_state SET last_tick = now() - interval '1 hour'"
      );
      rows = await runTick(5);
    }

    // Judge the tick by its own rows (other suites add projects in parallel): every project
    // in it has exactly one point for each of the five metrics.
    const { rows: teams } = await owner.query("SELECT id, name FROM teams");
    const perProject = Map.groupBy(rows, (r) => r.project_id);
    assert.ok(perProject.size >= 4, "every seeded project ticked");
    for (const points of perProject.values())
      assert.deepEqual(
        points.map((p) => p.metric).sort(),
        ["clicks", "errors", "page_views", "revenue", "users"],
        "one point per project (Tier 3 A) per metric"
      );

    const finance = teams.find((t) => t.name === "Finance").id;
    const marketing = teams.find((t) => t.name === "Marketing").id;
    const [[forBob], [forCarol]] = await Promise.all([bobTick, carolTick]);
    assert.equal(forBob.team_id, finance);
    assert.equal(forCarol.team_id, marketing);
    assert.deepEqual([...new Set(forBob.points.map((p) => p.metric))].sort(), [
      "clicks",
      "errors",
      "page_views",
      "revenue",
      "users",
    ]);

    assert.deepEqual(
      await runTick(5),
      [],
      "a second tick in the same interval is skipped"
    );
  });
});
