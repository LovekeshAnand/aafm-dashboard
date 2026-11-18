// Features after Tier 3 (Prompts 68-69, docs/next-features-plan.md), over real HTTP, sockets
// and the database, in a throwaway organization ("feat-<timestamp>").
import assert from "node:assert/strict";
import { once } from "node:events";
import http from "node:http";
import { after, before, describe, test } from "node:test";
import pg from "pg";
import { io as connect } from "socket.io-client";

const ORIGIN = "http://localhost:3000";
Object.assign(process.env, {
  CORS_ORIGIN: ORIGIN,
  AUTH_RATE_LIMIT: "1000",
  WEBHOOK_ALLOW_PRIVATE: "1", // F5 test receiver on 127.0.0.1
});
const { app } = await import("../src/app.js");
const { pool } = await import("../src/db/pool.js");
const { initRealtime } = await import("../src/realtime.js");
const { hashPassword } = await import("../src/utils/password.js");

const PASSWORD = "Feature-test-password-1";
const owner = new pg.Client({
  connectionString: process.env.MIGRATION_DATABASE_URL,
});
let server, io, base, org, ops, sales, slug;
const users = {};
const sockets = [];

before(async () => {
  server = app.listen(0);
  io = initRealtime(server);
  base = `http://127.0.0.1:${server.address().port}`;
  await owner.connect();
  slug = `feat-${Date.now()}`;
  ({
    rows: [org],
  } = await owner.query(
    "INSERT INTO organizations (slug, name) VALUES ($1, 'Features') RETURNING id",
    [slug]
  ));
  const team = async (name) =>
    (
      await owner.query(
        "INSERT INTO teams (org_id, name) VALUES ($1, $2) RETURNING id",
        [org.id, name]
      )
    ).rows[0];
  ops = await team("Ops");
  sales = await team("Sales");
  const hash = await hashPassword(PASSWORD);
  for (const [key, teamId, role] of [
    ["boss", null, "super_admin"],
    ["lead", ops.id, "admin"],
    ["ann", ops.id, "editor"],
    ["sid", sales.id, "viewer"],
  ]) {
    const {
      rows: [u],
    } = await owner.query(
      "INSERT INTO users (org_id, email, name, password_hash) VALUES ($1, $2, $3, $4) RETURNING id",
      [org.id, `${key}@feat.test`, `Feat ${key}`, hash]
    );
    users[key] = u.id;
    await owner.query(
      "INSERT INTO memberships (user_id, org_id, team_id, role) VALUES ($1, $2, $3, $4)",
      [u.id, org.id, teamId, role]
    );
  }
});

after(async () => {
  sockets.forEach((s) => s.disconnect());
  await owner.query("DELETE FROM organizations WHERE id = $1", [org.id]);
  await owner.end();
  await new Promise((resolve) => io.close(resolve));
  await pool.end();
});

const signIn = async (user, teamName) => {
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
    org: slug,
    email: `${user}@feat.test`,
    password: PASSWORD,
  });
  assert.equal(login.status, 200, JSON.stringify(login.body));
  if (
    !login.body.data.active_membership_id &&
    login.body.data.memberships.length
  ) {
    const m = login.body.data.memberships.find((x) =>
      teamName ? x.team_name === teamName : true
    );
    await call("POST", "/auth/context", { membership_id: m.id });
  }
  return { call, cookie: () => cookie };
};

const inbox = async (client) =>
  (await client.call("GET", "/notifications")).body.data;
const membershipOf = async (userId, teamId) =>
  (
    await owner.query(
      "SELECT id FROM memberships WHERE user_id = $1 AND team_id = $2",
      [userId, teamId]
    )
  ).rows[0]?.id;

