// Tier 3 (projects, audit log, custom metrics, webhooks) over real HTTP, a real (seeded)
// database, real sockets and a local webhook receiver. Requires `npm run migrate && npm run seed`.
// Works on a throwaway team "t3-test-*" (removed afterwards) so assertions never depend on
// live data. A running dev server may deliver webhooks too, so tests wait for outcomes instead
// of assuming which worker sent them.
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { once } from "node:events";
import http from "node:http";
import { after, before, describe, test } from "node:test";
import pg from "pg";
import { io as connect } from "socket.io-client";

const ORIGIN = "http://localhost:3000";
process.env.CORS_ORIGIN = ORIGIN;
process.env.AUTH_RATE_LIMIT = "1000";
process.env.WEBHOOK_ALLOW_PRIVATE = "1"; // the receiver below listens on 127.0.0.1
const { app } = await import("../src/app.js");
const { pool, withContext } = await import("../src/db/pool.js");
const { initRealtime } = await import("../src/realtime.js");
const { deliverDue, newSecret, send } = await import("../src/webhooks.js");

const PASSWORD = process.env.SEED_PASSWORD || "Password@123";
const owner = new pg.Client({
  connectionString: process.env.MIGRATION_DATABASE_URL,
});
let server, io, base, receiver, hookBase;
let org, team, p1, p2, finance, marketing;
const received = [];
let flakyCalls = 0;
const sockets = [];

before(async () => {
  server = app.listen(0);
  io = initRealtime(server);
  base = `http://127.0.0.1:${server.address().port}`;

  // Local webhook receiver: /ok answers 200, /redirect 302, /gone 410.
  receiver = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      received.push({ path: req.url, headers: req.headers, body });
      if (req.url === "/redirect")
        res.writeHead(302, { location: "http://example.com/" }).end();
      // /flaky fails its first request, then succeeds (a recovered delivery).
      else if (req.url === "/flaky")
        res.writeHead(flakyCalls++ ? 200 : 500).end("ok");
      else res.writeHead(req.url === "/gone" ? 410 : 200).end("ok");
    });
  });
  receiver.listen(0, "127.0.0.1");
  await once(receiver, "listening");
  hookBase = `http://127.0.0.1:${receiver.address().port}`;

  await owner.connect();
  ({
    rows: [org],
  } = await owner.query("SELECT id FROM organizations WHERE slug = 'acme'"));
  ({
    rows: [team],
  } = await owner.query(
    "INSERT INTO teams (org_id, name) VALUES ($1, $2) RETURNING id, org_id",
    [org.id, `t3-test-${Date.now()}`]
  ));
  // The team got its "General" project from the trigger; add a second one.
  ({
    rows: [p1],
  } = await owner.query("SELECT id FROM projects WHERE team_id = $1", [
    team.id,
  ]));
  ({
    rows: [p2],
  } = await owner.query(
    "INSERT INTO projects (org_id, team_id, name) VALUES ($1, $2, 'Second') RETURNING id",
    [org.id, team.id]
  ));
  const { rows: teams } = await owner.query(
    "SELECT id, name FROM teams WHERE name IN ('Finance', 'Marketing')"
  );
  finance = teams.find((t) => t.name === "Finance").id;
  marketing = teams.find((t) => t.name === "Marketing").id;
});

after(async () => {
  sockets.forEach((s) => s.disconnect());
  await owner.query("DELETE FROM dashboards WHERE name LIKE 't3-test-%'");
  await owner.query("DELETE FROM teams WHERE name LIKE 't3-test-%'");
  await owner.end();
  receiver.close();
  await new Promise((resolve) => io.close(resolve));
  await pool.end();
});

/** A cookie-keeping REST client for one user (picks `team` if there are several). */
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
    org: "acme",
    email: `${user}@acme.test`,
    password: PASSWORD,
  });
  if (!login.body.data.active_membership_id) {
    const m = login.body.data.memberships.find((x) =>
      teamName ? x.team_name === teamName : x.team_id === null
    );
    await call("POST", "/auth/context", { membership_id: m.id });
  }
  return { call, cookie: () => cookie };
};

