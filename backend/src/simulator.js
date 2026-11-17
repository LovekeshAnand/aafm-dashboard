import { pool } from "./db/pool.js";
import { publishTeamEvent } from "./realtime.js";

// Tier 2 B: live metrics. Every tick, app.simulate_tick() appends one point per team per
// metric (database-side, so the app role still cannot write metrics directly) and each
// team's new points are pushed to that team's channel only.
// Tier 2 D: every DETECT_EVERY ticks (30 s at 5 s), app.detect_anomalies() evaluates the
// fixed 2-sigma rule and each opened/resolved alert is pushed to its team's channel.
const TICK_SECONDS = Number(process.env.SIMULATOR_INTERVAL_SECONDS ?? 5);
const DETECT_EVERY = Math.max(1, Math.round(30 / (TICK_SECONDS || 30)));

/** One tick: returns the inserted points (empty if another instance claimed this interval). */
const runTick = async (seconds = TICK_SECONDS) => {
  const { rows } = await pool.query("SELECT * FROM app.simulate_tick($1)", [
    seconds,
  ]);
  const byTeam = new Map();
  for (const { org_id, team_id, metric, ts, value } of rows) {
    if (!byTeam.has(team_id)) byTeam.set(team_id, { org_id, points: [] });
    byTeam.get(team_id).points.push({ metric, ts, value });
  }
  for (const [teamId, { org_id, points }] of byTeam) {
    publishTeamEvent(org_id, teamId, "metrics:tick", { points });
  }
  return rows;
};

/** One detection pass: returns the alerts it opened or resolved. */
const runDetection = async (seconds = TICK_SECONDS) => {
  const { rows } = await pool.query("SELECT * FROM app.detect_anomalies($1)", [
    seconds,
  ]);
  for (const { action, org_id, team_id, ...alert } of rows) {
    publishTeamEvent(org_id, team_id, "alerts:changed", {
      action,
      alert: { ...alert, team_id },
    });
  }
  return rows;
};

/** Starts the interval (SIMULATOR_INTERVAL_SECONDS=0 disables it). Returns a stop function. */
const startSimulator = () => {
  if (!TICK_SECONDS) return () => {};
  let ticks = 0;
  const timer = setInterval(async () => {
    try {
      const rows = await runTick();
      // Only the instance that wrote this tick evaluates it, so alerts aren't doubled.
      if (rows.length && ++ticks % DETECT_EVERY === 0) await runDetection();
    } catch (err) {
      console.error("simulator tick failed:", err.message);
    }
  }, TICK_SECONDS * 1000);
  timer.unref();
  return () => clearInterval(timer);
};

export { runDetection, runTick, startSimulator };
