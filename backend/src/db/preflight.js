// Problems-log #8 / #40: the tenant tables FORCE row-level security, and the SECURITY DEFINER
// functions (simulator, anomaly detection, audit, webhook worker, housekeeping) write across
// tenants as the owner. That only works if the owner is a superuser or has BYPASSRLS, which is
// true for self-hosted Postgres (the chosen EC2 + Docker deployment) but not on every managed
// host. Instead of failing later with confusing RLS errors at runtime, migrations and the API
// check this up front and stop with an actionable message.
const MESSAGE = (role) =>
  `Database role "${role}" owns the app's functions but is neither a superuser nor BYPASSRLS. ` +
  `Run as a superuser: ALTER ROLE "${role}" BYPASSRLS; (or migrate with a role that has it). ` +
  "See problems-log #8.";

/** Migrations: the connecting (owner) role itself must bypass RLS. */
const assertOwnerBypassesRls = async (client) => {
  const {
    rows: [role],
  } = await client.query(
    "SELECT rolname, rolsuper OR rolbypassrls AS ok FROM pg_roles WHERE rolname = current_user"
  );
  if (!role.ok) throw new Error(MESSAGE(role.rolname));
};

/** API startup: whoever owns the app's SECURITY DEFINER functions must bypass RLS. */
const assertFunctionOwnerBypassesRls = async (pool) => {
  const { rows } = await pool.query(
    `SELECT DISTINCT r.rolname, r.rolsuper OR r.rolbypassrls AS ok
     FROM pg_proc p
     JOIN pg_namespace n ON n.oid = p.pronamespace
     JOIN pg_roles r ON r.oid = p.proowner
     WHERE n.nspname = 'app' AND p.prosecdef`
  );
  const bad = rows.find((r) => !r.ok);
  if (bad) throw new Error(MESSAGE(bad.rolname));
  if (!rows.length)
    throw new Error("No app.* functions found: run `npm run migrate` first.");
};

export { assertFunctionOwnerBypassesRls, assertOwnerBypassesRls };
