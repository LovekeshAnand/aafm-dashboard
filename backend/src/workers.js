import { startMaintenance } from "./maintenance.js";
import { startSimulator } from "./simulator.js";
import { startWebhookWorker } from "./webhooks.js";

// The background jobs: live-metric simulator + anomaly detection, webhook delivery, and
// housekeeping. Each is safe to run on several processes at once (database claims and locks),
// so they can run inside the API (default, one EC2 box) or in their own process
// (`npm run worker`, with RUN_WORKERS=false on the API) when deliveries or ticks should not
// share CPU with requests (problems-log #39).
const startWorkers = () => {
  const stopSimulator = startSimulator();
  const stopMaintenance = startMaintenance();
  const stopWebhooks = startWebhookWorker();
  /** Stops taking work and lets in-flight webhook sends finish (up to 10 s). */
  return async () => {
    stopSimulator();
    stopMaintenance();
    await stopWebhooks();
  };
};

export { startWorkers };