describe("notifications (F3 + F4)", () => {
  test("being added to a team arrives live, with the team and the role", async () => {
    const sid = await signIn("sid");
    const socket = connect(base, {
      transports: ["websocket"],
      extraHeaders: { cookie: sid.cookie(), origin: ORIGIN },
      reconnection: false,
    });
    sockets.push(socket);
    await once(socket, "connect");
    const pushed = once(socket, "notifications:new");

    const lead = await signIn("lead");
    const added = await lead.call("POST", `/teams/${ops.id}/members`, {
      email: "sid@feat.test",
      name: "Feat sid",
      role: "viewer",
    });
    assert.equal(added.status, 201);

    const [live] = await pushed;
    assert.equal(live.kind, "team_added");
    assert.equal(live.title, "You've been added to Ops");
    assert.match(live.body, /Feat lead added you as Viewer/);
    assert.equal(live.link, "/select-team");

    const { items, unread } = await inbox(sid);
    assert.equal(items[0].id, live.id);
    assert.equal(unread, 1);
  });

  test("role changes are notified; an unchanged role is not", async () => {
    const lead = await signIn("lead");
    const membership = await membershipOf(users.ann, ops.id);
    await lead.call("PATCH", `/memberships/${membership}`, { role: "viewer" });
    await lead.call("PATCH", `/memberships/${membership}`, { role: "viewer" }); // no change
    const ann = await signIn("ann");
    const roleNotes = (await inbox(ann)).items.filter(
      (n) => n.kind === "role_changed"
    );
    assert.equal(roleNotes.length, 1);
    assert.equal(roleNotes[0].title, "Your role in Ops is now Viewer");
    assert.match(roleNotes[0].body, /from Editor to Viewer/);
  });

  test("removal and an admin password reset are both explained", async () => {
    const lead = await signIn("lead");
    const membership = await membershipOf(users.sid, ops.id);
    assert.equal(
      (await lead.call("DELETE", `/memberships/${membership}`)).status,
      200
    );
    const boss = await signIn("boss");
    assert.equal(
      (await boss.call("POST", `/users/${users.sid}/reset-password`)).status,
      200
    );
    const { rows } = await owner.query(
      "SELECT kind, title FROM notifications WHERE user_id = $1 ORDER BY created_at",
      [users.sid]
    );
    const kinds = rows.map((r) => r.kind);
    assert.ok(kinds.includes("team_removed"));
    assert.ok(kinds.includes("password_reset"));
    assert.equal(
      rows.find((r) => r.kind === "team_removed").title,
      "You were removed from Ops"
    );
  });

  test("changing your own password leaves a security notice", async () => {
    const ann = await signIn("ann");
    const changed = await ann.call("POST", "/auth/password", {
      current_password: PASSWORD,
      new_password: `${PASSWORD}-2`,
    });
    assert.equal(changed.status, 200);
    const { items } = await inbox(ann);
    assert.equal(items[0].kind, "password_changed");
    await owner.query("UPDATE users SET password_hash = $2 WHERE id = $1", [
      users.ann,
      await hashPassword(PASSWORD),
    ]);
  });

  test("each person sees and marks only their own", async () => {
    const lead = await signIn("lead");
    const ann = await signIn("ann");
    const annItems = (await inbox(ann)).items;
    assert.ok(annItems.length > 0);
    assert.ok(
      (await inbox(lead)).items.every(
        (n) => !annItems.some((a) => a.id === n.id)
      ),
      "Ann's notifications are invisible to her admin"
    );
    const marked = await lead.call("POST", "/notifications/read", {
      ids: annItems.map((n) => n.id),
    });
    assert.equal(marked.body.data.marked, 0, "nobody can mark someone else's");
    assert.equal(
      (await ann.call("POST", "/notifications/read", {})).status,
      200
    );
    assert.equal((await inbox(ann)).unread, 0);
  });

  test("deleting a team tells its members", async () => {
    const boss = await signIn("boss");
    assert.equal((await boss.call("DELETE", `/teams/${sales.id}`)).status, 200);
    const { rows } = await owner.query(
      "SELECT title FROM notifications WHERE user_id = $1 AND kind = 'team_deleted'",
      [users.sid]
    );
    assert.equal(rows[0]?.title, "The team Sales was deleted");
  });
});

