// End-to-end API checks over real HTTP against a real (seeded) database. Requires
// `npm run migrate && npm run seed`. Everything created here is prefixed "apitest-" and removed.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import pg from "pg";

process.env.AUTH_RATE_LIMIT = "1000"; // the suite signs in far more than 10 times
const { app } = await import("../src/app.js");
const { pool } = await import("../src/db/pool.js");

const PASSWORD = process.env.SEED_PASSWORD || "Password@123";
const run = Date.now().toString(36);
const owner = new pg.Client({
  connectionString: process.env.MIGRATION_DATABASE_URL,
});
let server, base;
const ids = {};

before(async () => {
  server = app.listen(0);
  base = `http://127.0.0.1:${server.address().port}/api/v1`;
  await owner.connect();
  const { rows } = await owner.query("SELECT id, name FROM teams");
  for (const team of rows) ids[team.name] = team.id;
});

after(async () => {
  await owner.query("DELETE FROM dashboards WHERE name LIKE 'apitest-%'");
  await owner.query("DELETE FROM users WHERE email LIKE 'apitest-%'");
  await owner.query("DELETE FROM organizations WHERE slug LIKE 'apitest-%'");
  await owner.end();
  await pool.end();
  server.close();
});

// A tiny cookie-keeping client, like a browser tab.
const client = () => {
  const c = { cookie: "" };
  c.call = async (
    method,
    path,
    body,
    headers = { "X-Requested-With": "fetch" }
  ) => {
    const res = await fetch(base + path, {
      method,
      headers: {
        "content-type": "application/json",
        cookie: c.cookie,
        ...headers,
      },
      body: body && JSON.stringify(body),
    });
    const set = res.headers.getSetCookie()[0]?.split(";")[0];
    if (set !== undefined) c.cookie = set.endsWith("=") ? "" : set;
    return { status: res.status, body: await res.json() };
  };
  return c;
};

const signIn = async (
  user,
  team,
  { org = "acme", password = PASSWORD } = {}
) => {
  const c = client();
  const res = await c.call("POST", "/auth/login", {
    org,
    email: `${user}@acme.test`,
    password,
  });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  if (team !== undefined && !res.body.data.active_membership_id) {
    const membership = res.body.data.memberships.find(
      (m) => m.team_name === team
    );
    assert.equal(
      (await c.call("POST", "/auth/context", { membership_id: membership.id }))
        .status,
      200
    );
  }
  return c;
};

