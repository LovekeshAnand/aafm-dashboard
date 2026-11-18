// Background jobs in their own process (problems-log #39): `npm run worker`, with
// RUN_WORKERS=false on the API instances. No HTTP port; live events reach browsers through the
// Socket.IO Postgres adapter, exactly as when the jobs run inside the API.
import { pool } from "./db/pool.js";
import { assertFunctionOwnerBypassesRls } from "./db/preflight.js";
import { initEmitter } from "./realtime.js";
import { keyring } from "./utils/secret-box.js";
import { startWorkers } from "./workers.js";

if (!process.env.DATABASE_URL)
  throw new Error("DATABASE_URL is not set (see .env.sample)");
keyring();
await assertFunctionOwnerBypassesRls(pool);

const io = initEmitter();
const stopWorkers = startWorkers();
// The job timers are unref'd (they never keep the API alive on their own); this keeps the
// worker process running until it's told to stop.
const keepAlive = setInterval(() => {}, 1 << 30);
console.log("worker running: simulator, webhooks, housekeeping");

let stopping = false;
const shutdown = async (signal) => {
  if (stopping) return;
  stopping = true;
  console.log(`${signal}: stopping worker`);
  setTimeout(() => process.exit(1), 15_000).unref();
  clearInterval(keepAlive);
  await stopWorkers();
  io.close(() => pool.end().finally(() => process.exit(0)));
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