describe("audit log search, filters and pages (F6)", () => {
  test("search finds by person, action and details; pages add up to the total", async () => {
    const lead = await signIn("lead");
    for (let i = 0; i < 3; i++)
      await lead.call("POST", "/projects", { name: `Searchable-${i}` });
    const boss = await signIn("boss");
    const get = async (query) =>
      (await boss.call("GET", `/audit?${query}`)).body.data;

    const byDetails = await get("q=searchable");
    assert.equal(
      byDetails.total,
      3,
      "matches the project names in the details"
    );
    assert.ok(byDetails.entries.every((e) => e.action === "project.create"));
    assert.ok(
      (await get("q=FEAT%20LEAD")).total > 0,
      "by person, case-insensitive"
    );
    assert.equal(
      (await get("q=%25")).total,
      0,
      "% is a plain character, not a wildcard"
    );

    // Each request writes its own audit.view entry; with as_of the pages stay put anyway.
    const first = await get("size=10&page=1");
    const ids = new Set(first.entries.map((e) => e.seq));
    let seen = first.entries.length;
    for (let page = 2; page <= first.pages; page++)
      for (const e of (await get(`size=10&page=${page}&as_of=${first.as_of}`))
        .entries) {
        ids.add(e.seq);
        seen++;
      }
    assert.equal(
      seen,
      first.total,
      "every entry exactly once across the pages"
    );
    assert.equal(ids.size, first.total, "no duplicates");
  });

  test("issues-only and issues-first sorting", async () => {
    const ann = await signIn("ann");
    assert.equal((await ann.call("GET", "/audit")).status, 403); // an issue: a denial
    await new Promise((resolve) => setTimeout(resolve, 300)); // denial writes aren't awaited
    const boss = await signIn("boss");
    const issues = (await boss.call("GET", "/audit?result=issues")).body.data;
    assert.ok(issues.total > 0);
    assert.ok(issues.entries.every((e) => e.result !== "allowed"));
    const sorted = (await boss.call("GET", "/audit?sort=issues&size=10")).body
      .data;
    assert.notEqual(sorted.entries[0].result, "allowed", "issues come first");
    const oldest = (await boss.call("GET", "/audit?sort=oldest&size=10")).body
      .data;
    assert.ok(oldest.entries[0].seq < oldest.entries[1].seq);
  });

  test("an Admin's search never leaves their team", async () => {
    const lead = await signIn("lead");
    const res = (await lead.call("GET", "/audit?size=200")).body.data;
    assert.ok(res.total > 0);
    assert.ok(res.entries.every((e) => e.team_id === ops.id));
    const other = (await lead.call("GET", `/audit?team_id=${sales.id}`)).body
      .data;
    assert.equal(other.total, 0, "asking for another team returns nothing");
  });
});

