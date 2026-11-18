import { app } from "./app.js";
import { pool } from "./db/pool.js";
import { assertFunctionOwnerBypassesRls } from "./db/preflight.js";
import { initRealtime } from "./realtime.js";
import { keyring } from "./utils/secret-box.js";
import { startWorkers } from "./workers.js";

if (!process.env.DATABASE_URL)
  throw new Error("DATABASE_URL is not set (see .env.sample)");
// Fail at startup, not at the first webhook or tick, if something essential is missing:
// the secret keyring, or a database owner that can run the cross-tenant jobs (#8 / #40).
keyring();
await assertFunctionOwnerBypassesRls(pool);

const port = Number(process.env.PORT) || 8000;
const server = app.listen(port, () => console.log(`API listening on :${port}`));
// E11: no request may hold a connection for minutes (Node's default is 5 min). Socket.IO's
// long-polling requests are released every 25 s (pingInterval), inside this limit.
server.requestTimeout = 30_000;
server.headersTimeout = 15_000;

const io = initRealtime(server);
// RUN_WORKERS=false when the background jobs run in their own process (npm run worker).
const stopWorkers =
  process.env.RUN_WORKERS === "false" ? async () => {} : startWorkers();

// E16: stop taking work, let in-flight webhook sends finish (up to 10 s), close sockets and
// the HTTP server (which waits for in-flight requests), then release DB connections. A hung
// step can't keep the process alive: it exits after 15 s regardless.
let stopping = false;
const shutdown = async (signal) => {
  if (stopping) return;
  stopping = true;
  console.log(`${signal}: shutting down`);
  setTimeout(() => {
    console.error("shutdown took longer than 15 s; exiting");
    process.exit(1);
  }, 15_000).unref();
  await stopWorkers();
  io.close(() => pool.end().finally(() => process.exit(0)));
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
