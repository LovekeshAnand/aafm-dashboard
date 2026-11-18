import { SESSION } from "./constants.js";
import { pool } from "./db/pool.js";
import { writeCheckpoints } from "./utils/audit-checkpoints.js";
import { logOnce } from "./utils/log-once.js";

// Housekeeping (docs/edge-case-audit.md E14, E17, E19, E20), every few minutes on whichever
// instance gets the database lock first (app.housekeeping, migration 011):
//   expired sessions, webhook deliveries older than 30 days, idempotency keys older than 24 h,
//   metric points older than 30 days, and packing audit entries older than AUDIT_HOT_DAYS into
//   compressed segments (every entry is kept; see docs/tier-3-plan.md), then signed audit
//   checkpoints (problems-log #39).
const EVERY_MS = Number(process.env.HOUSEKEEPING_MINUTES ?? 5) * 60_000;
const AUDIT_HOT_DAYS = Number(process.env.AUDIT_HOT_DAYS ?? 7);

const runHousekeeping = async (auditHot = `${AUDIT_HOT_DAYS} days`) => {
  const {
    rows: [{ result }],
  } = await pool.query("SELECT app.housekeeping($1, $2) AS result", [
    SESSION.IDLE,
    auditHot,
  ]);
  // #39: then sign each org's newest audit entry (key outside the database).
  if (result) result.audit_checkpoints = await writeCheckpoints(pool);
  return result; // null when another instance holds the lock
};

/** Starts the loop (HOUSEKEEPING_MINUTES=0 disables it). Returns a stop function. */
const startMaintenance = () => {
  if (!EVERY_MS) return () => {};
  let running = false;
  const timer = setInterval(async () => {
    if (running) return;
    running = true;
    try {
      await runHousekeeping();
      logOnce("housekeeping");
    } catch (err) {
      logOnce("housekeeping", err);
    } finally {
      running = false;
    }
  }, EVERY_MS);
  timer.unref();
  return () => clearInterval(timer);
};

export { runHousekeeping, startMaintenance };