describe("webhooks for non-developers (F5)", () => {
  test("a wrong link for the chosen app is refused with a clear reason", async () => {
    const lead = await signIn("lead");
    const wrong = await lead.call("POST", "/webhooks", {
      format: "slack",
      url: "https://example.com/not-slack",
      events: ["alert.opened"],
    });
    assert.equal(wrong.status, 400);
    assert.match(
      wrong.body.errors[0].message,
      /doesn't look like a Slack webhook link/
    );
    // Outside development, chat apps must use https.
    delete process.env.WEBHOOK_ALLOW_PRIVATE;
    try {
      const plain = await lead.call("POST", "/webhooks", {
        format: "discord",
        url: "http://discord.com/api/webhooks/1/x",
        events: ["alert.opened"],
      });
      assert.match(plain.body.errors[0].message, /https/);
    } finally {
      process.env.WEBHOOK_ALLOW_PRIVATE = "1";
    }
    const ok = await lead.call("POST", "/webhooks", {
      format: "slack",
      url: "https://hooks.slack.com/services/T000/B000/xyz",
      events: ["alert.opened"],
    });
    assert.equal(ok.status, 201);
    assert.equal(ok.body.data.format, "slack");
    // The audit log keeps only the host: for Slack the link itself is the credential.
    const { rows } = await owner.query(
      "SELECT meta FROM audit_log WHERE action = 'webhook.create' AND target_id = $1",
      [ok.body.data.id]
    );
    assert.equal(rows[0].meta.host, "hooks.slack.com");
    assert.ok(!JSON.stringify(rows[0].meta).includes("/services/"));
    await lead.call("DELETE", `/webhooks/${ok.body.data.id}`);
  });

  test("a Teams endpoint receives a readable Adaptive Card", async () => {
    const { deliverDue } = await import("../src/webhooks.js");
    const got = [];
    const receiver = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        got.push(JSON.parse(body));
        res.writeHead(202).end();
      });
    });
    receiver.listen(0, "127.0.0.1");
    await once(receiver, "listening");
    try {
      const lead = await signIn("lead");
      const hook = await lead.call("POST", "/webhooks", {
        format: "teams",
        url: `http://127.0.0.1:${receiver.address().port}/teams`,
        events: ["alert.opened"],
      });
      assert.equal(hook.status, 201);
      await lead.call("POST", `/webhooks/${hook.body.data.id}/test`);
      for (let i = 0; i < 50 && !got.length; i++) {
        await deliverDue();
        await new Promise((r) => setTimeout(r, 100));
      }
      const card = got[0];
      assert.equal(card.type, "message");
      assert.match(
        card.attachments[0].content.body[0].text,
        /Test message from AAFM Analytics/
      );
      assert.equal(
        card.attachments[0].content.actions[0].url,
        `${ORIGIN}/dashboards`
      );
    } finally {
      receiver.close();
    }
  });
});