describe("authentication", () => {
  test("every login failure looks identical", async () => {
    const attempts = [
      { org: "acme", email: "bob@acme.test", password: "wrong-password" },
      { org: "acme", email: "nobody@acme.test", password: PASSWORD },
      { org: "no-such-org", email: "bob@acme.test", password: PASSWORD },
    ];
    const bodies = [];
    for (const attempt of attempts) {
      const res = await client().call("POST", "/auth/login", attempt);
      assert.equal(res.status, 401);
      bodies.push(res.body);
    }
    assert.deepEqual(bodies[1], bodies[0]);
    assert.deepEqual(bodies[2], bodies[0]);
  });

  test("a single membership is selected automatically", async () => {
    const bob = await signIn("bob");
    const me = await bob.call("GET", "/auth/me");
    assert.equal(me.body.data.active_membership.role, "editor");
    assert.equal(me.body.data.user.email, "bob@acme.test");
  });

  test("several memberships require a choice, and choosing rotates the session", async () => {
    const alice = client();
    const login = await alice.call("POST", "/auth/login", {
      org: "acme",
      email: "alice@acme.test",
      password: PASSWORD,
    });
    assert.equal(login.body.data.active_membership_id, null);
    assert.deepEqual(
      login.body.data.memberships.map((m) => m.team_name).sort(),
      ["Finance", "Marketing"]
    );
    assert.equal((await alice.call("GET", "/dashboards")).status, 403);

    const before = alice.cookie;
    const finance = login.body.data.memberships.find(
      (m) => m.team_name === "Finance"
    );
    assert.equal(
      (await alice.call("POST", "/auth/context", { membership_id: finance.id }))
        .status,
      200
    );
    assert.notEqual(alice.cookie, before);

    const stale = client();
    stale.cookie = before;
    assert.equal(
      (await stale.call("GET", "/auth/me")).status,
      401,
      "old session id must be dead"
    );
  });

  test("a membership of another user cannot be selected", async () => {
    const dave = await signIn("dave");
    const { body } = await (await signIn("bob")).call("GET", "/auth/me");
    const res = await dave.call("POST", "/auth/context", {
      membership_id: body.data.active_membership.id,
    });
    assert.equal(res.status, 404);
  });

  test("logout invalidates the session server-side", async () => {
    const bob = await signIn("bob");
    const stolen = bob.cookie;
    assert.equal((await bob.call("POST", "/auth/logout")).status, 200);
    const thief = client();
    thief.cookie = stolen;
    assert.equal((await thief.call("GET", "/auth/me")).status, 401);
  });

  test("writes without the CSRF header are refused", async () => {
    const bob = await signIn("bob");
    const res = await bob.call(
      "POST",
      "/dashboards",
      { name: "apitest-csrf" },
      {}
    );
    assert.equal(res.status, 403);
  });

  test("sign-up creates an org with a super admin; a taken slug is a conflict", async () => {
    const slug = `apitest-${run}`;
    const owner = client();
    const body = {
      org_name: "Test Org",
      slug,
      name: "Owner",
      email: "apitest-owner@test.dev",
      password: "a-long-password-123",
    };
    const res = await owner.call("POST", "/auth/signup", body);
    assert.equal(res.status, 201);
    const me = await owner.call("GET", "/auth/me");
    assert.equal(me.body.data.active_membership.role, "super_admin");
    assert.equal(
      (await client().call("POST", "/auth/signup", body)).status,
      409
    );
  });

  test("10 failed logins lock the account even for the right password", async () => {
    const slug = `apitest-lock-${run}`;
    const credentials = {
      email: "apitest-lock@test.dev",
      password: "a-long-password-123",
    };
    await client().call("POST", "/auth/signup", {
      org_name: "Lock Org",
      slug,
      name: "Lock",
      ...credentials,
    });
    for (let i = 0; i < 10; i++) {
      await client().call("POST", "/auth/login", {
        org: slug,
        email: credentials.email,
        password: "wrong-password",
      });
    }
    const res = await client().call("POST", "/auth/login", {
      org: slug,
      ...credentials,
    });
    assert.equal(res.status, 401);
  });
});