/** Polls `check` (running the webhook worker in between) until it returns a truthy value. */
const waitFor = async (check, label, ms = 15_000) => {
  const end = Date.now() + ms;
  for (;;) {
    await deliverDue();
    const value = await check();
    if (value) return value;
    if (Date.now() > end) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
};

const hour = Math.floor(Date.now() / 3600e3) * 3600e3 - 8 * 3600e3;
const at = (h, min = 10) =>
  new Date(hour + h * 3600e3 + min * 60e3).toISOString();
const insertPoints = (projectId, rows) =>
  owner.query(
    `INSERT INTO metric_points (org_id, team_id, project_id, metric, ts, value)
     SELECT $1, $2, $3, r.metric::metric_name, r.ts::timestamptz, r.value
     FROM jsonb_to_recordset($4) AS r(metric text, ts text, value double precision)`,
    [org.id, team.id, projectId, JSON.stringify(rows)]
  );
const window = (fromHour, toHour) =>
  `from=${at(fromHour, 0)}&to=${at(toHour, 0)}&bucket=1h`;

describe("projects: Org -> Team -> Project (Tier 3 A)", () => {
  test("team totals are the sum of the team's projects", async () => {
    await insertPoints(p1.id, [{ metric: "revenue", ts: at(0), value: 10 }]);
    await insertPoints(p2.id, [{ metric: "revenue", ts: at(0), value: 5 }]);
    const sam = await signIn("super");
    const value = async (q) =>
      (
        await sam.call(
          "GET",
          `/metrics/series?metric=revenue&${window(0, 1)}&${q}`
        )
      ).body.data.points.map((p) => p.value);
    assert.deepEqual(await value(`team_id=${team.id}`), [15]);
    assert.deepEqual(await value(`project_id=${p1.id}`), [10]);
    assert.deepEqual(await value(`project_id=${p2.id}`), [5]);
  });

  test("projects are reached through the team; only Admins manage them", async () => {
    const bob = await signIn("bob");
    const list = await bob.call("GET", "/projects");
    assert.equal(list.status, 200);
    assert.ok(list.body.data.length >= 1);
    assert.ok(list.body.data.every((p) => p.team_id === finance));
    assert.equal(
      (await bob.call("POST", "/projects", { name: "t3-nope" })).status,
      403,
      "an Editor can't create projects"
    );

    const alice = await signIn("alice", "Finance");
    const created = await alice.call("POST", "/projects", { name: "t3-proj" });
    assert.equal(created.status, 201);
    assert.equal(created.body.data.team_id, finance);

    const dave = await signIn("dave");
    assert.equal(
      (
        await dave.call("PATCH", `/projects/${created.body.data.id}`, {
          name: "hijack",
        })
      ).status,
      404,
      "another team's Admin can't even see it"
    );
    assert.equal(
      (await alice.call("DELETE", `/projects/${created.body.data.id}`)).status,
      200
    );
  });

  test("deleting a project removes its dashboards; a team keeps one project", async () => {
    const sam = await signIn("super");
    const t = await sam.call("POST", "/teams", {
      name: `t3-test-del-${Date.now()}`,
    });
    assert.equal(t.status, 201);
    const projects = (
      await sam.call("GET", `/projects?team_id=${t.body.data.id}`)
    ).body.data;
    assert.deepEqual(
      projects.map((p) => p.name),
      ["General"],
      "a new team starts with a General project"
    );
    const other = await sam.call("POST", "/projects", {
      name: "Other",
      team_id: t.body.data.id,
    });
    const dash = await sam.call("POST", "/dashboards", {
      name: "t3-test-in-other",
      project_id: other.body.data.id,
    });
    assert.equal(dash.status, 201);
    assert.equal(dash.body.data.project_id, other.body.data.id);
    assert.equal(dash.body.data.team_id, t.body.data.id);

    assert.equal(
      (await sam.call("DELETE", `/projects/${other.body.data.id}`)).status,
      200
    );
    assert.equal(
      (await sam.call("GET", `/dashboards/${dash.body.data.id}`)).status,
      404,
      "the project's dashboards went with it"
    );
    assert.equal(
      (await sam.call("DELETE", `/projects/${projects[0].id}`)).status,
      409,
      "the last project stays"
    );
  });
});

describe("audit log (Tier 3 B)", () => {
  const entries = async (client, query) =>
    (await client.call("GET", `/audit?${query}`)).body.data.entries;

  test("changes and named reads are recorded with the real actor", async () => {
    const bob = await signIn("bob");
    const created = await bob.call("POST", "/dashboards", {
      name: "t3-test-audit",
    });
    await bob.call("GET", `/dashboards/${created.body.data.id}`);
    const sam = await signIn("super");
    const rows = await entries(
      sam,
      `actor_id=${created.body.data.created_by}&limit=20`
    );
    for (const action of ["dashboard.create", "dashboard.view"]) {
      const row = rows.find(
        (r) => r.action === action && r.target_id === created.body.data.id
      );
      assert.ok(row, action);
      assert.equal(row.actor_name, "Bob Editor");
      assert.equal(row.team_id, finance);
      assert.equal(row.result, "allowed");
    }
  });

  test("a Viewer can't read the log, and the refusal is itself recorded", async () => {
    const carol = await signIn("carol");
    assert.equal((await carol.call("GET", "/audit")).status, 403);
    const sam = await signIn("super");
    const denial = await waitFor(
      async () =>
        (await entries(sam, "action=access.denied&limit=20")).find(
          (r) =>
            r.actor_name === "Carol Viewer" && r.meta.path === "/api/v1/audit"
        ),
      "the denial entry"
    );
    assert.equal(denial.result, "denied");
    assert.equal(denial.meta.status, 403);
  });

  test("a team Admin sees only their own team's entries", async () => {
    const alice = await signIn("alice", "Finance");
    const rows = await entries(alice, "limit=200");
    assert.ok(rows.length > 0);
    assert.ok(rows.every((r) => r.team_id === finance));
    const dave = await signIn("dave");
    assert.ok(
      (await entries(dave, "limit=200")).every((r) => r.team_id === marketing)
    );
  });

  test("failed sign-ins are recorded", async () => {
    const res = await fetch(`${base}/api/v1/auth/login`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "X-Requested-With": "test",
      },
      body: JSON.stringify({
        org: "acme",
        email: "bob@acme.test",
        password: "wrong",
      }),
    });
    assert.equal(res.status, 401);
    const sam = await signIn("super");
    await waitFor(
      async () =>
        (await entries(sam, "action=auth.login_failed&limit=10")).find(
          (r) => r.actor_name === "Bob Editor" && r.result === "failed"
        ),
      "the failed sign-in entry"
    );
  });

  test("the log is append-only, for the app and for the owner", async () => {
    const {
      rows: [sam],
    } = await owner.query(
      "SELECT id FROM users WHERE email = 'super@acme.test'"
    );
    await assert.rejects(
      withContext({ userId: sam.id, orgId: org.id }, (db) =>
        db.query("UPDATE audit_log SET action = 'x.y'")
      ),
      { code: "42501" }
    );
    await assert.rejects(
      owner.query("UPDATE audit_log SET action = 'x.y'"),
      /append-only/
    );
    await assert.rejects(owner.query("DELETE FROM audit_log"), /append-only/);
  });

  test("verify detects an edited row (hash chain)", async () => {
    const sam = await signIn("super");
    const verify = async () =>
      (await sam.call("GET", "/audit/verify")).body.data;
    assert.equal((await verify()).intact, true);

    const {
      rows: [row],
    } = await owner.query(
      "SELECT seq, action FROM audit_log WHERE org_id = $1 ORDER BY seq DESC LIMIT 1 OFFSET 3",
      [org.id]
    );
    const edit = async (action) => {
      await owner.query(
        "ALTER TABLE audit_log DISABLE TRIGGER audit_log_append_only"
      );
      try {
        await owner.query("UPDATE audit_log SET action = $2 WHERE seq = $1", [
          row.seq,
          action,
        ]);
      } finally {
        await owner.query(
          "ALTER TABLE audit_log ENABLE TRIGGER audit_log_append_only"
        );
      }
    };
    await edit("tampered.row");
    try {
      const result = await verify();
      assert.equal(result.intact, false);
      assert.equal(result.first_broken, Number(row.seq));
    } finally {
      await edit(row.action);
    }
    assert.equal(
      (await verify()).intact,
      true,
      "restoring the row restores the chain"
    );
  });
});

