import { app } from "./app.js";
import { pool } from "./db/pool.js";

if (!process.env.DATABASE_URL)
  throw new Error("DATABASE_URL is not set (see .env.sample)");

const port = Number(process.env.PORT) || 8000;
const server = app.listen(port, () => console.log(`API listening on :${port}`));

// Finish in-flight requests, then release DB connections.
const shutdown = () =>
  server.close(() => pool.end().finally(() => process.exit(0)));
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
