import { readdir, readFile } from "node:fs/promises";
import pg from "pg";
import { assertOwnerBypassesRls } from "./preflight.js";

const MIGRATIONS_DIR = new URL("./migrations/", import.meta.url);
const APP_ROLE = "aafm_app";

// The request role must exist before migrations GRANT to it. It never gets BYPASSRLS.
const ensureAppRole = async (client) => {
  const password = process.env.APP_DB_PASSWORD;
  if (!password) throw new Error("APP_DB_PASSWORD is not set");

  const { rowCount } = await client.query(
    "SELECT 1 FROM pg_roles WHERE rolname = $1",
    [APP_ROLE]
  );
  const verb = rowCount ? "ALTER" : "CREATE";
  await client.query(
    `${verb} ROLE ${APP_ROLE} WITH LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD ${client.escapeLiteral(password)}`
  );
};

const migrate = async () => {
  const client = new pg.Client({
    connectionString: process.env.MIGRATION_DATABASE_URL,
  });
  await client.connect();
  try {
    await assertOwnerBypassesRls(client);
    await ensureAppRole(client);
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      name       text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`);

    const { rows } = await client.query("SELECT name FROM schema_migrations");
    const applied = new Set(rows.map((row) => row.name));
    const files = (await readdir(MIGRATIONS_DIR))
      .filter((file) => file.endsWith(".sql"))
      .sort();

    for (const file of files) {
      if (applied.has(file)) continue;
      const sql = await readFile(new URL(file, MIGRATIONS_DIR), "utf8");
      try {
        await client.query("BEGIN");
        await client.query(sql);
        await client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [
          file,
        ]);
        await client.query("COMMIT");
        console.log(`applied ${file}`);
      } catch (err) {
        await client.query("ROLLBACK");
        throw new Error(`migration ${file} failed: ${err.message}`, {
          cause: err,
        });
      }
    }
  } finally {
    await client.end();
  }
};

migrate().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
