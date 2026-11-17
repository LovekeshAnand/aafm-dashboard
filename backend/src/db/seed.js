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

// 7 days at 5-minute resolution: base x daily cycle x +/-15% noise, scaled per team.
const SEED_METRICS_SQL = `
  INSERT INTO metric_points (org_id, team_id, metric, ts, value)
  SELECT t.org_id, t.id, m.metric, ts,
         round((m.base * t.scale
                * (1 + 0.3 * sin(2 * pi() * extract(hour FROM ts) / 24))
                * (0.85 + random() * 0.3))::numeric, 2)
  FROM (SELECT id, org_id, CASE name WHEN 'Finance' THEN 1.0 ELSE 1.6 END AS scale
        FROM teams WHERE org_id = $1) t
  CROSS JOIN (VALUES ('revenue'::metric_name, 500.0), ('page_views', 1200.0),
                     ('clicks', 300.0), ('errors', 5.0)) m(metric, base)
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
    await client.query("TRUNCATE organizations, users CASCADE");

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
      const {
        rows: [dashboard],
      } = await client.query(
        `INSERT INTO dashboards (org_id, team_id, name, created_by)
         VALUES ($1, $2, $3, $4) RETURNING id`,
        [org.id, team.id, `${team.name} Overview`, userId["super@acme.test"]]
      );
      await client.query(
        `INSERT INTO widgets (dashboard_id, org_id, team_id, type, metric, title, x, y, w, h)
         VALUES ($1, $2, $3, 'line', 'revenue', 'Revenue', 0, 0, 6, 4),
                ($1, $2, $3, 'line', 'page_views', 'Page views', 6, 0, 6, 4),
                ($1, $2, $3, 'stat', 'clicks', 'Clicks', 0, 4, 3, 2),
                ($1, $2, $3, 'stat', 'errors', 'Errors', 3, 4, 3, 2)`,
        [dashboard.id, org.id, team.id]
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

seed().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
