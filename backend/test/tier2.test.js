// Tier 2 C/D/E over real HTTP, real sockets and a real (seeded) database.
// Requires `npm run migrate && npm run seed`. Creates a throwaway team "t2-test-*" (removed
// afterwards, cascading its points and alerts) so assertions never depend on live data.
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
let server, io, base, testTeam, finance;
const sockets = [];

before(async () => {
  server = app.listen(0);
  io = initRealtime(server);
  base = `http://127.0.0.1:${server.address().port}`;
  await owner.connect();
  const {
    rows: [org],
  } = await owner.query("SELECT id FROM organizations WHERE slug = 'acme'");
  ({
    rows: [testTeam],
  } = await owner.query(
    "INSERT INTO teams (org_id, name) VALUES ($1, $2) RETURNING id, org_id",
    [org.id, `t2-test-${Date.now()}`]
  ));
  ({
    rows: [finance],
  } = await owner.query("SELECT id FROM teams WHERE name = 'Finance'"));
});

after(async () => {
  sockets.forEach((s) => s.disconnect());
  await owner.query("DELETE FROM teams WHERE name LIKE 't2-test-%'");
  await owner.query("DELETE FROM dashboards WHERE name LIKE 't2-test-%'");
  await owner.end();
  await new Promise((resolve) => io.close(resolve));
  await pool.end();
});

/** A cookie-keeping REST client for one user (picks `team` if there are several). */
const signIn = async (user, team) => {
  let cookie = "";
  const call = async (method, path, body) => {
    const res = await fetch(`${base}/api/v1${path}`, {
      method,
      headers: {
        "content-type": "application/json",
        "X-Requested-With": "test",
        cookie,
      },
      body: body && JSON.stringify(body),
    });
    const set = res.headers.getSetCookie()[0]?.split(";")[0];
    if (set !== undefined) cookie = set.endsWith("=") ? "" : set;
    return { status: res.status, body: await res.json() };
  };
  const login = await call("POST", "/auth/login", {
    org: "acme",
    email: `${user}@acme.test`,
    password: PASSWORD,
  });
  if (!login.body.data.active_membership_id) {
    const m = login.body.data.memberships.find((x) =>
      team ? x.team_name === team : x.team_id === null
    );
    await call("POST", "/auth/context", { membership_id: m.id });
  }
  return { call, cookie: () => cookie };
};

const openSocket = (cookie) => {
  const socket = connect(base, {
    transports: ["websocket"],
    extraHeaders: { cookie, origin: ORIGIN },
    reconnection: false,
  });
  sockets.push(socket);
  return socket.connected
    ? Promise.resolve(socket)
    : once(socket, "connect").then(() => socket);
};

/** Inserts points for the throwaway team as the owner (the app role can't write metrics). */
const insertPoints = (rows) =>
  owner.query(
    `INSERT INTO metric_points (org_id, team_id, project_id, metric, ts, value)
     SELECT $1, $2, (SELECT id FROM projects WHERE team_id = $2 ORDER BY created_at LIMIT 1),
            r.metric::metric_name, r.ts::timestamptz, r.value
     FROM jsonb_to_recordset($3) AS r(metric text, ts text, value double precision)
     ON CONFLICT DO NOTHING`,
    [testTeam.org_id, testTeam.id, JSON.stringify(rows)]
  );

describe("KPI calculations (Tier 2 C)", () => {
  test("ARPU per bucket is a ratio of sums; a bucket with no users is a gap (null)", async () => {
    const hour = Math.floor(Date.now() / 3600e3) * 3600e3 - 3 * 3600e3;
    const at = (h, min) =>
      new Date(hour + h * 3600e3 + min * 60e3).toISOString();
    await insertPoints([
      { metric: "revenue", ts: at(0, 10), value: 100 },
      { metric: "revenue", ts: at(0, 20), value: 50 },
      { metric: "users", ts: at(0, 10), value: 10 },
      { metric: "users", ts: at(0, 20), value: 15 },
      { metric: "revenue", ts: at(1, 5), value: 30 }, // no users in this hour
    ]);
    const sam = await signIn("super");
    const from = new Date(hour).toISOString();
    const to = new Date(hour + 2 * 3600e3).toISOString();
    const res = await sam.call(
      "GET",
      `/metrics/kpi?kpi=arpu&from=${from}&to=${to}&bucket=1h&team_id=${testTeam.id}`
    );
    assert.equal(res.status, 200);
    assert.deepEqual(
      res.body.data.points.map((p) => p.value),
      [6, null],
      "150 revenue / 25 users = 6; then 30 / 0 users = null, never Infinity"
    );
  });

  test("another team's KPI data is invisible (RLS)", async () => {
    const bob = await signIn("bob");
    const to = new Date().toISOString();
    const from = new Date(Date.now() - 6 * 3600e3).toISOString();
    const res = await bob.call(
      "GET",
      `/metrics/kpi?kpi=arpu&from=${from}&to=${to}&bucket=1h&team_id=${testTeam.id}`
    );
    assert.equal(res.status, 200);
    assert.equal(res.body.data.points.length, 0);
  });

  test("summary KPIs equal the ratio of the summary's own totals", async () => {
    const bob = await signIn("bob");
    const { body } = await bob.call("GET", "/metrics/summary?range=24h");
    const total = (m) => body.data.metrics.find((x) => x.metric === m).current;
    const arpu = body.data.kpis.find((k) => k.kpi === "arpu");
    assert.equal(arpu.current, total("revenue") / total("users"));
    assert.deepEqual(body.data.kpis.map((k) => k.kpi).sort(), [
      "arpu",
      "ctr",
      "error_rate",
    ]);
  });

  test("a widget holds exactly one source: metric or KPI", async () => {
    const bob = await signIn("bob");
    const {
      body: { data: d },
    } = await bob.call("POST", "/dashboards", {
      name: `t2-test-${Date.now()}`,
    });
    const grid = { x: 0, y: 0, w: 3, h: 2 };
    const kpiWidget = await bob.call("POST", `/dashboards/${d.id}/widgets`, {
      type: "stat",
      kpi: "arpu",
      ...grid,
    });
    assert.equal(kpiWidget.status, 201);
    assert.equal(kpiWidget.body.data.kpi, "arpu");
    assert.equal(kpiWidget.body.data.metric, null);
    assert.equal(
      (
        await bob.call("POST", `/dashboards/${d.id}/widgets`, {
          type: "stat",
          kpi: "arpu",
          metric: "clicks",
          ...grid,
        })
      ).status,
      400
    );
    assert.equal(
      (
        await bob.call("POST", `/dashboards/${d.id}/widgets`, {
          type: "stat",
          ...grid,
        })
      ).status,
      400
    );

    const switched = await bob.call(
      "PATCH",
      `/widgets/${kpiWidget.body.data.id}`,
      { metric: "clicks", version: kpiWidget.body.data.version }
    );
    assert.equal(switched.body.data.metric, "clicks");
    assert.equal(
      switched.body.data.kpi,
      null,
      "switching source clears the other one"
    );
  });
});

