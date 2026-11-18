import { defineCloudflareConfig } from "@opennextjs/cloudflare";

// No incremental cache (R2) needed: every signed-in page is rendered in the browser behind the
// session check, and the app uses no ISR or cached server fetches.
export default defineCloudflareConfig({});
