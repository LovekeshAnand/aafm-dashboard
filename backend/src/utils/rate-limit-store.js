import { pool } from "../db/pool.js";

// Problems-log #13: an express-rate-limit store shared by every API instance (migration 012).
// Fixed window per key: one upsert per request returns the hit count and the reset time.
class PostgresStore {
  localKeys = false; // keys are shared across instances

  /** `name` scopes the counters to one policy (e.g. "api:600"), so two limiters never share. */
  constructor(name) {
    this.prefix = `${name}:`;
  }

  init(options) {
    this.windowMs = options.windowMs;
  }

  async increment(key) {
    const {
      rows: [row],
    } = await pool.query(
      `INSERT INTO rate_limits (key, hits, reset_at)
       VALUES ($1, 1, now() + $2 * interval '1 millisecond')
       ON CONFLICT (key) DO UPDATE SET
         hits = CASE WHEN rate_limits.reset_at <= now() THEN 1 ELSE rate_limits.hits + 1 END,
         reset_at = CASE WHEN rate_limits.reset_at <= now() THEN excluded.reset_at
                         ELSE rate_limits.reset_at END
       RETURNING hits, reset_at`,
      [this.prefix + key, this.windowMs]
    );
    return { totalHits: row.hits, resetTime: row.reset_at };
  }

  async decrement(key) {
    await pool.query(
      "UPDATE rate_limits SET hits = greatest(hits - 1, 0) WHERE key = $1",
      [this.prefix + key]
    );
  }

  async resetKey(key) {
    await pool.query("DELETE FROM rate_limits WHERE key = $1", [
      this.prefix + key,
    ]);
  }
}

export { PostgresStore };
