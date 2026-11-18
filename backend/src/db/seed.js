import pg from "pg";
import { hashPassword } from "../utils/password.js";

// Development data only. Runs as the owner (MIGRATION_DATABASE_URL), which must be a
// superuser or have BYPASSRLS, because the tenant tables FORCE row-level security.
const SEED_PASSWORD = process.env.SEED_PASSWORD || "Password@123";

const USERS = [
  { email: "super@acme.test", name: "Sam Super" },
  { email: "alice@acme.test", name: "Alice Admin" },
  { email: "bob@acme.test", name: "Bob Editor" },
  { email: "carol@acme.test", name: "Carol Viewer" },
  { email: "dave@acme.test", name: "Dave Admin" },
];

// [email, team name | null (org-wide), role]. Alice shows one user holding two roles.
const MEMBERSHIPS = [
  ["super@acme.test", null, "super_admin"],
  ["alice@acme.test", "Finance", "admin"],
  ["alice@acme.test", "Marketing", "viewer"],
  ["bob@acme.test", "Finance", "editor"],
  ["carol@acme.test", "Marketing", "viewer"],
  ["dave@acme.test", "Marketing", "admin"],
];

// Tier 3 A: each team's projects (the first one renames the automatic "General" project).
const PROJECTS = {
  Finance: ["Web App", "Mobile App"],
  Marketing: ["Campaigns", "Website"],
};

// 7 days at 5-minute resolution per project: base x daily cycle x +/-15% noise, scaled per
// project with app.team_scale() so the live simulator (migration 006) continues the same curve.
const SEED_METRICS_SQL = `
  INSERT INTO metric_points (org_id, team_id, project_id, metric, ts, value)
  SELECT p.org_id, p.team_id, p.id, m.metric, ts,
         round((m.base * p.scale
                * (1 + 0.3 * sin(2 * pi() * extract(hour FROM ts) / 24))
                * (0.85 + random() * 0.3))::numeric, 2)
  FROM (SELECT id, org_id, team_id, app.team_scale(id) AS scale
        FROM projects WHERE org_id = $1) p
  CROSS JOIN (VALUES ('revenue'::metric_name, 500.0), ('page_views', 1200.0),
                     ('clicks', 300.0), ('errors', 5.0), ('users', 120.0)) m(metric, base)
  CROSS JOIN generate_series(date_trunc('minute', now()) - interval '7 days',
                             date_trunc('minute', now()), interval '5 minutes') ts`;

const seed = async () => {
  if (process.env.NODE_ENV === "production")
    throw new Error("refusing to seed in production");

  const client = new pg.Client({
    connectionString: process.env.MIGRATION_DATABASE_URL,
  });
  await client.connect();
  try {
    await client.query("BEGIN");
    // audit_log has no FK to organizations (it outlives deletions), so it is cleared explicitly;
    // TRUNCATE does not fire the append-only row trigger. Development only (see the guard above).
    await client.query(
      "TRUNCATE organizations, users, audit_log, audit_segments, audit_checkpoints CASCADE"
    );

    const {
      rows: [org],
    } = await client.query(
      "INSERT INTO organizations (slug, name) VALUES ('acme', 'Acme Corp') RETURNING id"
    );
    const { rows: teams } = await client.query(
      `INSERT INTO teams (org_id, name) VALUES ($1, 'Finance'), ($1, 'Marketing') RETURNING id, name`,
      [org.id]
    );
    const teamId = Object.fromEntries(
      teams.map((team) => [team.name, team.id])
    );

    const userId = {};
    for (const user of USERS) {
      const {
        rows: [row],
      } = await client.query(
        "INSERT INTO users (org_id, email, name, password_hash) VALUES ($1, $2, $3, $4) RETURNING id",
        [org.id, user.email, user.name, await hashPassword(SEED_PASSWORD)]
      );
      userId[user.email] = row.id;
    }

    for (const [email, team, role] of MEMBERSHIPS) {
      await client.query(
        "INSERT INTO memberships (user_id, org_id, team_id, role) VALUES ($1, $2, $3, $4)",
        [userId[email], org.id, team && teamId[team], role]
      );
    }

    for (const team of teams) {
      const [first, ...others] = PROJECTS[team.name];
      await client.query("UPDATE projects SET name = $2 WHERE team_id = $1", [
        team.id,
        first,
      ]);
      for (const name of others)
        await client.query(
          "INSERT INTO projects (org_id, team_id, name) VALUES ($1, $2, $3)",
          [org.id, team.id, name]
        );
      // Tier 3 D: one example custom metric per team, shown on each dashboard.
      const {
        rows: [custom],
      } = await client.query(
        `INSERT INTO custom_metrics (org_id, team_id, name, formula, unit, created_by)
         VALUES ($1, $2, 'Revenue per click', 'revenue / clicks', 'currency', $3) RETURNING id`,
        [org.id, team.id, userId["super@acme.test"]]
      );
      const { rows: projects } = await client.query(
        "SELECT id, name FROM projects WHERE team_id = $1 ORDER BY created_at, name",
        [team.id]
      );
      for (const project of projects)
        await seedDashboard(
          client,
          org.id,
          team.id,
          project,
          custom.id,
          userId
        );
    }

    const { rowCount } = await client.query(SEED_METRICS_SQL, [org.id]);
    await client.query("COMMIT");

    console.log(
      `seeded 1 org, ${teams.length} teams, ${USERS.length} users, ${rowCount} metric points`
    );
    console.log(`all seed users share the password: ${SEED_PASSWORD}`);
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    await client.end();
  }
};

// One dashboard per project: the five base metrics, the ARPU KPI and the team's custom metric.
const seedDashboard = async (
  client,
  orgId,
  teamId,
  project,
  customId,
  userId
) => {
  const {
    rows: [{ id }],
  } = await client.query(
    `INSERT INTO dashboards (org_id, team_id, project_id, name, created_by)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [
      orgId,
      teamId,
      project.id,
      `${project.name} Overview`,
      userId["super@acme.test"],
    ]
  );
  await client.query(
    `INSERT INTO widgets (dashboard_id, org_id, team_id, type, metric, kpi, custom_metric_id,
                          title, x, y, w, h)
     VALUES ($1, $2, $3, 'line', 'revenue', NULL, NULL, 'Revenue', 0, 0, 6, 4),
            ($1, $2, $3, 'line', 'page_views', NULL, NULL, 'Page views', 6, 0, 6, 4),
            ($1, $2, $3, 'stat', 'clicks', NULL, NULL, 'Clicks', 0, 4, 3, 2),
            ($1, $2, $3, 'stat', 'errors', NULL, NULL, 'Errors', 3, 4, 3, 2),
            ($1, $2, $3, 'stat', 'users', NULL, NULL, 'Active users', 6, 4, 3, 2),
            ($1, $2, $3, 'stat', NULL, 'arpu', NULL, 'ARPU', 9, 4, 3, 2),
            ($1, $2, $3, 'stat', NULL, NULL, $4::uuid, 'Revenue per click', 0, 6, 3, 2)`,
    [id, orgId, teamId, customId]
  );
};

seed().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
