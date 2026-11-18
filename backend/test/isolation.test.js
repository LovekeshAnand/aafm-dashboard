// Proves Tier 1 "Database isolation enforced (RLS)". Requires `npm run migrate && npm run seed`.
// Every assertion runs through the restricted app role, the same path the API uses.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import pg from "pg";
import { pool, withContext } from "../src/db/pool.js";

const owner = new pg.Client({
  connectionString: process.env.MIGRATION_DATABASE_URL,
});
const ids = { user: {}, team: {}, project: {} };
const RLS_VIOLATION = "42501";

before(async () => {
  await owner.connect();
  const { rows: users } = await owner.query("SELECT id, email FROM users");
  const { rows: teams } = await owner.query(
    "SELECT id, org_id, name FROM teams"
  );
  for (const user of users) ids.user[user.email.split("@")[0]] = user.id;
  for (const team of teams) ids.team[team.name] = team.id;
  // Tier 3 A: a dashboard needs a project of its team (the first one is enough here).
  const { rows: projects } = await owner.query(
    "SELECT DISTINCT ON (team_id) id, team_id FROM projects ORDER BY team_id, created_at"
  );
  for (const team of teams)
    ids.project[team.name] = projects.find((p) => p.team_id === team.id)?.id;
  ids.org = teams[0]?.org_id;
  assert.ok(
    ids.org && ids.team.Finance && ids.team.Marketing,
    "seed data missing: run npm run seed"
  );
});

after(async () => {
  await owner.query("DELETE FROM dashboards WHERE name LIKE 'rls-test-%'");
  await owner.end();
  await pool.end();
});

const as = (user, team) => (work) =>
  withContext(
    { userId: ids.user[user], orgId: ids.org, teamId: team && ids.team[team] },
    work
  );

const count = async (client, table, where = "true", params = []) =>
  Number(
    (await client.query(`SELECT count(*) FROM ${table} WHERE ${where}`, params))
      .rows[0].count
  );

describe("team isolation", () => {
  test("a Finance member sees only Finance rows on every tenant table", () =>
    as(
      "bob",
      "Finance"
    )(async (client) => {
      for (const table of [
        "dashboards",
        "widgets",
        "metric_points",
        "memberships",
      ]) {
        assert.ok(
          (await count(client, table)) > 0,
          `${table}: Finance rows should be visible`
        );
        assert.equal(
          await count(client, table, "team_id <> $1", [ids.team.Finance]),
          0,
          table
        );
      }
      const { rows } = await client.query("SELECT name FROM teams");
      assert.deepEqual(
        rows.map((row) => row.name),
        ["Finance"]
      );
    }));

  test("asking for Marketing rows by id returns nothing to a Finance member", () =>
    as(
      "bob",
      "Finance"
    )(async (client) => {
      assert.equal(
        await count(client, "metric_points", "team_id = $1", [
          ids.team.Marketing,
        ]),
        0
      );
      assert.equal(
        await count(client, "dashboards", "team_id = $1", [ids.team.Marketing]),
        0
      );
    }));

  test("a user with two memberships only sees the team selected for the session", () =>
    as(
      "alice",
      "Marketing"
    )(async (client) => {
      assert.equal(
        await count(client, "dashboards", "team_id = $1", [ids.team.Finance]),
        0
      );
      assert.ok(
        (await count(client, "dashboards", "team_id = $1", [
          ids.team.Marketing,
        ])) > 0
      );
    }));

  test("a forged context (team the user does not belong to) sees nothing", () =>
    as(
      "carol",
      "Finance"
    )(async (client) => {
      for (const table of [
        "organizations",
        "teams",
        "dashboards",
        "widgets",
        "metric_points",
      ]) {
        assert.equal(await count(client, table), 0, table);
      }
    }));

  test("no context at all sees nothing", async () => {
    for (const table of [
      "organizations",
      "teams",
      "users",
      "dashboards",
      "widgets",
      "metric_points",
    ]) {
      const { rows } = await pool.query(`SELECT count(*) FROM ${table}`);
      assert.equal(Number(rows[0].count), 0, table);
    }
  });

  test("the super admin sees every team in the org", () =>
    as(
      "super",
      null
    )(async (client) => {
      const { rows } = await client.query(
        "SELECT DISTINCT team_id FROM metric_points"
      );
      // Includes both seeded teams. Not "exactly 2": the Tier 2/3 suites run in parallel and
      // add throwaway teams of the same org while they run (problems-log #41).
      const seen = rows.map((r) => r.team_id);
      assert.ok(
        seen.includes(ids.team.Finance) && seen.includes(ids.team.Marketing)
      );
    }));
});

describe("role permissions", () => {
  const insertDashboard = (client, team, name) =>
    client.query(
      "INSERT INTO dashboards (org_id, team_id, project_id, name) VALUES ($1, $2, $3, $4) RETURNING id",
      [ids.org, ids.team[team], ids.project[team], name]
    );

  test("a viewer cannot create a dashboard", () =>
    assert.rejects(
      as(
        "carol",
        "Marketing"
      )((client) => insertDashboard(client, "Marketing", "rls-test-viewer")),
      { code: RLS_VIOLATION }
    ));

  test("a viewer cannot edit a dashboard (0 rows updated)", () =>
    as(
      "carol",
      "Marketing"
    )(async (client) => {
      const { rowCount } = await client.query(
        "UPDATE dashboards SET name = 'hacked'"
      );
      assert.equal(rowCount, 0);
    }));

  test("an editor can create in their team but not in another team", async () => {
    await as(
      "bob",
      "Finance"
    )((client) => insertDashboard(client, "Finance", "rls-test-editor"));
    await assert.rejects(
      as(
        "bob",
        "Finance"
      )((client) => insertDashboard(client, "Marketing", "rls-test-cross")),
      { code: RLS_VIOLATION }
    );
  });

  test("an editor cannot delete a dashboard, an admin can", async () => {
    const {
      rows: [created],
    } = await as(
      "bob",
      "Finance"
    )((client) => insertDashboard(client, "Finance", "rls-test-delete"));
    const deleteIt = (client) =>
      client.query("DELETE FROM dashboards WHERE id = $1", [created.id]);
    assert.equal((await as("bob", "Finance")(deleteIt)).rowCount, 0);
    assert.equal((await as("alice", "Finance")(deleteIt)).rowCount, 1);
  });

  test("the app role cannot write metric data", () =>
    assert.rejects(
      as(
        "alice",
        "Finance"
      )((client) =>
        client.query(
          "INSERT INTO metric_points (org_id, team_id, metric, ts, value) VALUES ($1, $2, 'revenue', now(), 1)",
          [ids.org, ids.team.Finance]
        )
      ),
      { code: RLS_VIOLATION } // insufficient_privilege shares SQLSTATE 42501
    ));
});

describe("connection pooling", () => {
  test("tenant context does not leak to the next user of the same connection", async () => {
    const firstPid = await as(
      "bob",
      "Finance"
    )(async (client) => {
      const { rows } = await client.query("SELECT pg_backend_pid() AS pid");
      return rows[0].pid;
    });

    const client = await pool.connect(); // the idle connection just released is reused
    try {
      const {
        rows: [state],
      } = await client.query(
        "SELECT pg_backend_pid() AS pid, current_setting('app.team_id', true) AS team"
      );
      assert.equal(state.pid, firstPid, "expected the same pooled connection");
      assert.ok(
        !state.team,
        "team context must be cleared after the transaction"
      );
      assert.equal(await count(client, "metric_points"), 0);
    } finally {
      client.release();
    }
  });
});
