// Development helper (Tier 3 C): a local webhook endpoint that prints each delivery and checks
// its Standard Webhooks signature. Usage:
//   WEBHOOK_SECRET=whsec_... node scripts/webhook-receiver.js [port]
// then register http://127.0.0.1:<port>/hook (backend/.env needs WEBHOOK_ALLOW_PRIVATE=1).
// Paths /gone and /fail answer 410 and 500, to try the endpoint-disable and retry paths.
import { createHmac, timingSafeEqual } from "node:crypto";
import http from "node:http";

const port = Number(process.argv[2]) || 9999;
const secret = process.env.WEBHOOK_SECRET;

const verify = (headers, body) => {
  if (!secret) return "not checked (set WEBHOOK_SECRET)";
  const expected = Buffer.from(
    createHmac("sha256", Buffer.from(secret.slice("whsec_".length), "base64"))
      .update(
        `${headers["webhook-id"]}.${headers["webhook-timestamp"]}.${body}`
      )
      .digest("base64")
  );
  const ok = (headers["webhook-signature"] ?? "")
    .split(" ")
    .map((sig) => Buffer.from(sig.slice("v1,".length)))
    .some(
      (sig) => sig.length === expected.length && timingSafeEqual(sig, expected)
    );
  const age = Math.abs(
    Date.now() / 1000 - Number(headers["webhook-timestamp"])
  );
  return ok && age < 300
    ? "VALID"
    : `INVALID${ok ? " (timestamp too old)" : ""}`;
};

http
  .createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      const status =
        req.url === "/gone" ? 410 : req.url === "/fail" ? 500 : 200;
      console.log(
        `\n${new Date().toISOString()} ${req.method} ${req.url} -> ${status}`,
        `\n  webhook-id: ${req.headers["webhook-id"]}`,
        `\n  signature:  ${verify(req.headers, body)}`,
        `\n  body:       ${body}`
      );
      res.writeHead(status).end();
    });
  })
  .listen(port, "127.0.0.1", () =>
    console.log(`webhook receiver on http://127.0.0.1:${port}/hook`)
  );
