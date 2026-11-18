import { createHmac, randomBytes } from "node:crypto";
import { lookup } from "node:dns";
import http from "node:http";
import https from "node:https";
import { BlockList, isIP } from "node:net";
import { pool } from "./db/pool.js";
import { publishTeamEvent } from "./realtime.js";
import { chatBody, messageText } from "./utils/chat-message.js";
import { logOnce } from "./utils/log-once.js";
import { open } from "./utils/secret-box.js";

// Tier 3 C: webhook delivery worker.
//  * Standard Webhooks signing: webhook-signature = "v1," + base64(HMAC-SHA256(key,
//    "<webhook-id>.<webhook-timestamp>.<body>")), key = base64-decoded whsec_ secret. During a
//    rotation both secrets sign, space-separated, as the spec allows.
//  * OWASP SSRF Prevention: http(s) only; every resolved address is checked against private,
//    loopback, link-local, CGNAT, multicast and metadata ranges, and the connection goes to the
//    checked address (custom `lookup`), so DNS rebinding can't swap it afterwards. Redirects are
//    never followed (Node's http doesn't, and 3xx counts as a failure). WEBHOOK_ALLOW_PRIVATE=1
//    lifts the address check for local development and tests only.
//  * Claiming uses FOR UPDATE SKIP LOCKED in the database, so several API instances can run it.
const POLL_SECONDS = Number(process.env.WEBHOOK_POLL_SECONDS ?? 2);
const TIMEOUT_MS = Number(process.env.WEBHOOK_TIMEOUT_MS) || 10_000;
const BATCH = 10;
const allowPrivate = () => process.env.WEBHOOK_ALLOW_PRIVATE === "1";

const newSecret = () => `whsec_${randomBytes(32).toString("base64")}`;

const signature = (secret, id, timestamp, body) =>
  `v1,${createHmac(
    "sha256",
    Buffer.from(secret.slice("whsec_".length), "base64")
  )
    .update(`${id}.${timestamp}.${body}`)
    .digest("base64")}`;

const blocked = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10], // carrier-grade NAT
  ["127.0.0.0", 8],
  ["169.254.0.0", 16], // link-local, incl. cloud metadata 169.254.169.254
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved, broadcast
])
  blocked.addSubnet(network, prefix, "ipv4");
for (const [network, prefix] of [
  ["::", 128],
  ["::1", 128],
  // IPv4-mapped addresses (::ffff:a.b.c.d) need no rule: BlockList normalizes them and checks
  // them against the IPv4 rules above (OWASP: normalize before comparing).
  ["64:ff9b::", 96], // NAT64
  ["fc00::", 7], // unique local
  ["fe80::", 10], // link-local
  ["ff00::", 8], // multicast
])
  blocked.addSubnet(network, prefix, "ipv6");

const isBlocked = (address) =>
  blocked.check(address, isIP(address) === 6 ? "ipv6" : "ipv4");

/** Rejects anything but a plain http(s) URL; returns the parsed URL. */
const checkUrl = (value) => {
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol))
    throw new Error("Only http and https URLs are allowed");
  if (url.username || url.password)
    throw new Error("Credentials in the URL are not allowed");
  // E18: in production only web ports, so the worker can't be used to probe other services
  // (Redis on 6379, SSH on 22, ...) on public hosts. Development allows any local port.
  if (
    process.env.NODE_ENV === "production" &&
    url.port &&
    !["80", "443", "8080", "8443"].includes(url.port)
  )
    throw new Error(
      `Port ${url.port} is not allowed (use 80, 443, 8080 or 8443)`
    );
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (isIP(host) && isBlocked(host) && !allowPrivate())
    throw new Error(`Address ${host} is not allowed`);
  return url;
};

// dns.lookup wrapper used by the socket itself: the address that is checked is the address
// that is connected to.
const safeLookup = (hostname, options, callback) =>
  lookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return callback(err);
    const bad = addresses.find((a) => isBlocked(a.address));
    if (bad && !allowPrivate())
      return callback(new Error(`Address ${bad.address} is not allowed`));
    return options.all
      ? callback(null, addresses)
      : callback(null, addresses[0].address, addresses[0].family);
  });