describe("dashboards", () => {
  test("viewer reads but cannot write", async () => {
    const carol = await signIn("carol");
    assert.equal((await carol.call("GET", "/dashboards")).status, 200);
    assert.equal(
      (await carol.call("POST", "/dashboards", { name: "apitest-viewer" }))
        .status,
      403
    );
  });

  test("editor creates and edits but cannot delete; admin can", async () => {
    const bob = await signIn("bob");
    const created = await bob.call("POST", "/dashboards", {
      name: "apitest-editor",
    });
    assert.equal(created.status, 201);
    const { id, version } = created.body.data;
    assert.equal(
      (
        await bob.call("PATCH", `/dashboards/${id}`, {
          name: "apitest-renamed",
          version,
        })
      ).status,
      200
    );
    assert.equal((await bob.call("DELETE", `/dashboards/${id}`)).status, 403);

    const alice = await signIn("alice", "Finance");
    assert.equal((await alice.call("DELETE", `/dashboards/${id}`)).status, 200);
  });

  test("another team's dashboard is a 404, never a 403", async () => {
    const dave = await signIn("dave");
    const { body } = await dave.call("GET", "/dashboards");
    const bob = await signIn("bob");
    for (const dashboard of body.data) {
      assert.equal(
        (await bob.call("GET", `/dashboards/${dashboard.id}`)).status,
        404
      );
      assert.equal(
        (
          await bob.call("POST", `/dashboards/${dashboard.id}/widgets`, {
            type: "stat",
            metric: "clicks",
            x: 0,
            y: 0,
            w: 2,
            h: 2,
          })
        ).status,
        404
      );
    }
  });

  test("a stale version is a 409 conflict instead of a silent overwrite", async () => {
    const bob = await signIn("bob");
    const { body } = await bob.call("POST", "/dashboards", {
      name: "apitest-conflict",
    });
    const { id, version } = body.data;
    assert.equal(
      (
        await bob.call("PATCH", `/dashboards/${id}`, {
          name: "apitest-first",
          version,
        })
      ).status,
      200
    );
    assert.equal(
      (
        await bob.call("PATCH", `/dashboards/${id}`, {
          name: "apitest-second",
          version,
        })
      ).status,
      409
    );
  });

  test("widgets: add, update with version, bulk layout, delete", async () => {
    const bob = await signIn("bob");
    const { body } = await bob.call("POST", "/dashboards", {
      name: "apitest-widgets",
    });
    const dashboardId = body.data.id;
    const add = (x) =>
      bob.call("POST", `/dashboards/${dashboardId}/widgets`, {
        type: "line",
        metric: "revenue",
        x,
        y: 0,
        w: 4,
        h: 3,
      });
    const [a, b] = [(await add(0)).body.data, (await add(4)).body.data];

    const updated = await bob.call("PATCH", `/widgets/${a.id}`, {
      title: "Revenue",
      version: a.version,
    });
    assert.equal(updated.body.data.title, "Revenue");

    const layout = await bob.call("PUT", `/dashboards/${dashboardId}/layout`, {
      items: [
        { id: a.id, x: 4, y: 0, w: 4, h: 3 },
        { id: b.id, x: 0, y: 0, w: 4, h: 3 },
      ],
    });
    assert.equal(layout.status, 200);
    const full = await bob.call("GET", `/dashboards/${dashboardId}`);
    assert.deepEqual(
      full.body.data.widgets.map((w) => [w.id, w.x]),
      [
        [b.id, 0],
        [a.id, 4],
      ]
    );

    assert.equal((await bob.call("DELETE", `/widgets/${b.id}`)).status, 200);
  });

  test("unknown fields are rejected (no mass assignment)", async () => {
    const bob = await signIn("bob");
    const res = await bob.call("POST", "/dashboards", {
      name: "apitest-mass",
      org_id: ids.Marketing,
    });
    assert.equal(res.status, 400);
  });

  test("a team session always writes to its own team, whatever team_id says", async () => {
    const bob = await signIn("bob");
    const res = await bob.call("POST", "/dashboards", {
      name: "apitest-cross",
      team_id: ids.Marketing,
    });
    assert.equal(res.status, 201);
    assert.equal(res.body.data.team_id, ids.Finance);
  });
});

describe("metrics", () => {
  const range = () => ({
    from: new Date(Date.now() - 24 * 3600e3).toISOString(),
    to: new Date().toISOString(),
  });

  test("series returns hourly buckets for the session's team only", async () => {
    const bob = await signIn("bob");
    const { from, to } = range();
    const res = await bob.call(
      "GET",
      `/metrics/series?metric=revenue&from=${from}&to=${to}&bucket=1h`
    );
    assert.equal(res.status, 200);
    assert.ok(res.body.data.points.length >= 24);

    const leak = await bob.call(
      "GET",
      `/metrics/series?metric=revenue&from=${from}&to=${to}&team_id=${ids.Marketing}`
    );
    assert.equal(leak.body.data.points.length, 0);
  });

  test("oversized ranges are rejected", async () => {
    const bob = await signIn("bob");
    const res = await bob.call(
      "GET",
      `/metrics/series?metric=clicks&from=2020-01-01&to=2026-01-01`
    );
    assert.equal(res.status, 400);
  });

  test("summary has current and previous totals for all five metrics", async () => {
    const res = await (
      await signIn("bob")
    ).call("GET", "/metrics/summary?range=24h");
    assert.deepEqual(res.body.data.metrics.map((m) => m.metric).sort(), [
      "clicks",
      "errors",
      "page_views",
      "revenue",
      "users",
    ]);
  });
});

