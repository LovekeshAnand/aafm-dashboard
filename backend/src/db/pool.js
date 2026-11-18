import pg from "pg";

// Connects as aafm_app, which has no BYPASSRLS, so every query is bound by RLS.
// E8: node-postgres waits for a free connection forever by default; after 5 s the request
// gets a 503 "busy, retry" instead (error middleware). Query and transaction time limits are
// set on the role itself (migration 011), so they hold for every connection.
const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  max: Number(process.env.DB_POOL_MAX) || 10,
  connectionTimeoutMillis: Number(process.env.DB_CONNECT_TIMEOUT_MS) || 5000,
});
// E7: an idle connection dropped by the server (restart, network) emits "error" on the pool.
// Without a listener that is an uncaught error that can crash the process; pg already
// discards the broken client, so logging is all that's needed.
pool.on("error", (err) =>
  console.error("idle database connection lost:", err.message)
);

/**
 * Runs `work(client)` in one transaction with the tenant context set transaction-locally
 * (set_config(..., true)), so it is cleared at COMMIT/ROLLBACK and can never leak to the
 * next request that reuses this pooled connection.
 *
 * @param {{ userId: string, orgId: string, teamId?: string | null }} context
 * @param {(client: pg.PoolClient) => Promise<T>} work
 * @returns {Promise<T>}
 * @template T
 */
const withContext = async ({ userId, orgId, teamId = null }, work) => {
  const client = await pool.connect();
  let brokenConnection;
  try {
    await client.query("BEGIN");
    await client.query(
      `SELECT set_config('app.user_id', $1, true),
              set_config('app.org_id', $2, true),
              set_config('app.team_id', $3, true)`,
      [userId ?? "", orgId ?? "", teamId ?? ""]
    );
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch((rollbackErr) => {
      brokenConnection = rollbackErr; // discard the connection instead of returning it to the pool
    });
    throw err;
  } finally {
    client.release(brokenConnection);
  }
};

export { pool, withContext };