/** One HTTP attempt. Resolves to { ok, code, error, gone }. */
const send = (delivery) =>
  new Promise((resolve) => {
    let url;
    try {
      url = checkUrl(delivery.url);
    } catch (err) {
      return resolve({ ok: false, code: null, error: err.message });
    }
    const timestamp = Math.floor(Date.now() / 1000);
    const signatures = [delivery.secret, delivery.previous_secret]
      .filter(Boolean)
      .map((s) => signature(s, delivery.event_id, timestamp, delivery.body))
      .join(" ");
    // E15: one deadline for the whole attempt (DNS, connect, request, response headers).
    // Node's `timeout` option alone is an idle timeout, which an endpoint that trickles bytes
    // could stretch indefinitely.
    const req = (url.protocol === "https:" ? https : http).request(
      url,
      {
        method: "POST",
        lookup: safeLookup,
        signal: AbortSignal.timeout(TIMEOUT_MS),
        headers: {
          "content-type": "application/json",
          "user-agent": "aafm-webhooks/1.0",
          "webhook-id": delivery.event_id,
          "webhook-timestamp": String(timestamp),
          "webhook-signature": signatures,
        },
      },
      (res) => {
        // Only the status matters: close the connection instead of reading the body, so a
        // large or endless response can't hold a delivery slot.
        res.destroy();
        const code = res.statusCode;
        resolve({
          ok: code >= 200 && code < 300,
          code,
          gone: code === 410,
          error: code >= 200 && code < 300 ? null : `HTTP ${code}`,
        });
      }
    );
    req.on("error", (err) =>
      resolve({
        ok: false,
        code: null,
        error:
          err.name === "AbortError" || err.name === "TimeoutError"
            ? `No response within ${TIMEOUT_MS / 1000} s`
            : err.message,
      })
    );
    req.end(delivery.body);
  });

// Secrets are stored sealed (Prompt 50); a secret that can't be opened (missing key, edited
// ciphertext, ciphertext copied from another webhook) is a failed attempt with a clear reason,
// never a message signed with the wrong key.
const decryptAndSend = (delivery) => {
  let secret, previous;
  try {
    secret = open(delivery.secret, delivery.webhook_id);
    previous =
      delivery.previous_secret &&
      open(delivery.previous_secret, delivery.webhook_id);
  } catch (err) {
    return {
      ok: false,
      code: null,
      error: `Signing secret unavailable: ${err.message}`,
    };
  }
  return send({
    ...delivery,
    body: bodyFor(delivery),
    secret,
    previous_secret: previous,
  });
};

// F5: chat apps (Slack, Discord, Teams) get one readable sentence in their own format, with
// a link back to the app; developer endpoints get the signed Standard Webhooks JSON as stored.
const appUrl = () =>
  (
    process.env.PUBLIC_APP_URL ??
    process.env.CORS_ORIGIN?.split(",")[0] ??
    ""
  ).replace(/\/$/, "");
const bodyFor = (delivery) => {
  if (!delivery.format || delivery.format === "standard") return delivery.body;
  const { type, data } = JSON.parse(delivery.body);
  const link = appUrl() ? `${appUrl()}/dashboards` : null;
  return chatBody(delivery.format, messageText(type, data), link);
};

/** Sends one claimed delivery and records the outcome. */
const deliverOne = async (delivery) => {
  const result = await decryptAndSend(delivery);
  const {
    rows: [outcome],
  } = await pool.query(
    "SELECT * FROM app.finish_webhook_delivery($1, $2, $3, $4, $5)",
    [delivery.id, result.ok, result.code, result.error, !!result.gone]
  );
  // Admins watching the Webhooks page see the attempt land (and failures as they happen).
  if (outcome)
    publishTeamEvent(outcome.org_id, outcome.team_id, "webhooks:changed", {
      webhook_id: outcome.webhook_id,
      status: outcome.status,
      disabled: outcome.disabled,
    });
  return { id: delivery.id, ...result };
};

const claim = async (limit) =>
  (await pool.query("SELECT * FROM app.claim_webhook_deliveries($1)", [limit]))
    .rows;

/** Claims and sends one batch, waiting for all of it (used by tests). */
const deliverDue = async (limit = BATCH) =>
  Promise.all((await claim(limit)).map(deliverOne));

/**
 * Polls every WEBHOOK_POLL_SECONDS (0 disables). E15: up to BATCH sends are in flight at once
 * and free slots are refilled on every poll, so one slow endpoint holds one slot, not the
 * whole queue. Returns an async stop function that lets in-flight sends finish (E16).
 */
const startWebhookWorker = () => {
  if (!POLL_SECONDS) return async () => {};
  const inFlight = new Set();
  let polling = false;
  const timer = setInterval(async () => {
    const free = BATCH - inFlight.size;
    if (polling || free <= 0) return;
    polling = true;
    try {
      for (const delivery of await claim(free)) {
        const sending = deliverOne(delivery)
          .then(() => logOnce("webhook delivery"))
          .catch((err) => logOnce("webhook delivery", err))
          .finally(() => inFlight.delete(sending));
        inFlight.add(sending);
      }
      logOnce("webhook claim");
    } catch (err) {
      logOnce("webhook claim", err); // E24
    } finally {
      polling = false;
    }
  }, POLL_SECONDS * 1000);
  timer.unref();
  // A send cut off here is re-sent after its claim expires (at-least-once, same webhook-id).
  return async (graceMs = TIMEOUT_MS) => {
    clearInterval(timer);
    await Promise.race([
      Promise.allSettled([...inFlight]),
      new Promise((resolve) => setTimeout(resolve, graceMs).unref()),
    ]);
  };
};

export {
  checkUrl,
  deliverDue,
  isBlocked,
  newSecret,
  send,
  signature,
  startWebhookWorker,
};