describe("teams and members (IAM-style accounts)", () => {
  const email = (tag) => `apitest-${tag}-${run}@acme.test`;

  test("an admin creates a user who must change the one-time password first", async () => {
    const alice = await signIn("alice", "Finance");
    const created = await alice.call("POST", `/teams/${ids.Finance}/members`, {
      email: email("new"),
      name: "New",
      role: "viewer",
    });
    assert.equal(created.status, 201);
    const { one_time_password } = created.body.data;
    assert.equal(one_time_password.length, 20);

    const user = client();
    const login = await user.call("POST", "/auth/login", {
      org: "acme",
      email: email("new"),
      password: one_time_password,
    });
    assert.equal(login.body.data.must_change_password, true);
    assert.equal((await user.call("GET", "/dashboards")).status, 403);

    const change = await user.call("POST", "/auth/password", {
      current_password: one_time_password,
      new_password: "my-own-password-1",
    });
    assert.equal(change.status, 200);
    const again = await user.call("POST", "/auth/login", {
      org: "acme",
      email: email("new"),
      password: "my-own-password-1",
    });
    assert.equal(again.body.data.active_membership_id !== null, true);
    assert.equal((await user.call("GET", "/dashboards")).status, 200);
  });

  test("adding an existing org account only adds the membership (no password)", async () => {
    const sam = await signIn("super", null);
    await sam.call("POST", `/teams/${ids.Finance}/members`, {
      email: email("both"),
      name: "Both",
      role: "viewer",
    });
    const second = await sam.call("POST", `/teams/${ids.Marketing}/members`, {
      email: email("both"),
      name: "Both",
      role: "viewer",
    });
    assert.equal(second.status, 201);
    assert.equal(second.body.data.account_created, false);
    assert.equal(second.body.data.one_time_password, undefined);
  });

  test("a team admin cannot add members to another team", async () => {
    const alice = await signIn("alice", "Finance");
    const res = await alice.call("POST", `/teams/${ids.Marketing}/members`, {
      email: email("x"),
      name: "X",
      role: "viewer",
    });
    assert.equal(res.status, 403);
  });

  test("password reset escalation guard", async () => {
    const sam = await signIn("super", null);
    const only = (
      await sam.call("POST", `/teams/${ids.Finance}/members`, {
        email: email("only"),
        name: "Only",
        role: "viewer",
      })
    ).body.data;
    await sam.call("POST", `/teams/${ids.Finance}/members`, {
      email: email("dual"),
      name: "Dual",
      role: "viewer",
    });
    const dual = (
      await sam.call("POST", `/teams/${ids.Marketing}/members`, {
        email: email("dual"),
        name: "Dual",
        role: "admin",
      })
    ).body.data;

    const alice = await signIn("alice", "Finance");
    assert.equal(
      (await alice.call("POST", `/users/${only.user_id}/reset-password`))
        .status,
      200
    );
    assert.equal(
      (await alice.call("POST", `/users/${dual.user_id}/reset-password`))
        .status,
      404,
      "dual is also a Marketing admin"
    );
    assert.equal(
      (await sam.call("POST", `/users/${dual.user_id}/reset-password`)).status,
      200
    );
  });

  test("only the super admin manages teams; a team keeps its last admin", async () => {
    const alice = await signIn("alice", "Finance");
    assert.equal(
      (await alice.call("POST", "/teams", { name: "apitest-team" })).status,
      403
    );

    const sam = await signIn("super", null);
    const team = (
      await sam.call("POST", "/teams", { name: `apitest-team-${run}` })
    ).body.data;
    const admin = (
      await sam.call("POST", `/teams/${team.id}/members`, {
        email: email("lead"),
        name: "Lead",
        role: "admin",
      })
    ).body.data;
    assert.equal(
      (
        await sam.call("PATCH", `/memberships/${admin.membership_id}`, {
          role: "viewer",
        })
      ).status,
      409
    );
    assert.equal(
      (await sam.call("DELETE", `/memberships/${admin.membership_id}`)).status,
      409
    );
    assert.equal((await sam.call("DELETE", `/teams/${team.id}`)).status, 200);
  });
});