describe("custom metrics (Tier 3 D)", () => {
  let metric;

  test("exact values per bucket, and a gap where the formula divides by zero", async () => {
    await insertPoints(p1.id, [
      { metric: "revenue", ts: at(3), value: 100 },
      { metric: "clicks", ts: at(3), value: 20 },
      { metric: "revenue", ts: at(4), value: 30 }, // no clicks in this hour
    ]);
    const sam = await signIn("super");
    const created = await sam.call("POST", "/custom-metrics", {
      team_id: team.id,
      name: "Revenue per click x2",
      formula: "revenue / clicks * 2",
      unit: "currency",
    });
    assert.equal(created.status, 201);
    metric = created.body.data;
    const res = await sam.call(
      "GET",
      `/metrics/custom?id=${metric.id}&${window(3, 5)}`
    );
    assert.equal(res.status, 200);
    assert.deepEqual(
      res.body.data.points.map((p) => p.value),
      [10, null],
      "100 / 20 * 2 = 10; then 30 / 0 clicks = null"
    );

    const summary = await sam.call(
      "GET",
      `/metrics/summary?range=24h&team_id=${team.id}`
    );
    assert.ok(summary.body.data.custom.some((c) => c.id === metric.id));
  });

  test("a bad formula is refused with the reason and position", async () => {
    const sam = await signIn("super");
    const res = await sam.call("POST", "/custom-metrics", {
      team_id: team.id,
      name: "broken",
      formula: "revenue / (users",
    });
    assert.equal(res.status, 400);
    assert.match(res.body.errors[0].message, /Missing "\)"/);
    const preview = await sam.call(
      "GET",
      `/metrics/formula?formula=${encodeURIComponent("revenue; DROP TABLE users")}&${window(3, 5)}&team_id=${team.id}`
    );
    assert.equal(preview.status, 400);
    assert.equal(preview.body.errors[0].field, "formula");
  });

  test("Viewers can't define metrics; other teams can't read them", async () => {
    const carol = await signIn("carol");
    assert.equal(
      (
        await carol.call("POST", "/custom-metrics", {
          name: "x",
          formula: "clicks",
        })
      ).status,
      403
    );
    const {
      rows: [financeMetric],
    } = await owner.query(
      "SELECT id FROM custom_metrics WHERE team_id = $1 LIMIT 1",
      [finance]
    );
    const dave = await signIn("dave");
    assert.equal(
      (
        await dave.call(
          "GET",
          `/metrics/custom?id=${financeMetric.id}&${window(3, 5)}`
        )
      ).status,
      404
    );
  });

  test("a custom metric is a widget source and can't be deleted while used", async () => {
    const sam = await signIn("super");
    const dash = await sam.call("POST", "/dashboards", {
      name: "t3-test-custom",
      project_id: p1.id,
    });
    const add = (body) =>
      sam.call("POST", `/dashboards/${dash.body.data.id}/widgets`, {
        type: "stat",
        x: 0,
        y: 0,
        w: 3,
        h: 2,
        ...body,
      });
    const widget = await add({
      custom_metric_id: metric.id,
      title: "Per click",
    });
    assert.equal(widget.status, 201);
    assert.equal(widget.body.data.custom_metric_id, metric.id);
    assert.equal(
      (await add({ custom_metric_id: metric.id, metric: "clicks" })).status,
      400,
      "exactly one source"
    );
    const {
      rows: [financeMetric],
    } = await owner.query(
      "SELECT id FROM custom_metrics WHERE team_id = $1 LIMIT 1",
      [finance]
    );
    assert.equal(
      (await add({ custom_metric_id: financeMetric.id })).status,
      400,
      "a widget can't use another team's metric"
    );

    const blocked = await sam.call("DELETE", `/custom-metrics/${metric.id}`);
    assert.equal(blocked.status, 409);
    assert.match(blocked.body.message, /Per click/);
    await sam.call("DELETE", `/widgets/${widget.body.data.id}`);
    assert.equal(
      (await sam.call("DELETE", `/custom-metrics/${metric.id}`)).status,
      200
    );
  });
});