describe("data access requests (F7)", () => {
  let money, request;
  const hour = Math.floor(Date.now() / 3600e3) * 3600e3 - 3 * 3600e3;

  before(async () => {
    ({
      rows: [money],
    } = await owner.query(
      "INSERT INTO teams (org_id, name) VALUES ($1, 'Money') RETURNING id",
      [org.id]
    ));
    const {
      rows: [mia],
    } = await owner.query(
      "INSERT INTO users (org_id, email, name, password_hash) VALUES ($1, 'mia@feat.test', 'Feat mia', $2) RETURNING id",
      [org.id, await hashPassword(PASSWORD)]
    );
    users.mia = mia.id;
    await owner.query(
      "INSERT INTO memberships (user_id, org_id, team_id, role) VALUES ($1, $2, $3, 'admin')",
      [mia.id, org.id, money.id]
    );
    // Known figures: revenue 300 and 120, users 100 and 40 -> ARPU 3 in each hour.
    await owner.query(
      `INSERT INTO metric_points (org_id, team_id, project_id, metric, ts, value)
       SELECT $1, $2, (SELECT id FROM projects WHERE team_id = $2), m::metric_name, ts::timestamptz, v
       FROM (VALUES ('revenue', $3, 300), ('users', $3, 100), ('revenue', $4, 120), ('users', $4, 40)) x(m, ts, v)`,
      [
        org.id,
        money.id,
        new Date(hour + 10 * 60e3).toISOString(),
        new Date(hour + 70 * 60e3).toISOString(),
      ]
    );
  });

  test("a request reaches the team's admins; nothing is visible before approval", async () => {
    const ann = await signIn("ann");
    const res = await ann.call("POST", "/access-requests", {
      team_id: money.id,
      kind: "kpi",
      source: "arpu",
      reason: "Quarterly comparison",
      days: 7,
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    request = res.body.data.id;
    const { rows } = await owner.query(
      "SELECT user_id, title FROM notifications WHERE kind = 'access_requested' AND meta->>'request_id' = $1",
      [request]
    );
    const notified = rows.map((r) => r.user_id).sort();
    assert.deepEqual(
      notified,
      [users.boss, users.mia].sort(),
      "Money's admin and the Super Admin"
    );
    assert.equal(rows[0].title, "Feat ann asks to see ARPU of Money");
    assert.equal(
      (await ann.call("GET", `/shared/${request}/summary`)).status,
      403,
      "not before approval"
    );
    const again = await ann.call("POST", "/access-requests", {
      team_id: money.id,
      kind: "kpi",
      source: "arpu",
      reason: "again",
      days: 7,
    });
    assert.equal(again.status, 409, "one open request per figure");
    const own = await ann.call("POST", "/access-requests", {
      team_id: ops.id,
      kind: "metric",
      source: "revenue",
      reason: "my own team",
      days: 1,
    });
    assert.equal(own.status, 409);
    assert.match(own.body.message, /already see/);
  });

  test("only that team's admins (or the Super Admin) can decide", async () => {
    const lead = await signIn("lead"); // Ops admin, not Money
    assert.deepEqual(
      (await lead.call("GET", "/access-requests?box=incoming")).body.data,
      []
    );
    assert.equal(
      (
        await lead.call("POST", `/access-requests/${request}/decide`, {
          approve: true,
        })
      ).status,
      404
    );
    const mia = await signIn("mia");
    const incoming = (await mia.call("GET", "/access-requests?box=incoming"))
      .body.data;
    assert.equal(incoming[0].id, request);
    assert.equal(incoming[0].requester_name, "Feat ann");
  });

  test("approved: exactly that figure, and nothing else of the team", async () => {
    const mia = await signIn("mia");
    const approved = await mia.call(
      "POST",
      `/access-requests/${request}/decide`,
      {
        approve: true,
        days: 7,
        note: "OK for Q3",
      }
    );
    assert.equal(approved.status, 200);
    const ann = await signIn("ann");
    const from = new Date(hour).toISOString();
    const to = new Date(hour + 2 * 3600e3).toISOString();
    const series = await ann.call(
      "GET",
      `/shared/${request}/series?from=${from}&to=${to}&bucket=1h`
    );
    assert.deepEqual(
      series.body.data.points.map((p) => p.value),
      [3, 3],
      "ARPU only"
    );
    const summary = (
      await ann.call("GET", `/shared/${request}/summary?range=24h`)
    ).body.data;
    // The live simulator also ticks this team, so compare with the database's own figure.
    const {
      rows: [db24],
    } = await owner.query(
      `SELECT sum(value) FILTER (WHERE metric = 'revenue') / sum(value) FILTER (WHERE metric = 'users') AS arpu
       FROM metric_points WHERE team_id = $1 AND ts > now() - interval '24 hours'`,
      [money.id]
    );
    assert.ok(
      Math.abs(summary.current - db24.arpu) / db24.arpu < 0.01,
      `${summary.current} vs ${db24.arpu}`
    );

    // The KPI grant does not reveal its inputs, and nothing leaks into Ann's own totals.
    const raw = await ann.call(
      "GET",
      `/metrics/series?metric=revenue&from=${from}&to=${to}&bucket=1h&team_id=${money.id}`
    );
    assert.deepEqual(
      raw.body.data.points,
      [],
      "raw revenue stays hidden (RLS)"
    );
    const own = (await ann.call("GET", "/metrics/summary?range=24h")).body.data;
    assert.ok(
      own.metrics.every((m) => m.current < 300 || m.metric !== "revenue")
    );

    const { rows } = await owner.query(
      "SELECT title, body FROM notifications WHERE user_id = $1 AND kind = 'access_approved'",
      [users.ann]
    );
    assert.equal(rows[0].title, "You can now see ARPU of Money");
    assert.match(rows[0].body, /OK for Q3/);
  });

  test("access ends when revoked or when it expires", async () => {
    const mia = await signIn("mia");
    const ann = await signIn("ann");
    assert.equal(
      (await mia.call("POST", `/access-requests/${request}/revoke`)).status,
      200
    );
    assert.equal(
      (await ann.call("GET", `/shared/${request}/summary`)).status,
      403
    );

    const second = await ann.call("POST", "/access-requests", {
      team_id: money.id,
      kind: "metric",
      source: "clicks",
      reason: "Campaign check",
      days: 1,
    });
    await mia.call("POST", `/access-requests/${second.body.data.id}/decide`, {
      approve: true,
    });
    assert.equal(
      (await ann.call("GET", `/shared/${second.body.data.id}/summary`)).status,
      200
    );
    await owner.query(
      "UPDATE access_requests SET expires_at = now() - interval '1 second' WHERE id = $1",
      [second.body.data.id]
    );
    assert.equal(
      (await ann.call("GET", `/shared/${second.body.data.id}/summary`)).status,
      403,
      "expired"
    );
  });

  test("a declined request tells the requester why", async () => {
    const ann = await signIn("ann");
    const req = await ann.call("POST", "/access-requests", {
      team_id: money.id,
      kind: "metric",
      source: "errors",
      reason: "Debugging",
      days: 1,
    });
    const mia = await signIn("mia");
    await mia.call("POST", `/access-requests/${req.body.data.id}/decide`, {
      approve: false,
      note: "Ask the on-call team instead",
    });
    const { rows } = await owner.query(
      "SELECT body FROM notifications WHERE user_id = $1 AND kind = 'access_declined' ORDER BY created_at DESC LIMIT 1",
      [users.ann]
    );
    assert.match(rows[0].body, /on-call team/);
  });
});

describe("completed projects (F1)", () => {
  let project, dashboard;

  before(async () => {
    const lead = await signIn("lead");
    project = (await lead.call("POST", "/projects", { name: "Launch" })).body
      .data;
    dashboard = (
      await lead.call("POST", "/dashboards", {
        name: "Launch board",
        project_id: project.id,
      })
    ).body.data;
    await lead.call("POST", `/dashboards/${dashboard.id}/widgets`, {
      type: "stat",
      metric: "clicks",
      x: 0,
      y: 0,
      w: 2,
      h: 2,
    });
    // Old history and an open alert, to see what completing does with them.
    await owner.query(
      `INSERT INTO metric_points (org_id, team_id, project_id, metric, ts, value)
       VALUES ($1, $2, $3, 'clicks', now() - interval '40 days', 7)`,
      [org.id, ops.id, project.id]
    );
    await owner.query(
      `INSERT INTO alerts (org_id, team_id, project_id, metric, direction, value, mean, stddev, z, peak_z)
       VALUES ($1, $2, $3, 'errors', 'above', 30, 10, 2, 10, 10)`,
      [org.id, ops.id, project.id]
    );
  });

  test("only admins complete; completing closes open alerts", async () => {
    const ann = await signIn("ann"); // editor
    assert.equal(
      (await ann.call("POST", `/projects/${project.id}/complete`)).status,
      403
    );
    const lead = await signIn("lead");
    const done = await lead.call("POST", `/projects/${project.id}/complete`);
    assert.equal(done.status, 200);
    assert.ok(done.body.data.completed_at);
    assert.equal(
      (await lead.call("POST", `/projects/${project.id}/complete`)).status,
      409
    );
    const { rows } = await owner.query(
      "SELECT status FROM alerts WHERE project_id = $1",
      [project.id]
    );
    assert.deepEqual(
      rows.map((r) => r.status),
      ["resolved"]
    );
  });

  test("its dashboards are read-only, and it can't be renamed or deleted", async () => {
    const lead = await signIn("lead");
    const blocked = [
      await lead.call("PATCH", `/dashboards/${dashboard.id}`, {
        name: "x",
        version: dashboard.version,
      }),
      await lead.call("POST", `/dashboards/${dashboard.id}/widgets`, {
        type: "stat",
        metric: "errors",
        x: 2,
        y: 0,
        w: 2,
        h: 2,
      }),
      await lead.call("DELETE", `/dashboards/${dashboard.id}`),
      await lead.call("POST", "/dashboards", {
        name: "New",
        project_id: project.id,
      }),
      await lead.call("PATCH", `/projects/${project.id}`, { name: "Renamed" }),
      await lead.call("DELETE", `/projects/${project.id}`),
    ];
    for (const res of blocked) {
      assert.equal(res.status, 409, JSON.stringify(res.body));
      assert.match(res.body.message, /completed/);
    }
    // Still readable.
    assert.equal(
      (await lead.call("GET", `/dashboards/${dashboard.id}`)).status,
      200
    );
  });

  test("no live data and history is kept; reopening resumes", async () => {
    const tick = async () => {
      await owner.query(
        "UPDATE simulator_state SET last_tick = now() - interval '1 hour'"
      );
      return (await owner.query("SELECT * FROM app.simulate_tick(15)")).rows;
    };
    await new Promise((r) => setTimeout(r, 1100));
    await tick();
    // Whoever ticked (this test, or a running dev server's simulator), other projects got
    // points after the completion and this one didn't.
    const since = `SELECT count(*) FILTER (WHERE project_id = $1)::int AS mine,
                          count(*) FILTER (WHERE project_id <> $1)::int AS others
                   FROM metric_points
                   WHERE ts >= (SELECT completed_at FROM projects WHERE id = $1)`;
    const {
      rows: [frozen],
    } = await owner.query(since, [project.id]);
    assert.ok(frozen.others > 0, "a tick ran after completion");
    assert.equal(frozen.mine, 0, "no data since completion");
    await owner.query(
      "SELECT app.housekeeping(interval '30 days', interval '7 days')"
    );
    const { rowCount } = await owner.query(
      "SELECT 1 FROM metric_points WHERE project_id = $1 AND ts < now() - interval '30 days'",
      [project.id]
    );
    assert.equal(rowCount, 1, "40-day-old point kept");

    const lead = await signIn("lead");
    assert.equal(
      (await lead.call("POST", `/projects/${project.id}/reopen`)).status,
      200
    );
    // A tick in a new second (points are unique per project, metric and second). The dev
    // server's simulator may tick it first, so judge by the stored points, not this tick.
    const reopened = new Date(Date.now() - 1000);
    await new Promise((r) => setTimeout(r, 1100));
    await tick();
    const resumed = await owner.query(
      "SELECT 1 FROM metric_points WHERE project_id = $1 AND ts >= $2",
      [project.id, reopened]
    );
    assert.ok(resumed.rowCount > 0, "ticks resume");
    assert.equal(
      (
        await lead.call("PATCH", `/dashboards/${dashboard.id}`, {
          name: "Editable",
          version: dashboard.version,
        })
      ).status,
      200
    );
  });

  test("deleting the team still works with a completed project inside", async () => {
    const {
      rows: [temp],
    } = await owner.query(
      "INSERT INTO teams (org_id, name) VALUES ($1, 'Temp') RETURNING id",
      [org.id]
    );
    const {
      rows: [p],
    } = await owner.query("SELECT id FROM projects WHERE team_id = $1", [
      temp.id,
    ]);
    await owner.query(
      "INSERT INTO dashboards (org_id, team_id, project_id, name) VALUES ($1, $2, $3, 'd')",
      [org.id, temp.id, p.id]
    );
    await owner.query(
      "UPDATE projects SET completed_at = now() WHERE id = $1",
      [p.id]
    );
    await owner.query("DELETE FROM teams WHERE id = $1", [temp.id]);
    const { rowCount } = await owner.query(
      "SELECT 1 FROM projects WHERE id = $1",
      [p.id]
    );
    assert.equal(rowCount, 0);
  });
});