describe("anomaly detection (Tier 2 D)", () => {
  // 65 minutes of 5-second ticks: a steady hour, then a 4x spike in the last 5 minutes.
  const ticks = (value, fromMin, toMin) => {
    const rows = [];
    for (let s = fromMin * 60; s > toMin * 60; s -= 5) {
      rows.push({
        metric: "errors",
        ts: new Date(Date.now() - s * 1000).toISOString(),
        value: value * (0.95 + Math.random() * 0.1),
      });
    }
    return rows;
  };
  const openAlert = async () =>
    (
      await owner.query(
        "SELECT * FROM alerts WHERE team_id = $1 AND metric = 'errors' AND status = 'open'",
        [testTeam.id]
      )
    ).rows[0];

  test("a sustained spike opens one 'above' alert; returning to normal resolves it", async () => {
    const { runDetection } = await import("../src/simulator.js");
    await insertPoints(ticks(1, 65, 5));
    await insertPoints(ticks(4, 5, 0));
    await runDetection(5);
    const alert = await openAlert();
    assert.ok(alert, "an alert is open for the spiking metric");
    assert.equal(alert.direction, "above");
    assert.ok(alert.z > 2, `z = ${alert.z}`);

    await runDetection(5);
    const { rows } = await owner.query(
      "SELECT count(*)::int AS n FROM alerts WHERE team_id = $1 AND status = 'open'",
      [testTeam.id]
    );
    assert.equal(rows[0].n, 1, "still exactly one open alert (no duplicates)");

    await owner.query(
      "DELETE FROM metric_points WHERE team_id = $1 AND metric = 'errors' AND ts > now() - interval '5 minutes'",
      [testTeam.id]
    );
    await insertPoints(ticks(1, 5, 0));
    await runDetection(5);
    assert.equal(
      await openAlert(),
      undefined,
      "back to normal: resolved (|z| < 1.5)"
    );
    const {
      rows: [resolved],
    } = await owner.query(
      "SELECT status, resolved_at FROM alerts WHERE id = $1",
      [alert.id]
    );
    assert.equal(resolved.status, "resolved");
    assert.ok(resolved.resolved_at);
  });

  test("no alert without enough history", async () => {
    await insertPoints(ticks(9, 5, 0).map((r) => ({ ...r, metric: "clicks" }))); // spike, but no baseline
    const { runDetection } = await import("../src/simulator.js");
    await runDetection(5);
    const { rows } = await owner.query(
      "SELECT 1 FROM alerts WHERE team_id = $1 AND metric = 'clicks'",
      [testTeam.id]
    );
    assert.equal(rows.length, 0);
  });

  test("alerts are team-scoped (RLS): the Super Admin sees them, other teams don't", async () => {
    const sam = await signIn("super");
    const carol = await signIn("carol");
    const samAlerts = (await sam.call("GET", "/alerts")).body.data;
    const carolAlerts = (await carol.call("GET", "/alerts")).body.data;
    assert.ok(samAlerts.some((a) => a.team_id === testTeam.id));
    assert.ok(carolAlerts.every((a) => a.team_id !== testTeam.id));
    const bob = await signIn("bob");
    const bobAlerts = (await bob.call("GET", "/alerts?status=all")).body.data;
    assert.ok(bobAlerts.every((a) => a.team_id === finance.id));
  });
});

describe("WebSocket hardening (Tier 2 E, OWASP)", () => {
  test("signing out closes that session's socket immediately", async () => {
    const bob = await signIn("bob");
    const socket = await openSocket(bob.cookie());
    const closed = once(socket, "disconnect");
    await bob.call("POST", "/auth/logout");
    const [reason] = await closed;
    assert.equal(reason, "io server disconnect");
  });

  test("more than 100 messages a minute disconnects the client", async () => {
    const bob = await signIn("bob");
    const socket = await openSocket(bob.cookie());
    const closed = once(socket, "disconnect");
    for (let i = 0; i < 101; i++) socket.emit("presence:editing", false);
    const [reason] = await closed;
    assert.equal(reason, "io server disconnect");
  });
});