describe("webhooks (Tier 3 C)", () => {
  let sam;
  const hookRequests = (id) =>
    received.filter(
      (r) => r.body.includes(id) || r.headers["webhook-id"] === id
    );
  // Prompt 50: every failed attempt, give-up, disable and recovery is in the audit log.
  const auditFor = async (hookId) =>
    (
      await owner.query(
        "SELECT action, result, actor_name, team_id, meta FROM audit_log WHERE target_id = $1 ORDER BY seq",
        [hookId]
      )
    ).rows;
  const deliveries = async (hookId) =>
    (await sam.call("GET", `/webhooks/${hookId}/deliveries`)).body.data;
  const createHook = async (path, events) => {
    const res = await sam.call("POST", "/webhooks", {
      team_id: team.id,
      url: `${hookBase}${path}`,
      events,
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    return res.body.data;
  };
  const verifies = (secret, headers, body) =>
    headers["webhook-signature"].split(" ").includes(
      `v1,${createHmac("sha256", Buffer.from(secret.slice(6), "base64"))
        .update(
          `${headers["webhook-id"]}.${headers["webhook-timestamp"]}.${body}`
        )
        .digest("base64")}`
    );

  before(async () => {
    sam = await signIn("super");
  });

  test("a change is delivered once, signed per the Standard Webhooks spec", async () => {
    const hook = await createHook("/ok", ["dashboard.created"]);
    assert.match(hook.secret, /^whsec_/);
    const listed = (await sam.call("GET", `/webhooks?team_id=${team.id}`)).body
      .data;
    assert.ok(
      listed.every((h) => !("secret" in h)),
      "the secret is never listed"
    );

    const dash = await sam.call("POST", "/dashboards", {
      name: "t3-test-hooked",
      project_id: p2.id,
    });
    const request = await waitFor(
      () => received.find((r) => r.body.includes(dash.body.data.id)),
      "the dashboard.created delivery"
    );
    const body = JSON.parse(request.body);
    assert.equal(body.type, "dashboard.created");
    assert.equal(body.data.dashboard.project_id, p2.id);
    assert.match(request.headers["webhook-id"], /^[0-9a-f-]{36}$/);
    assert.ok(
      Math.abs(
        Date.now() / 1000 - Number(request.headers["webhook-timestamp"])
      ) < 60
    );
    assert.ok(
      verifies(hook.secret, request.headers, request.body),
      "signature verifies"
    );

    const [delivery] = await waitFor(async () => {
      const rows = await deliveries(hook.id);
      return rows[0]?.status === "delivered" && rows;
    }, "the delivered status");
    assert.equal(delivery.attempt, 1);
    assert.equal(delivery.response_code, 200);
  });

  test("only committed changes are queued (outbox)", async () => {
    const hook = await createHook("/ok", ["dashboard.deleted"]);
    const {
      rows: [user],
    } = await owner.query(
      "SELECT id FROM users WHERE email = 'super@acme.test'"
    );
    await assert.rejects(
      withContext({ userId: user.id, orgId: org.id }, async (db) => {
        await db.query(
          "SELECT app.emit_webhook_event($1, NULL, 'dashboard.deleted', '{}')",
          [team.id]
        );
        throw new Error("roll back");
      }),
      /roll back/
    );
    assert.equal((await deliveries(hook.id)).length, 0);
  });

  test("a redirect is a failure, never followed, and the retry backs off", async () => {
    const hook = await createHook("/redirect", ["dashboard.created"]);
    await sam.call("POST", `/webhooks/${hook.id}/test`);
    const [delivery] = await waitFor(async () => {
      const rows = await deliveries(hook.id);
      return rows[0]?.attempt >= 1 && rows[0].status === "pending" && rows;
    }, "a failed first attempt");
    assert.equal(delivery.response_code, 302);
    const wait = (new Date(delivery.next_attempt_at) - Date.now()) / 1000;
    assert.ok(wait > 2 && wait < 7, `next attempt in about 5 s (was ${wait})`);
    assert.ok(
      !received.some(
        (r) =>
          r.path !== "/redirect" &&
          r.headers["webhook-id"] === delivery.event_id
      ),
      "the Location was not followed"
    );

    const [failed] = (await auditFor(hook.id)).filter(
      (a) => a.action === "webhook.delivery_failed"
    );
    assert.ok(failed, "the failed attempt is audited");
    assert.equal(failed.result, "failed");
    assert.equal(failed.actor_name, "Webhook worker");
    assert.equal(failed.team_id, team.id, "the team's Admins can see it");
    assert.equal(failed.meta.attempt, 1);
    assert.equal(failed.meta.response_code, 302);
    assert.equal(failed.meta.host, new URL(hookBase).host);
    assert.ok(failed.meta.next_attempt_at, "says when it will retry");
    assert.ok(
      !JSON.stringify(failed.meta).includes("/redirect"),
      "only the host is logged, never the path (it may hold a token)"
    );
  });

  test("410 Gone disables the endpoint", async () => {
    const hook = await createHook("/gone", ["dashboard.created"]);
    await sam.call("POST", `/webhooks/${hook.id}/test`);
    const disabled = await waitFor(
      async () =>
        (await sam.call("GET", `/webhooks?team_id=${team.id}`)).body.data.find(
          (h) => h.id === hook.id && !h.enabled
        ),
      "the endpoint to be disabled"
    );
    assert.match(disabled.disabled_reason, /410/);
    const actions = (await auditFor(hook.id)).map((a) => a.action);
    assert.ok(actions.includes("webhook.delivery_abandoned"), "the give-up");
    assert.ok(actions.includes("webhook.endpoint_disabled"), "the disable");
  });

  test("a delivery that succeeds after failing is audited as recovered", async () => {
    flakyCalls = 0;
    const hook = await createHook("/flaky", ["dashboard.created"]);
    await sam.call("POST", `/webhooks/${hook.id}/test`);
    await waitFor(async () => {
      const [row] = await deliveries(hook.id);
      return row?.status === "pending" && row.attempt === 1;
    }, "the first, failed attempt");
    // Skip the 5 s back-off instead of sleeping through it.
    await owner.query(
      "UPDATE webhook_deliveries SET next_attempt_at = now() WHERE webhook_id = $1",
      [hook.id]
    );
    await waitFor(
      async () => (await deliveries(hook.id))[0]?.status === "delivered",
      "the retry to succeed"
    );
    assert.deepEqual(
      (await auditFor(hook.id))
        .map((a) => a.action)
        .filter((a) => a.startsWith("webhook.delivery")),
      ["webhook.delivery_failed", "webhook.delivery_recovered"]
    );
  });

  test("secrets are encrypted at rest and bound to their own webhook", async () => {
    const a = await createHook("/ok", ["dashboard.created"]);
    const b = await createHook("/ok", ["dashboard.created"]);
    const stored = async (id) =>
      (await owner.query("SELECT secret FROM webhooks WHERE id = $1", [id]))
        .rows[0].secret;
    const sealed = await stored(a.id);
    assert.match(sealed, /^v1:[\w-]+:/, "sealed format with its key id");
    assert.ok(
      !sealed.includes(a.secret.slice(6)),
      "no plain secret in the row"
    );

    // A ciphertext copied onto another webhook must not sign for it.
    await owner.query("UPDATE webhooks SET secret = $2 WHERE id = $1", [
      b.id,
      sealed,
    ]);
    const queued = await sam.call("POST", `/webhooks/${b.id}/test`);
    const [row] = await waitFor(async () => {
      const rows = await deliveries(b.id);
      return rows[0]?.attempt >= 1 && rows;
    }, "the attempt with the swapped secret");
    assert.match(row.last_error, /Signing secret unavailable/);
    assert.equal(
      hookRequests(queued.body.data.event_id).length,
      0,
      "nothing was sent"
    );
  });

  test("the address check runs when connecting, not just when saving", async () => {
    delete process.env.WEBHOOK_ALLOW_PRIVATE;
    try {
      // "localhost" passes the URL check (it isn't an IP literal) but resolves to loopback.
      const result = await send({
        url: `http://localhost:${receiver.address().port}/ok`,
        event_id: "00000000-0000-4000-8000-000000000000",
        body: "{}",
        secret: newSecret(), // any key: the request is refused before signing matters
      });
      assert.equal(result.ok, false);
      assert.match(result.error, /not allowed/);
    } finally {
      process.env.WEBHOOK_ALLOW_PRIVATE = "1";
    }
  });

  test("alerts are queued by the database itself", async () => {
    const hook = await createHook("/ok", ["alert.opened"]);
    await owner.query(
      `INSERT INTO alerts (org_id, team_id, project_id, metric, direction, value, mean, stddev, z, peak_z)
       VALUES ($1, $2, $3, 'errors', 'above', 40, 10, 2, 15, 15)`,
      [org.id, team.id, p1.id]
    );
    const [delivery] = await deliveries(hook.id);
    assert.equal(delivery.event, "alert.opened");
    assert.equal(JSON.parse(delivery.body).data.project, "General");
  });

  test("webhooks are admin-only and team-scoped; secrets are unreadable", async () => {
    const hook = await createHook("/ok", ["member.added"]);
    const bob = await signIn("bob");
    assert.equal((await bob.call("GET", "/webhooks")).status, 403);
    const dave = await signIn("dave");
    assert.equal(
      (await dave.call("PATCH", `/webhooks/${hook.id}`, { enabled: false }))
        .status,
      404
    );
    assert.deepEqual(
      (await dave.call("GET", `/webhooks/${hook.id}/deliveries`)).body.data,
      []
    );
    const {
      rows: [user],
    } = await owner.query(
      "SELECT id FROM users WHERE email = 'super@acme.test'"
    );
    await assert.rejects(
      withContext({ userId: user.id, orgId: org.id }, (db) =>
        db.query("SELECT secret FROM webhooks")
      ),
      { code: "42501" }
    );
  });

  test("after a rotation, messages carry both signatures", async () => {
    const hook = await createHook("/ok", ["dashboard.created"]);
    const rotated = await sam.call(
      "POST",
      `/webhooks/${hook.id}/rotate-secret`
    );
    assert.equal(rotated.status, 200);
    const queued = await sam.call("POST", `/webhooks/${hook.id}/test`);
    const request = await waitFor(
      () => hookRequests(queued.body.data.event_id)[0],
      "the test delivery"
    );
    assert.equal(request.headers["webhook-signature"].split(" ").length, 2);
    assert.ok(
      verifies(hook.secret, request.headers, request.body),
      "old secret"
    );
    assert.ok(
      verifies(rotated.body.data.secret, request.headers, request.body),
      "new secret"
    );
  });
});

describe("socket cookie parsing (problems-log #35)", () => {
  test("the session cookie authenticates even when another cookie comes first", async () => {
    const bob = await signIn("bob");
    const socket = connect(base, {
      transports: ["websocket"],
      extraHeaders: { cookie: `theme=dark; ${bob.cookie()}`, origin: ORIGIN },
      reconnection: false,
    });
    sockets.push(socket);
    const outcome = await Promise.race([
      once(socket, "connect").then(() => "connected"),
      once(socket, "connect_error").then(([err]) => err.message),
    ]);
    assert.equal(outcome, "connected");
  });
});
